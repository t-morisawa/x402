import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { z } from 'zod'
import { ARTICLE_PRICE_UNITS, BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from '../../src/lib/payment-config.ts'
import { isPaymentPayload, requestWalletApproval } from './approval-bridge.ts'

const DEFAULT_DEMO_URL = 'http://localhost:3000'
const QUOTE_TTL_MS = 2 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_PRICE_UNITS = 100_000n // 0.10 USDC (6 decimals)
const USDC_DECIMALS = 6
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

if (existsSync(resolve(process.cwd(), '.env'))) {
  process.loadEnvFile(resolve(process.cwd(), '.env'))
}

type Quote = {
  quoteId: string
  url: string
  requirement: PaymentRequirements
  description: string
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

function getAllowedOrigins() {
  const configuredOrigins = process.env.X402_ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const origins = configuredOrigins?.length ? configuredOrigins : [getDemoUrl().origin]

  return new Set(origins.map((origin) => {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`Invalid X402_ALLOWED_ORIGINS entry: ${origin}`)
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`X402_ALLOWED_ORIGINS entries must be origins, not URLs with paths: ${origin}`)
    }
    return parsed.origin
  }))
}

function validateResourceUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL must use HTTP(S) and must not contain credentials')
  }
  url.hash = ''
  if (!getAllowedOrigins().has(url.origin)) {
    throw new Error(`Resource origin is not allowed: ${url.origin}`)
  }
  return url
}

function formatUsdc(amount: string) {
  const value = BigInt(amount)
  const unit = 10n ** BigInt(USDC_DECIMALS)
  const fraction = (value % unit).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${value / unit}.${fraction}` : (value / unit).toString()
}

async function readLimitedBody(response: Response) {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`HTTP response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parseJsonBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseResourceBody(text: string, contentType: string): unknown {
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Resource declared JSON but returned invalid JSON')
    }
  }
  if (contentType.startsWith('text/plain')) return text
  throw new Error(`Unsupported resource content type: ${contentType || '(missing)'}`)
}

async function requestResource(url: string) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain' },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new Error('Redirects are not allowed for x402 resources')
  }
  const text = await readLimitedBody(response)
  return { response, text, json: parseJsonBody(text) }
}

function parsePaymentRequired(response: Response, body: unknown): PaymentRequired {
  return x402HttpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body)
}

function selectAllowedRequirement(required: PaymentRequired) {
  const candidates = required.accepts
    .filter((requirement) => {
      if (
        requirement.scheme !== 'exact' ||
        requirement.network !== BASE_SEPOLIA_NETWORK ||
        requirement.asset.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase() ||
        !ADDRESS_PATTERN.test(requirement.payTo)
      ) return false
      try {
        const amount = BigInt(requirement.amount)
        return amount > 0n && amount <= MAX_PRICE_UNITS
      } catch {
        return false
      }
    })
    .sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)))

  if (candidates.length === 0) {
    throw new Error('402 response has no payment option allowed by the Base Sepolia USDC policy (maximum 0.10 USDC)')
  }
  return candidates[0]
}

async function getChallenge(url: string) {
  const { response, json } = await requestResource(url)
  if (response.status !== 402) {
    throw new Error(`Expected an x402 HTTP 402 challenge; received ${response.status}`)
  }
  const required = parsePaymentRequired(response, json)
  return { required, requirement: selectAllowedRequirement(required) }
}

function sameRequirement(a: PaymentRequirements, b: PaymentRequirements) {
  return a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase() &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    JSON.stringify(a.extra) === JSON.stringify(b.extra)
}

function getQuote(quoteId: string, url: string) {
  const quote = quotes.get(quoteId)
  if (!quote || quote.url !== url || quote.expiresAt <= Date.now()) {
    quotes.delete(quoteId)
    throw new Error('Quote not found or expired. Inspect the URL again before purchasing.')
  }
  return quote
}

function result(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError }
}

