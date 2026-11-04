import { randomUUID } from 'node:crypto'
import { decodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired } from '@x402/core/types'
import { REQUEST_TIMEOUT_MS, getDemoUrl, validateResourceUrl } from './config.ts'
import { formatUsdc, selectAllowedRequirement } from './payment-policy.ts'
import { parseJsonBody, readLimitedBody } from './resource-http.ts'

// ACP(Agentic Commerce Protocol)のcheckout REST APIを呼ぶ薄いクライアント。
export const ACP_API_VERSION = '2026-04-17'
export const X402_HANDLER_NAME = 'dev.x402.exact_evm'

export type AcpSession = {
  id: string
  status: string
  currency: string
  line_items: Array<{ item: { id: string; quantity: number }; name: string; total: number }>
  totals: Array<{ type: string; amount: number }>
  capabilities: { payment: { handlers: Array<{ id: string; name: string; config: { payment_required: string | null } }> } }
  messages: Array<{ code: string; param?: string; content: string }>
  order?: {
    id: string
    permalink_url: string
    x402?: { transaction: string; network: string; payer: string; amount: string }
    content?: { title: string; body: string[] }
  }
}

/** ACP APIを呼ぶ。origin allowlistを検証し、HTTPエラーは ACP の message を持つ例外にする。 */
export async function acpRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AcpSession> {
  const url = validateResourceUrl(new URL(path, getDemoUrl()).toString())
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.ACP_API_KEY || 'demo'}`,
      'API-Version': ACP_API_VERSION,
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const json = parseJsonBody(await readLimitedBody(response)) as Record<string, unknown> | undefined
  if (!response.ok || !json) {
    const message = typeof json?.message === 'string' ? json.message : `ACP request failed with HTTP ${response.status}`
    throw new Error(message)
  }
  return json as unknown as AcpSession
}

/** ready_for_payment のセッションから、x402の支払い要件(PAYMENT-REQUIREDヘッダー)を取り出す。 */
export function getSessionPaymentRequired(session: AcpSession): PaymentRequired | undefined {
  const handler = session.capabilities.payment.handlers.find((item) => item.name === X402_HANDLER_NAME)
  const header = handler?.config.payment_required
  if (session.status !== 'ready_for_payment' || !header) return undefined
  const required = decodePaymentRequiredHeader(header)
  const requirement = selectAllowedRequirement(required)
  const total = session.totals.find((item) => item.type === 'total')?.amount
  if (total === undefined || String(total) !== requirement.amount) {
    throw new Error('Session total does not match the x402 payment requirement')
  }
  return required
}

/** エージェントに返すセッション要約。支払い条件は別途quoteで返す。 */
export function summarizeSession(session: AcpSession) {
  const total = session.totals.find((item) => item.type === 'total')?.amount ?? 0
  return {
    sessionId: session.id,
    status: session.status,
    items: session.line_items.map((item) => ({ productId: item.item.id, name: item.name, quantity: item.item.quantity })),
    total: `${formatUsdc(String(total))} USDC`,
    messages: session.messages.map(({ code, param, content }) => ({ code, param, content })),
  }
}
