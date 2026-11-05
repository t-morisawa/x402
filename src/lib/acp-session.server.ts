import { isAddress } from 'viem'
import { findArticle } from '../data/articles'
import { getArticleBody } from '../data/article-bodies.server'
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from './payment-config'
import {
  createPaymentContext,
  getConfiguredPayTo,
  getPaymentRequiredHeader,
  getPaymentServer,
} from './payment.server'

// ACP checkout(仕様 2026-04-17)のPoC実装。セッションはインメモリで保持する。
// 通貨は ISO 4217 にないため 'usdc'、金額は USDC 最小単位(6桁)の整数とする(独自拡張)。
export const ACP_API_VERSION = '2026-04-17'
export const X402_HANDLER_ID = 'x402_exact_evm_base_sepolia'
const SESSION_TTL_MS = 30 * 60 * 1000

export class AcpError extends Error {
  constructor(
    public status: number,
    public type: 'invalid_request' | 'request_not_idempotent' | 'processing_error' | 'service_unavailable',
    public code: string,
    message: string,
    public param?: string,
  ) {
    super(message)
  }
}

type Status = 'not_ready_for_payment' | 'ready_for_payment' | 'complete_in_progress' | 'completed' | 'canceled' | 'expired'

type Message = { type: 'error'; code: string; param?: string; content_type: 'plain'; content: string }

type Session = {
  id: string
  status: Status
  slug?: string
  quantity: number
  buyer?: { first_name?: string; last_name?: string; email?: string; wallet_address?: string }
  payTo?: string
  messages: Message[]
  expiresAt: number
  order?: Record<string, unknown>
}

const store = ((globalThis as { __acpSessions?: Map<string, Session> }).__acpSessions ??= new Map())

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

function error(param: string, code: string, content: string): Message {
  return { type: 'error', code, param, content_type: 'plain', content }
}

// 2025年版の { id, quantity } と { item: { id, quantity } } の両方を受け付ける。
function readItems(items: unknown): { slug?: string; quantity: number; messages: Message[] } {
  if (!Array.isArray(items) || items.length === 0) {
    return { quantity: 1, messages: [error('$.line_items', 'missing', 'line_items が必要です')] }
  }
  if (items.length > 1) {
    return { quantity: 1, messages: [error('$.line_items', 'invalid', 'このデモでは1商品のみ購入できます')] }
  }
  const raw = items[0]
  const item = isDict(raw) && isDict(raw.item) ? raw.item : raw
  const slug = isDict(item) && typeof item.id === 'string' ? item.id : undefined
  const quantity = isDict(item) && typeof item.quantity === 'number' ? item.quantity : 1
  const messages: Message[] = []
  if (!slug || !findArticle(slug)) messages.push(error('$.line_items[0].id', 'out_of_stock', '商品が見つかりません'))
  if (quantity !== 1) messages.push(error('$.line_items[0].quantity', 'invalid', '数量は1のみです(デジタル商品)'))
  return { slug, quantity, messages }
}

function readBuyer(buyer: unknown): Session['buyer'] {
  if (!isDict(buyer)) return undefined
  const pick = (key: string) => (typeof buyer[key] === 'string' ? (buyer[key] as string) : undefined)
  return {
    first_name: pick('first_name'),
    last_name: pick('last_name'),
    email: pick('email'),
    wallet_address: pick('wallet_address'),
  }
}

function refreshStatus(session: Session, itemMessages: Message[]) {
  const messages = [...itemMessages]
  let payTo: string | undefined
  try {
    payTo = getConfiguredPayTo()
  } catch (cause) {
    throw new AcpError(500, 'processing_error', 'misconfigured', cause instanceof Error ? cause.message : 'X402_PAY_TO が不正です')
  }
  // 受取先未設定(自己送金モード)では買い手のウォレットに送る。
  if (!payTo) {
    const wallet = session.buyer?.wallet_address
    if (!wallet) messages.push(error('$.buyer.wallet_address', 'missing', '自己送金モードでは buyer.wallet_address が必要です'))
    else if (!isAddress(wallet)) messages.push(error('$.buyer.wallet_address', 'invalid', 'EVMアドレスが不正です'))
    else payTo = wallet
  }
  session.payTo = payTo
  session.messages = messages
  session.status = messages.length === 0 ? 'ready_for_payment' : 'not_ready_for_payment'
}

