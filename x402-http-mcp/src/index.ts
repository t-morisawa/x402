import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload } from '@x402/core/types'
import { z } from 'zod'
import { getDemoUrl, validateResourceUrl } from './config.ts'
import {
  assertPayloadMatchesQuote,
  challengeMatchesQuote,
  createQuote,
  formatUsdc,
  getQuote,
  paymentRequiredForApproval,
  selectAllowedRequirement,
  type Quote,
} from './payment-policy.ts'
import {
  getChallenge,
  parsePaymentRequired,
  parsePaymentSettleResponse,
  parseResourceBody,
  requestResource,
} from './resource-http.ts'
import { isPaymentPayload, requestWalletApproval } from './approval-bridge.ts'

const quotes = new Map<string, Quote>()

/** MCP toolへJSON形式の結果、またはエラーを返す。 */
function toolResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError }
}

/** MCPサーバーにHTTPリソースの調査と決済付き取得toolを登録する。 */
function createServer() {
  const server = new McpServer({ name: 'x402http', version: '1.0.0' })

  // 支払いを行わず、指定URLの無料コンテンツまたはx402の見積もりを返す。
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
        // 1. URLとoriginを検証してから、支払いなしでリソースを調べる。
        const url = validateResourceUrl(rawUrl).toString()
        const { response, text, json } = await requestResource(url)

        // 2. 402以外の応答なら本文を返す
        if (response.status !== 402) {
          if (!response.ok) throw new Error(`Resource request failed with HTTP ${response.status}`)
          const contentType = response.headers.get('content-type') || ''
          return toolResult({
            url,
            status: response.status,
            paid: false,
            contentType,
            body: parseResourceBody(text, contentType),
          })
        }

        // 3. 402ならPaymentRequiredをメモリ上に保存しておく
        const required = parsePaymentRequired(response, json)
        const requirement = selectAllowedRequirement(required)
        const quote = createQuote({
          url,
          requirement,
          description: required.resource?.description || url,
        })
        quotes.set(quote.quoteId, quote)
        removeExpiredQuotes()

        // 4. 支払い条件をエージェントに渡す
        return toolResult({
          quoteId: quote.quoteId,
          url,
          description: quote.description,
          amount: `${formatUsdc(requirement.amount)} USDC`,
          asset: requirement.asset,
          network: requirement.network,
          payTo: requirement.payTo,
          expiresAt: new Date(quote.expiresAt).toISOString(),
          note: 'These terms came from the URL\'s x402 402 response. No payment has been made.',
        })
      } catch (error) {
        return toolResult({ error: error instanceof Error ? error.message : 'Could not inspect URL' }, true)
      }
    },
  )

  // OpenCodeとウォレットで承認された場合だけ、署名payloadを元のURLへ送って本文を取得する。
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
        confirmedAsset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        confirmedPayTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ quoteId, url: rawUrl, confirmedAmount, confirmedNetwork, confirmedAsset, confirmedPayTo }) => {
      let callbackCompleted = false
      try {
        // 1. 保存済みquoteと、利用者が確認した支払条件が一致するか検証する。
        const url = validateResourceUrl(rawUrl).toString()
        const quote = getQuote(quotes, quoteId, url)
        validateConfirmedTerms({ quote, confirmedAmount, confirmedNetwork, confirmedAsset, confirmedPayTo })

        // 2. もう一度無署名でリクエストして402を受け取り、条件がquoteと同じ場合だけ、ウォレット承認画面へ進む。
        const beforeApproval = await getChallenge(url)
        if (!challengeMatchesQuote(beforeApproval, quote)) {
          throw new Error('The resource details or payment terms changed since inspection. No signature was requested; inspect it again.')
        }

        // 3. 署名画面を開いてユーザの署名を待機, 結果を受け取る
        const approval = await collectWalletApproval(quote, beforeApproval)
        callbackCompleted = true
        quotes.delete(quoteId)

        // 4. 署名payloadを検証し、支払い直前にも条件が変わっていないことを確認する。
        if (approval.status !== 'approved') {
          throw new Error('Wallet signature was rejected. No payment was sent.')
        }
        if (quote.expiresAt <= Date.now()) {
          throw new Error('Quote expired while waiting for wallet approval. The signed payload was not sent.')
        }

        const paymentPayload = decodeAndValidatePayload(approval.paymentHeader, quote)
        const immediatelyBeforePayment = await getChallenge(url)
        if (!challengeMatchesQuote(immediatelyBeforePayment, quote)) {
          throw new Error('The resource details or payment terms changed after signing. The signed payload was not sent.')
        }

        // 5. 同じURLへ署名付きGETを送り、settlement成功後に本文とreceiptを返す。
        const { response, text, json } = await requestResource(url, approval.paymentHeader)
        if (!response.ok) {
          const serverMessage = json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
            ? json.error
            : `Paid resource request failed with HTTP ${response.status}`
          throw new Error(serverMessage)
        }

        return createSuccessfulResult({ response, text, quote })
      } catch (error) {
        if (!callbackCompleted) quotes.delete(quoteId)
        return toolResult({ error: error instanceof Error ? error.message : 'x402 resource fetch failed' }, true)
      }
    },
  )

  return server
}