function paymentRequiredForApproval(required: PaymentRequired, requirement: PaymentRequirements, url: string): PaymentRequired {
  return {
    ...required,
    accepts: [requirement],
  }
}

function challengeMatchesQuote(
  challenge: { required: PaymentRequired; requirement: PaymentRequirements },
  quote: Quote,
) {
  return sameRequirement(challenge.requirement, quote.requirement) &&
    challenge.required.resource.url === quote.url &&
    (challenge.required.resource.description || quote.url) === quote.description
}

const server = new McpServer({ name: 'x402http', version: '1.0.0' })

server.registerTool(
  'inspect_url',
  {
    title: 'Inspect an x402 HTTP resource',
    description: 'Make a free unsigned GET to an allowed URL. If it returns x402 HTTP 402, report its payment terms without signing or paying.',
    inputSchema: { url: z.string().url().max(2048) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url: rawUrl }) => {
    try {
      const url = validateResourceUrl(rawUrl).toString()
      const { response, text, json } = await requestResource(url)

      if (response.status !== 402) {
        if (!response.ok) throw new Error(`Resource request failed with HTTP ${response.status}`)
        const contentType = response.headers.get('content-type') || ''
        return result({
          url,
          status: response.status,
          paid: false,
          contentType,
          body: parseResourceBody(text, contentType),
        })
      }

      const required = parsePaymentRequired(response, json)
      const requirement = selectAllowedRequirement(required)
      const quoteId = randomUUID()
      const expiresAt = Date.now() + QUOTE_TTL_MS
      const description = required.resource?.description || url
      quotes.set(quoteId, { quoteId, url, requirement, description, expiresAt })
      for (const [id, quote] of quotes) {
        if (quote.expiresAt <= Date.now()) quotes.delete(id)
      }

      return result({
        quoteId,
        url,
        description,
        amount: `${formatUsdc(requirement.amount)} USDC`,
        asset: requirement.asset,
        network: requirement.network,
        payTo: requirement.payTo,
        expiresAt: new Date(expiresAt).toISOString(),
        note: 'These terms came from the URL\'s x402 402 response. No payment has been made.',
      })
    } catch (error) {
      return result({ error: error instanceof Error ? error.message : 'Could not inspect URL' }, true)
    }
  },
)

