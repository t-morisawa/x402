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
import { isPaymentPayload, requestMandateSignature, requestWalletApproval } from './approval-bridge.ts'
import { acpRequest, getSessionPaymentRequired, summarizeSession, X402_HANDLER_NAME, type AcpSession } from './acp-client.ts'
import { getAgentAccount, signPayment } from './agent-signer.ts'
import {
  checkAutoPay,
  createTerms,
  getActiveMandate,
  registerMandate,
  release,
  reserve,
  revokeMandate,
  summarizeMandate,
} from './mandate.ts'
import { encodeMandateTerms } from '../../src/lib/mandate.ts'

const quotes = new Map<string, Quote>()
// ACP checkoutのquoteIdと、対応するsessionIdの対応表
const quoteSessions = new Map<string, string>()

const sessionPath = (sessionId: string) => `/api/acp/checkout_sessions/${encodeURIComponent(sessionId)}`

/** ACPセッションを取り直し、x402の支払い条件とhandler IDを取り出す。ready_for_paymentでなければ例外。 */
async function acpChallenge(sessionId: string) {
  const session = await acpRequest('GET', sessionPath(sessionId))
  const required = getSessionPaymentRequired(session)
  if (!required) throw new Error(`Checkout session is not ready for payment (status: ${session.status})`)
  const handler = session.capabilities.payment.handlers.find((item) => item.name === X402_HANDLER_NAME)!
  return { handlerId: handler.id, challenge: { required, requirement: selectAllowedRequirement(required) } }
}

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


  // ---- ACP (Agentic Commerce Protocol) checkout tools ----
  const productId = z.string().regex(/^[a-z0-9-]{1,100}$/)
  const walletAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/)

  /** セッション要約を返す。ready_for_paymentなら、支払い条件のquoteも発行する。 */
  function describeSession(session: AcpSession) {
    const summary = summarizeSession(session)
    const required = getSessionPaymentRequired(session)
    if (!required) return summary
    const requirement = selectAllowedRequirement(required)
    const quote = createQuote({ url: required.resource.url, requirement, description: required.resource.description || required.resource.url })
    quotes.set(quote.quoteId, quote)
    quoteSessions.set(quote.quoteId, session.id)
    removeExpiredQuotes()
    return {
      ...summary,
      quoteId: quote.quoteId,
      amount: `${formatUsdc(requirement.amount)} USDC`,
      asset: requirement.asset,
      network: requirement.network,
      payTo: requirement.payTo,
      expiresAt: new Date(quote.expiresAt).toISOString(),
      note: 'These terms came from the ACP checkout session (x402 payment handler). No payment has been made.',
    }
  }

  const acpTool = (handler: (args: any) => Promise<AcpSession>) => async (args: unknown) => {
    try {
      return toolResult(describeSession(await handler(args)))
    } catch (error) {
      return toolResult({ error: error instanceof Error ? error.message : 'ACP request failed' }, true)
    }
  }

  server.registerTool(
    'acp_create_checkout',
    {
      title: 'Create an ACP checkout session',
      description: 'Create an ACP checkout session for a product (productId is the article slug). No payment is made. If walletAddress is required, the result says so; update the session with it.',
      inputSchema: { productId, buyerEmail: z.string().email().max(200).optional(), walletAddress: walletAddress.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    acpTool(({ productId: id, buyerEmail, walletAddress: wallet }) => acpRequest('POST', '/api/acp/checkout_sessions', {
      line_items: [{ id, quantity: 1 }],
      buyer: { email: buyerEmail, wallet_address: wallet },
    })),
  )

  server.registerTool(
    'acp_update_checkout',
    {
      title: 'Update an ACP checkout session',
      description: 'Update buyer information of an ACP checkout session. No payment is made.',
      inputSchema: { sessionId: z.string().max(100), buyerEmail: z.string().email().max(200).optional(), walletAddress: walletAddress.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    acpTool(({ sessionId, buyerEmail, walletAddress: wallet }) => acpRequest('POST', sessionPath(sessionId), {
      buyer: { email: buyerEmail, wallet_address: wallet },
    })),
  )

  server.registerTool(
    'acp_get_checkout',
    {
      title: 'Get an ACP checkout session',
      description: 'Read the current state of an ACP checkout session. Issues a fresh quote when it is ready for payment.',
      inputSchema: { sessionId: z.string().max(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    acpTool(({ sessionId }) => acpRequest('GET', sessionPath(sessionId))),
  )

  server.registerTool(
    'acp_cancel_checkout',
    {
      title: 'Cancel an ACP checkout session',
      description: 'Cancel an ACP checkout session that has not been completed.',
      inputSchema: { sessionId: z.string().max(100) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    acpTool(({ sessionId }) => acpRequest('POST', `${sessionPath(sessionId)}/cancel`)),
  )

  // 承認とウォレット署名の後にだけ complete を呼ぶ。
  server.registerTool(
    'acp_complete_checkout',
    {
      title: 'Pay for and complete an ACP checkout session',
      description: 'After showing the quote from acp_create_checkout/acp_update_checkout/acp_get_checkout and receiving the user’s request to proceed, ask for approval, then open a wallet confirmation page. Completes the session only after the user signs.',
      inputSchema: {
        sessionId: z.string().max(100),
        quoteId: z.string().uuid(),
        confirmedAmount: z.string().min(1).max(40),
        confirmedNetwork: z.string().min(1).max(40),
        confirmedAsset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        confirmedPayTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ sessionId, quoteId, confirmedAmount, confirmedNetwork, confirmedAsset, confirmedPayTo }) => {
      let callbackCompleted = false
      try {
        // 1. quoteがこのsessionのものか、利用者が確認した条件と一致するかを検証する。
        const quote = quotes.get(quoteId)
        if (!quote || quoteSessions.get(quoteId) !== sessionId || quote.expiresAt <= Date.now()) {
          throw new Error('Quote not found or expired. Get the checkout session again before purchasing.')
        }
        validateConfirmedTerms({ quote, confirmedAmount, confirmedNetwork, confirmedAsset, confirmedPayTo })

        // 2. セッションを取り直し、支払い条件がquoteから変わっていなければ署名画面へ進む。
        const before = await acpChallenge(sessionId)
        if (!challengeMatchesQuote(before.challenge, quote)) {
          throw new Error('The checkout details or payment terms changed since the quote. No signature was requested; get the session again.')
        }

        // 3. ウォレット署名を待つ。
        const approval = await collectWalletApproval(quote, before.challenge)
        callbackCompleted = true
        quotes.delete(quoteId)
        quoteSessions.delete(quoteId)
        if (approval.status !== 'approved') throw new Error('Wallet signature was rejected. No payment was sent.')
        if (quote.expiresAt <= Date.now()) {
          throw new Error('Quote expired while waiting for wallet approval. The signed payload was not sent.')
        }

        // 4. 署名を検証し、直前にもう一度条件を確認してから complete を呼ぶ。
        decodeAndValidatePayload(approval.paymentHeader, quote)
        const latest = await acpChallenge(sessionId)
        if (!challengeMatchesQuote(latest.challenge, quote)) {
          throw new Error('The checkout details or payment terms changed after signing. The signed payload was not sent.')
        }
        const completed = await acpRequest('POST', `${sessionPath(sessionId)}/complete`, {
          payment_data: {
            handler_id: latest.handlerId,
            instrument: { type: 'x402', credential: { type: 'x402_payment_signature', token: approval.paymentHeader } },
          },
        })

        // 5. completed とsettlement receiptを確認して結果を返す。
        const receipt = completed.order?.x402
        if (
          completed.status !== 'completed' ||
          !receipt?.transaction ||
          receipt.network !== quote.requirement.network ||
          receipt.amount !== quote.requirement.amount
        ) {
          const reason = completed.messages.map((message) => message.content).join(' / ')
          throw new Error(`Checkout was not completed (status: ${completed.status}). ${reason}`.trim())
        }
        return toolResult({
          ...summarizeSession(completed),
          orderId: completed.order?.id,
          content: completed.order?.content,
          payment: {
            amount: `${formatUsdc(quote.requirement.amount)} USDC`,
            network: receipt.network,
            payer: receipt.payer,
            transaction: receipt.transaction,
            explorerUrl: `https://sepolia.basescan.org/tx/${receipt.transaction}`,
          },
        })
      } catch (error) {
        if (!callbackCompleted) {
          quotes.delete(quoteId)
          quoteSessions.delete(quoteId)
        }
        return toolResult({ error: error instanceof Error ? error.message : 'ACP checkout failed' }, true)
      }
    },
  )

  // ---- 許可証(AP2風 Open mandate)による自動決済 ----
  const usdcAmount = z.string().regex(/^\d+(\.\d{1,6})?$/)

  server.registerTool(
    'mandate_create',
    {
      title: 'Create a spending mandate',
      description: 'Open a wallet page where the user signs a spending mandate once: allowed payees, per-purchase limit, total budget and expiry. Required before acp_complete_checkout_with_mandate. The agent wallet (X402_AGENT_PRIVATE_KEY) must hold the Base Sepolia USDC to be spent.',
      inputSchema: {
        payees: z.array(walletAddress).min(1).max(10),
        maxPerPurchase: usdcAmount,
        budget: usdcAmount,
        ttlMinutes: z.number().int().min(1).max(1440).default(60),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ payees, maxPerPurchase, budget, ttlMinutes }) => {
      try {
        if (getActiveMandate()) throw new Error('An active mandate already exists. Revoke it before creating a new one.')
        const terms = createTerms({ agent: getAgentAccount().address, payees, maxPerPurchase, budget, ttlMinutes })
        const demoUrl = getDemoUrl()
        const pageUrl = new URL('/agent/mandate', demoUrl)
        pageUrl.searchParams.set('mandate', encodeMandateTerms(terms))
        const result = await requestMandateSignature({ approvalPageUrl: pageUrl.toString(), uiOrigin: demoUrl.origin, quoteId: terms.mandateId })
        if (result.status !== 'approved') throw new Error('Mandate signature was rejected. No mandate was created.')
        const mandate = await registerMandate(terms, result.signature)
        return toolResult({ ...summarizeMandate(mandate), note: 'Payments within this mandate are made automatically from the agent wallet without further approval.' })
      } catch (error) {
        return toolResult({ error: error instanceof Error ? error.message : 'Could not create the mandate' }, true)
      }
    },
  )

  server.registerTool(
    'mandate_status',
    {
      title: 'Show the spending mandate',
      description: 'Show the active mandate, its remaining budget and payment receipts. Also shows the agent wallet address to fund.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      let agent: string | undefined
      try {
        agent = getAgentAccount().address
      } catch {
        // 鍵が未設定でも状態は返す。
      }
      const mandate = getActiveMandate()
      return toolResult({ agentWallet: agent ?? 'not configured', mandate: mandate ? summarizeMandate(mandate) : null })
    },
  )

  server.registerTool(
    'mandate_revoke',
    {
      title: 'Revoke the spending mandate',
      description: 'Revoke the active mandate so that no further automatic payments are made.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      revokeMandate()
      return toolResult({ revoked: true })
    },
  )

  // 許可証の範囲内なら、人の承認なしでエージェントの鍵で署名して complete を呼ぶ。
  server.registerTool(
    'acp_complete_checkout_with_mandate',
    {
      title: 'Pay for an ACP checkout session within the mandate',
      description: 'Complete an ACP checkout session by signing with the agent wallet, without a per-purchase approval. Works only when the session terms are inside the active mandate (payee, per-purchase limit, remaining budget, expiry); otherwise use acp_complete_checkout.',
      inputSchema: { sessionId: z.string().max(100), quoteId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ sessionId, quoteId }) => {
      try {
        // 1. quoteがこのsessionのものか、許可証の範囲内かを検査する。
        const quote = quotes.get(quoteId)
        if (!quote || quoteSessions.get(quoteId) !== sessionId || quote.expiresAt <= Date.now()) {
          throw new Error('Quote not found or expired. Get the checkout session again before purchasing.')
        }
        const mandate = getActiveMandate()
        if (!mandate) throw new Error('No active mandate. Create one with mandate_create, or pay with acp_complete_checkout.')
        checkAutoPay(mandate, quote.requirement)

        // 2. セッションの支払い条件がquoteから変わっていないことを確認する。
        const before = await acpChallenge(sessionId)
        if (!challengeMatchesQuote(before.challenge, quote)) {
          throw new Error('The checkout details or payment terms changed since the quote. Get the session again.')
        }
        quotes.delete(quoteId)
        quoteSessions.delete(quoteId)

        // 3. 予算を確保して署名し、直前にもう一度条件を確認してから complete を呼ぶ。
        const amount = BigInt(quote.requirement.amount)
        reserve(mandate, amount)
        let sent = false
        let completed: AcpSession
        try {
          const paymentHeader = await signPayment(before.challenge.required, quote.requirement)
          decodeAndValidatePayload(paymentHeader, quote)
          const latest = await acpChallenge(sessionId)
          if (!challengeMatchesQuote(latest.challenge, quote)) {
            throw new Error('The checkout details or payment terms changed after signing. The signed payload was not sent.')
          }
          sent = true
          completed = await acpRequest('POST', `${sessionPath(sessionId)}/complete`, {
            payment_data: {
              handler_id: latest.handlerId,
              instrument: { type: 'x402', credential: { type: 'x402_payment_signature', token: paymentHeader } },
            },
          })
        } catch (error) {
          // 送信前に失敗した場合だけ予算を戻す。送信後の例外は決済済みかもしれないので確保したままにする。
          if (!sent) release(mandate, amount)
          throw error
        }

        // 4. completed とsettlement receiptを確認し、証跡を残す。
        const receipt = completed.order?.x402
        if (
          completed.status !== 'completed' ||
          !receipt?.transaction ||
          receipt.network !== quote.requirement.network ||
          receipt.amount !== quote.requirement.amount
        ) {
          release(mandate, amount)
          const reason = completed.messages.map((message) => message.content).join(' / ')
          throw new Error(`Checkout was not completed (status: ${completed.status}). ${reason}`.trim())
        }
        mandate.receipts.push({
          at: new Date().toISOString(),
          sessionId,
          orderId: completed.order?.id,
          transaction: receipt.transaction,
          amount: receipt.amount,
          payTo: quote.requirement.payTo,
          payer: receipt.payer,
        })
        return toolResult({
          ...summarizeSession(completed),
          orderId: completed.order?.id,
          content: completed.order?.content,
          payment: {
            amount: `${formatUsdc(quote.requirement.amount)} USDC`,
            network: receipt.network,
            payer: receipt.payer,
            transaction: receipt.transaction,
            explorerUrl: `https://sepolia.basescan.org/tx/${receipt.transaction}`,
          },
          mandate: { mandateId: mandate.terms.mandateId, remainingUnits: (BigInt(mandate.terms.budget) - mandate.spent).toString() },
        })
      } catch (error) {
        return toolResult({ error: error instanceof Error ? error.message : 'Mandate payment failed' }, true)
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