function expireIfNeeded(session: Session) {
  if (session.expiresAt < Date.now() && session.status !== 'completed' && session.status !== 'canceled') {
    session.status = 'expired'
  }
}

function load(id: string) {
  const session = store.get(id)
  if (!session) throw new AcpError(404, 'invalid_request', 'not_found', 'チェックアウトセッションが見つかりません')
  expireIfNeeded(session)
  return session
}

// ACPのレスポンス形式に整形する。ready_for_payment のときだけ x402 の支払い要件を載せる。
async function render(session: Session, origin: string) {
  const article = session.slug ? findArticle(session.slug) : undefined
  const unit = article ? Number(article.priceUnits) : 0
  const subtotal = unit * session.quantity

  const handlers = [
    {
      id: X402_HANDLER_ID,
      name: 'example.x402poc.exact_evm',
      version: ACP_API_VERSION,
      psp: 'x402',
      requires_delegate_payment: false,
      requires_pci_compliance: false,
      config: {
        network: BASE_SEPOLIA_NETWORK,
        asset: BASE_SEPOLIA_USDC,
        amount: String(subtotal),
        pay_to: session.payTo ?? null,
        // x402 の PAYMENT-REQUIRED ヘッダー(base64)。クライアントはこれに署名する。
        payment_required:
          session.status === 'ready_for_payment' && session.slug
            ? await getPaymentRequiredHeader(session.slug, `${origin}/api/article/${session.slug}`, session.payTo)
            : null,
      },
      // 独自handlerのため、complete に渡す credential の形を宣言する。
      instrument_schemas: [
        {
          type: 'x402',
          credential: { type: 'x402_payment_signature', token: 'PAYMENT-SIGNATURE ヘッダーの値(base64)' },
        },
      ],
    },
  ]

  return {
    id: session.id,
    status: session.status,
    currency: 'usdc',
    buyer: session.buyer,
    line_items: article
      ? [
          {
            id: `li_${session.id}`,
            item: { id: article.slug, quantity: session.quantity },
            name: article.title,
            base_amount: subtotal,
            discount: 0,
            subtotal,
            tax: 0,
            total: subtotal,
          },
        ]
      : [],
    totals: [
      { type: 'subtotal', display_text: '小計', amount: subtotal },
      { type: 'total', display_text: '合計', amount: subtotal },
    ],
    fulfillment_options: [],
    capabilities: { payment: { handlers } },
    messages: session.messages,
    links: [],
    expires_at: new Date(session.expiresAt).toISOString(),
    ...(session.order ? { order: session.order } : {}),
  }
}

export async function createSession(body: Dict, origin: string) {
  const { slug, quantity, messages } = readItems(body.line_items)
  const session: Session = {
    id: `cs_${crypto.randomUUID()}`,
    status: 'not_ready_for_payment',
    slug,
    quantity,
    buyer: readBuyer(body.buyer),
    messages: [],
    expiresAt: Date.now() + SESSION_TTL_MS,
  }
  refreshStatus(session, messages)
  store.set(session.id, session)
  return render(session, origin)
}

function assertMutable(session: Session) {
  if (session.status === 'completed' || session.status === 'canceled' || session.status === 'expired') {
    throw new AcpError(405, 'invalid_request', 'not_modifiable', `status=${session.status} のセッションは変更できません`)
  }
  if (session.status === 'complete_in_progress') {
    throw new AcpError(409, 'invalid_request', 'in_progress', '決済処理中です')
  }
}

export async function getSession(id: string, origin: string) {
  return render(load(id), origin)
}