server.registerTool(
  'fetch_url',
  {
    title: 'Pay for and fetch an x402 HTTP resource',
    description: 'After showing the inspected quote and receiving the user’s request to proceed, ask OpenCode for approval, then open a wallet confirmation page. Fetches only the quoted URL after settlement succeeds.',
    inputSchema: {
      quoteId: z.string().uuid(),
      url: z.string().url().max(2048),
      confirmedAmount: z.string().min(1).max(40),
      confirmedNetwork: z.string().min(1).max(40),
      confirmedAsset: z.string().regex(ADDRESS_PATTERN),
      confirmedPayTo: z.string().regex(ADDRESS_PATTERN),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ quoteId, url: rawUrl, confirmedAmount, confirmedNetwork, confirmedAsset, confirmedPayTo }) => {
    let callbackCompleted = false

    try {
      const url = validateResourceUrl(rawUrl).toString()
      const quote = getQuote(quoteId, url)
      const expectedAmount = `${formatUsdc(quote.requirement.amount)} USDC`
      if (
        confirmedAmount !== expectedAmount ||
        confirmedNetwork !== quote.requirement.network ||
        confirmedAsset.toLowerCase() !== quote.requirement.asset.toLowerCase() ||
        confirmedPayTo.toLowerCase() !== quote.requirement.payTo.toLowerCase()
      ) {
        throw new Error('Confirmed terms do not match the quote. Inspect the URL again and review the current terms.')
      }

      const beforeApproval = await getChallenge(url)
      if (!challengeMatchesQuote(beforeApproval, quote)) {
        throw new Error('The resource details or payment terms changed since inspection. No signature was requested; inspect it again.')
      }

      const demoUrl = getDemoUrl()
      const approvalUrl = new URL('/agent/approve', demoUrl)
      const paymentRequired = paymentRequiredForApproval(beforeApproval.required, beforeApproval.requirement, url)
      const encodedChallenge = Buffer.from(JSON.stringify(paymentRequired)).toString('base64url')
      if (encodedChallenge.length > 6000) throw new Error('The resource payment challenge is too large to display safely')

      approvalUrl.searchParams.set('url', url)
      approvalUrl.searchParams.set('description', quote.description)
      approvalUrl.searchParams.set('amount', quote.requirement.amount)
      approvalUrl.searchParams.set('asset', quote.requirement.asset)
      approvalUrl.searchParams.set('network', quote.requirement.network)
      approvalUrl.searchParams.set('payTo', quote.requirement.payTo)
      approvalUrl.searchParams.set('paymentRequired', encodedChallenge)

      const approval = await requestWalletApproval({
        approvalPageUrl: approvalUrl.toString(),
        uiOrigin: demoUrl.origin,
        quoteId,
      })
      callbackCompleted = true
      quotes.delete(quoteId)

      if (approval.status !== 'approved') {
        throw new Error('Wallet signature was rejected. No payment was sent.')
      }
      if (quote.expiresAt <= Date.now()) {
        throw new Error('Quote expired while waiting for wallet approval. The signed payload was not sent.')
      }

      let paymentPayload: PaymentPayload
      try {
        paymentPayload = decodePaymentSignatureHeader(approval.paymentHeader)
      } catch {
        throw new Error('The wallet approval page returned an invalid x402 payment payload')
      }
      if (!isPaymentPayload(paymentPayload)) throw new Error('Invalid x402 payment payload')
      assertPayloadMatchesQuote(paymentPayload, quote)

      const immediatelyBeforePayment = await getChallenge(url)
      if (!challengeMatchesQuote(immediatelyBeforePayment, quote)) {
        throw new Error('The resource details or payment terms changed after signing. The signed payload was not sent.')
      }

      const { response, text, json } = await requestResourceWithPayment(url, approval.paymentHeader)
      if (!response.ok) {
        const serverMessage = json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
          ? json.error
          : `Paid resource request failed with HTTP ${response.status}`
        throw new Error(serverMessage)
      }

      const contentType = response.headers.get('content-type') || ''
      const body = parseResourceBody(text, contentType)
      const settlement = x402HttpClient.getPaymentSettleResponse((name) => response.headers.get(name))
      if (
        !settlement.success ||
        settlement.network !== quote.requirement.network ||
        (settlement.amount !== undefined && settlement.amount !== quote.requirement.amount) ||
        !settlement.transaction
      ) {
        throw new Error('The x402 response did not confirm a successful settlement')
      }

      return result({
        url,
        description: quote.description,
        contentType,
        body,
        payment: {
          amount: `${formatUsdc(quote.requirement.amount)} USDC`,
          network: settlement.network,
          payer: settlement.payer,
          transaction: settlement.transaction,
          explorerUrl: `https://sepolia.basescan.org/tx/${settlement.transaction}`,
        },
      })
    } catch (error) {
      if (!callbackCompleted) quotes.delete(quoteId)
      return result({ error: error instanceof Error ? error.message : 'x402 resource fetch failed' }, true)
    }
  },
)

async function requestResourceWithPayment(url: string, paymentHeader: string) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain',
      'PAYMENT-SIGNATURE': paymentHeader,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new Error('Redirects are not allowed for x402 resources')
  }
  const text = await readLimitedBody(response)
  return { response, text, json: parseJsonBody(text) }
}

function assertPayloadMatchesQuote(payload: PaymentPayload, quote: Quote) {
  const accepted = payload.accepted
  const expected = quote.requirement
  if (!sameRequirement(accepted, expected)) {
    throw new Error('Wallet signature does not match the inspected quote')
  }
  if (payload.resource?.url && payload.resource.url !== quote.url) {
    throw new Error('Wallet signature is bound to a different resource URL')
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Generic x402 HTTP MCP connected over stdio')
