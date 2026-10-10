import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { z } from 'zod'
import { articles, findArticle } from '../../src/data/articles.ts'
import { ARTICLE_PRICE_UNITS, BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from '../../src/lib/payment-config.ts'
import { isPaymentPayload, requestWalletApproval } from './approval-bridge.ts'

const DEFAULT_DEMO_URL = 'http://localhost:3000'
const QUOTE_TTL_MS = 2 * 60 * 1000
const MAX_PRICE_UNITS = BigInt(ARTICLE_PRICE_UNITS)
const USDC_DECIMALS = 6
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

if (existsSync(resolve(process.cwd(), '.env'))) {
  process.loadEnvFile(resolve(process.cwd(), '.env'))
}

type Quote = {
  quoteId: string
  slug: string
  requirements: PaymentRequirements
  expiresAt: number
}

const quotes = new Map<string, Quote>()
const x402HttpClient = new x402HTTPClient(new x402Client())

function getDemoUrl() {
  const url = new URL(process.env.X402_DEMO_URL || DEFAULT_DEMO_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('X402_DEMO_URL must be an HTTP(S) URL without credentials')
  }
  return url
}

function getConfiguredPayTo() {
  const payTo = process.env.X402_PAY_TO?.trim()
  if (!payTo || !ADDRESS_PATTERN.test(payTo)) {
    throw new Error('Set a valid fixed X402_PAY_TO address in .env before using agent payments')
  }
  return payTo
}

function formatUsdc(amount: string) {
  const value = BigInt(amount)
  const whole = value / 10n ** BigInt(USDC_DECIMALS)
  const fraction = (value % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function findAllowedRequirement(required: PaymentRequired, expectedPayTo: string) {
  const accepted = required.accepts.find((requirement) =>
    requirement.scheme === 'exact' &&
    requirement.network === BASE_SEPOLIA_NETWORK &&
    requirement.asset.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase() &&
    requirement.amount === ARTICLE_PRICE_UNITS &&
    BigInt(requirement.amount) <= MAX_PRICE_UNITS &&
    requirement.payTo.toLowerCase() === expectedPayTo.toLowerCase(),
  )

  if (!accepted) {
    throw new Error('The article server returned payment terms outside the configured Base Sepolia USDC demo policy')
  }
  return accepted
}

async function fetchPaymentRequired(slug: string) {
  const demoUrl = getDemoUrl()
  const articleUrl = new URL(`/api/article/${encodeURIComponent(slug)}`, demoUrl)
  const response = await fetch(articleUrl, { headers: { Accept: 'application/json' } })
  if (response.status !== 402) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Expected x402 HTTP 402 challenge; received ${response.status}`)
  }
  const body = await response.clone().json().catch(() => ({}))
  const required = x402HttpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body)
  return { required, articleUrl }
}

function getQuote(quoteId: string, slug: string) {
  const quote = quotes.get(quoteId)
  if (!quote || quote.slug !== slug || quote.expiresAt <= Date.now()) {
    quotes.delete(quoteId)
    throw new Error('Quote not found or expired. Get a new quote before purchasing.')
  }
  return quote
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError }
}

const server = new McpServer({ name: 'signaljournal', version: '1.0.0' })

server.registerTool(
  'search_articles',
  {
    title: 'Search Signal Journal articles',
    description: 'Search free article titles and summaries. This tool never returns paid article bodies and never makes a payment.',
    inputSchema: { query: z.string().trim().min(1).max(120) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query }) => {
    const terms = query.toLocaleLowerCase('ja')
      .split(/[\s、。,.!?！？「」『』はをがにでとからのへや]/u)
      .filter((term) => term.length >= 2 && !['記事', '探して', '価格', '確認', '購入', '要約', 'する', 'して'].includes(term))
    const matches = articles
      .map((article) => {
        const searchable = `${article.title}\n${article.lead}\n${article.category}`.toLocaleLowerCase('ja')
        return { article, score: terms.filter((term) => searchable.includes(term)).length }
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ article }) => article)
    return toolResult(matches.map(({ slug, title, lead, author, date }) => ({
      slug,
      title,
      lead,
      author,
      date,
      indicativePrice: `${formatUsdc(ARTICLE_PRICE_UNITS)} USDC`,
      network: BASE_SEPOLIA_NETWORK,
    })))
  },
)

server.registerTool(
  'get_article_quote',
  {
    title: 'Get article payment quote',
    description: 'Fetch an x402 payment quote for a Signal Journal article without signing or making a payment.',
    inputSchema: { slug: z.string().min(1).max(100) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ slug }) => {
    try {
      const article = findArticle(slug)
      if (!article) throw new Error('Article not found')
      const payTo = getConfiguredPayTo()
      const { required } = await fetchPaymentRequired(slug)
      const requirements = findAllowedRequirement(required, payTo)
      const quoteId = crypto.randomUUID()
      const expiresAt = Date.now() + QUOTE_TTL_MS
      quotes.set(quoteId, { quoteId, slug, requirements, expiresAt })

      for (const [id, quote] of quotes) {
        if (quote.expiresAt <= Date.now()) quotes.delete(id)
      }

      return toolResult({
        quoteId,
        slug,
        title: article.title,
        amount: `${formatUsdc(requirements.amount)} USDC`,
        asset: requirements.asset,
        network: requirements.network,
        payTo: requirements.payTo,
        expiresAt: new Date(expiresAt).toISOString(),
        nextStep: 'Show the terms to the user. Call purchase_article only after the user explicitly asks to proceed.',
      })
    } catch (error) {
      return toolResult({ error: error instanceof Error ? error.message : 'Could not get payment quote' }, true)
    }
  },
)

server.registerTool(
  'purchase_article',
  {
    title: 'Purchase and read paid article',
    description: 'After showing the quote and receiving the user’s request to proceed, open a local wallet approval page, collect an EIP-712 payment signature, and retrieve the article. OpenCode must ask the user before this tool executes.',
    inputSchema: {
      quoteId: z.string().uuid(),
      slug: z.string().min(1).max(100),
      confirmedAmount: z.string().min(1).max(40),
      confirmedNetwork: z.string().min(1).max(40),
      confirmedPayTo: z.string().regex(ADDRESS_PATTERN),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ quoteId, slug, confirmedAmount, confirmedNetwork, confirmedPayTo }) => {
    try {
      const quote = getQuote(quoteId, slug)
      const article = findArticle(slug)
      if (!article) throw new Error('Article not found')

      const expectedAmount = `${formatUsdc(quote.requirements.amount)} USDC`
      if (
        confirmedAmount !== expectedAmount ||
        confirmedNetwork !== quote.requirements.network ||
        confirmedPayTo.toLowerCase() !== quote.requirements.payTo.toLowerCase()
      ) {
        throw new Error('Confirmed payment terms do not match the quote. Get and review a fresh quote.')
      }

      const demoUrl = getDemoUrl()
      const uiUrl = new URL('/agent/approve', demoUrl)
      uiUrl.searchParams.set('slug', slug)
      uiUrl.searchParams.set('title', article.title)
      uiUrl.searchParams.set('amount', quote.requirements.amount)
      uiUrl.searchParams.set('asset', quote.requirements.asset)
      uiUrl.searchParams.set('network', quote.requirements.network)
      uiUrl.searchParams.set('payTo', quote.requirements.payTo)

      const approval = await requestWalletApproval({
        approvalPageUrl: uiUrl.toString(),
        uiOrigin: demoUrl.origin,
        quoteId,
      })
      quotes.delete(quoteId)

      if (approval.status !== 'approved') {
        throw new Error('Wallet payment signature was rejected. No payment was sent.')
      }
      if (quote.expiresAt <= Date.now()) {
        throw new Error('Quote expired while waiting for wallet approval. Get a fresh quote; the signed payload was not sent.')
      }

      let paymentPayload: PaymentPayload
      try {
        paymentPayload = decodePaymentSignatureHeader(approval.paymentHeader)
      } catch {
        throw new Error('The wallet approval page returned an invalid x402 payment payload')
      }
      if (!isPaymentPayload(paymentPayload)) throw new Error('Invalid x402 payment payload')
      assertPayloadMatchesQuote(paymentPayload, quote)

      const demoArticleUrl = new URL(`/api/article/${encodeURIComponent(slug)}`, demoUrl)
      const response = await fetch(demoArticleUrl, {
        headers: {
          Accept: 'application/json',
          'PAYMENT-SIGNATURE': approval.paymentHeader,
        },
      })
      const body = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) {
        const errorMessage = typeof body.error === 'string' ? body.error : `Paid article request failed with HTTP ${response.status}`
        throw new Error(errorMessage)
      }

      const settlement = x402HttpClient.getPaymentSettleResponse((name) => response.headers.get(name))
      const transaction = typeof body.transaction === 'string' ? body.transaction : settlement.transaction
      if (
        !settlement.success ||
        settlement.network !== quote.requirements.network ||
        (settlement.amount !== undefined && settlement.amount !== quote.requirements.amount) ||
        !transaction || transaction !== settlement.transaction ||
        body.slug !== slug ||
        (typeof body.network === 'string' && body.network !== quote.requirements.network) ||
        (typeof body.amount === 'string' && body.amount !== quote.requirements.amount) ||
        !Array.isArray(body.body) ||
        !body.body.every((paragraph) => typeof paragraph === 'string')
      ) {
        throw new Error('Payment response did not contain a settled transaction and article body')
      }

      return toolResult({
        slug,
        title: article.title,
        body: body.body,
        amount: `${formatUsdc(quote.requirements.amount)} USDC`,
        network: quote.requirements.network,
        payer: body.payer ?? settlement.payer,
        transaction,
        explorerUrl: `https://sepolia.basescan.org/tx/${transaction}`,
      })
    } catch (error) {
      return toolResult({ error: error instanceof Error ? error.message : 'Article purchase failed' }, true)
    }
  },
)

function assertPayloadMatchesQuote(payload: PaymentPayload, quote: Quote) {
  const accepted = payload.accepted
  const expected = quote.requirements
  if (
    accepted.scheme !== expected.scheme ||
    accepted.network !== expected.network ||
    accepted.amount !== expected.amount ||
    accepted.asset.toLowerCase() !== expected.asset.toLowerCase() ||
    accepted.payTo.toLowerCase() !== expected.payTo.toLowerCase()
  ) {
    throw new Error('Wallet signature does not match the approved quote')
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Signal Journal x402 MCP server connected over stdio')