export async function updateSession(id: string, body: Dict, origin: string) {
  const session = load(id)
  assertMutable(session)
  let itemMessages: Message[] = []
  if (body.line_items !== undefined) {
    const items = readItems(body.line_items)
    session.slug = items.slug
    session.quantity = items.quantity
    itemMessages = items.messages
  } else {
    itemMessages = readItems([{ id: session.slug, quantity: session.quantity }]).messages
  }
  if (body.buyer !== undefined) session.buyer = { ...session.buyer, ...readBuyer(body.buyer) }
  refreshStatus(session, itemMessages)
  return render(session, origin)
}

export async function cancelSession(id: string, origin: string) {
  const session = load(id)
  if (session.status === 'completed' || session.status === 'canceled') {
    throw new AcpError(405, 'invalid_request', 'not_modifiable', `status=${session.status} のセッションはキャンセルできません`)
  }
  if (session.status === 'complete_in_progress') {
    throw new AcpError(409, 'invalid_request', 'in_progress', '決済処理中です')
  }
  session.status = 'canceled'
  return render(session, origin)
}

function readCredential(body: Dict) {
  const data = body.payment_data
  if (!isDict(data)) throw new AcpError(400, 'invalid_request', 'missing', 'payment_data が必要です', '$.payment_data')
  if (data.handler_id !== X402_HANDLER_ID) {
    throw new AcpError(400, 'invalid_request', 'invalid', `未対応の handler_id です(対応: ${X402_HANDLER_ID})`, '$.payment_data.handler_id')
  }
  const instrument = data.instrument
  const credential = isDict(instrument) ? instrument.credential : undefined
  const token = isDict(credential) && typeof credential.token === 'string' ? credential.token : undefined
  if (!token || (isDict(credential) && credential.type !== 'x402_payment_signature')) {
    throw new AcpError(400, 'invalid_request', 'invalid', 'x402_payment_signature の credential.token が必要です', '$.payment_data.instrument.credential')
  }
  return token
}

export async function completeSession(id: string, body: Dict, origin: string) {
  const session = load(id)
  if (session.status === 'complete_in_progress') {
    throw new AcpError(409, 'invalid_request', 'in_progress', '決済処理中です')
  }
  if (session.status !== 'ready_for_payment') {
    throw new AcpError(405, 'invalid_request', 'not_ready', `status=${session.status} のセッションは完了できません`)
  }
  const token = readCredential(body)
  const buyer = readBuyer(body.buyer)
  if (buyer) session.buyer = { ...session.buyer, ...buyer }

  const slug = session.slug!
  const article = findArticle(slug)!
  session.status = 'complete_in_progress'
  try {
    const paymentServer = await getPaymentServer()
    const context = createPaymentContext({
      slug,
      url: `${origin}/api/article/${slug}`,
      payTo: session.payTo,
      paymentHeader: token,
    })
    const payment = await paymentServer.processHTTPRequest(context)
    if (payment.type !== 'payment-verified') {
      session.status = 'ready_for_payment'
      session.messages = [error('$.payment_data', 'payment_declined', '支払い署名を検証できませんでした')]
      return render(session, origin)
    }
    const settlement = await paymentServer.processSettlement(
      payment.paymentPayload,
      payment.paymentRequirements,
      payment.declaredExtensions,
    )
    if (!settlement.success) {
      session.status = 'ready_for_payment'
      session.messages = [error('$.payment_data', 'payment_declined', settlement.errorMessage ?? '決済に失敗しました')]
      return render(session, origin)
    }
    const content = getArticleBody(slug)
    session.status = 'completed'
    session.messages = []
    session.order = {
      id: `ord_${crypto.randomUUID()}`,
      checkout_session_id: session.id,
      permalink_url: `${origin}/article/${slug}`,
      // 以下は独自拡張: x402の決済結果と、解放された記事本文。
      x402: {
        transaction: settlement.transaction,
        network: settlement.network,
        payer: settlement.payer,
        amount: settlement.amount,
      },
      content: { title: article.title, body: content ?? [] },
    }
    return render(session, origin)
  } catch (cause) {
    // 決済結果が不明な例外は再試行できる状態に戻す。
    if (session.status === 'complete_in_progress') session.status = 'ready_for_payment'
    throw new AcpError(502, 'processing_error', 'payment_failed', cause instanceof Error ? cause.message : '決済の処理に失敗しました')
  }
}