/** 確認toolへ渡された条件が、事前に表示したquoteと一致することを確かめる。 */
function validateConfirmedTerms(options: {
  quote: Quote
  confirmedAmount: string
  confirmedNetwork: string
  confirmedAsset: string
  confirmedPayTo: string
}) {
  const { quote, confirmedAmount, confirmedNetwork, confirmedAsset, confirmedPayTo } = options
  if (
    confirmedAmount !== `${formatUsdc(quote.requirement.amount)} USDC` ||
    confirmedNetwork !== quote.requirement.network ||
    confirmedAsset.toLowerCase() !== quote.requirement.asset.toLowerCase() ||
    confirmedPayTo.toLowerCase() !== quote.requirement.payTo.toLowerCase()
  ) {
    throw new Error('Confirmed terms do not match the quote. Inspect the URL again and review the current terms.')
  }
}

/** 期限切れquoteを取り除き、メモリー上のquoteを新しいものだけに保つ。 */
function removeExpiredQuotes() {
  for (const [quoteId, quote] of quotes) {
    if (quote.expiresAt <= Date.now()) quotes.delete(quoteId)
  }
}

/** 最新の402条件を承認画面へ渡し、ウォレット署名を受け取る。 */
async function collectWalletApproval(
  quote: Quote,
  challenge: Awaited<ReturnType<typeof getChallenge>>,
) {
  const demoUrl = getDemoUrl()
  const approvalUrl = new URL('/agent/approve', demoUrl)
  const paymentRequired = paymentRequiredForApproval(challenge.required, challenge.requirement)
  const encodedChallenge = Buffer.from(JSON.stringify(paymentRequired)).toString('base64url')
  if (encodedChallenge.length > 6000) throw new Error('The resource payment challenge is too large to display safely')

  approvalUrl.searchParams.set('url', quote.url)
  approvalUrl.searchParams.set('description', quote.description)
  approvalUrl.searchParams.set('amount', quote.requirement.amount)
  approvalUrl.searchParams.set('asset', quote.requirement.asset)
  approvalUrl.searchParams.set('network', quote.requirement.network)
  approvalUrl.searchParams.set('payTo', quote.requirement.payTo)
  approvalUrl.searchParams.set('paymentRequired', encodedChallenge)

  // 承認画面を開きユーザ応答を待つ
  return requestWalletApproval({
    approvalPageUrl: approvalUrl.toString(),
    uiOrigin: demoUrl.origin,
    quoteId: quote.quoteId,
  })
}

/** callbackのPAYMENT-SIGNATUREをデコードし、quoteと照合してから返す。 */
function decodeAndValidatePayload(paymentHeader: string, quote: Quote): PaymentPayload {
  let paymentPayload: PaymentPayload
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentHeader)
  } catch {
    throw new Error('The wallet approval page returned an invalid x402 payment payload')
  }
  if (!isPaymentPayload(paymentPayload)) throw new Error('Invalid x402 payment payload')
  assertPayloadMatchesQuote(paymentPayload, quote)
  return paymentPayload
}

/** 決済成功応答とsettlement receiptを検証し、取得内容をMCP tool resultにまとめる。 */
async function createSuccessfulResult(options: {
  response: Response
  text: string
  quote: Quote
}) {
  const { response, text, quote } = options
  const contentType = response.headers.get('content-type') || ''
  const body = parseResourceBody(text, contentType)
  const settleResponse = parsePaymentSettleResponse(response)
  if (
    !settleResponse.success ||
    settleResponse.network !== quote.requirement.network ||
    (settleResponse.amount !== undefined && settleResponse.amount !== quote.requirement.amount) ||
    !settleResponse.transaction
  ) {
    throw new Error('The x402 response did not confirm a successful settlement')
  }

  return toolResult({
    url: quote.url,
    description: quote.description,
    contentType,
    body,
    payment: {
      amount: `${formatUsdc(quote.requirement.amount)} USDC`,
      network: settleResponse.network,
      payer: settleResponse.payer,
      transaction: settleResponse.transaction,
      explorerUrl: `https://sepolia.basescan.org/tx/${settleResponse.transaction}`,
    },
  })
}

const transport = new StdioServerTransport()
await createServer().connect(transport)
console.error('Generic x402 HTTP MCP connected over stdio')
