import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

// x402 facilitator のスタブ。initialize 時の /supported だけ応答する。
const facilitator = createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(
    request.url === '/supported'
      ? { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }
      : {},
  ))
})

const WALLET = '0x000000000000000000000000000000000000dEaD'
const ORIGIN = 'http://localhost:3000'
let handleAcp: typeof import('./acp-http.server').handleAcp
let createSession: typeof import('./acp-session.server').createSession

before(async () => {
  await new Promise<void>((resolve) => facilitator.listen(0, '127.0.0.1', resolve))
  process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`
  process.env.X402_PAY_TO = ''
  ;({ handleAcp } = await import('./acp-http.server'))
  ;({ createSession } = await import('./acp-session.server'))
})
after(() => facilitator.close())

let keySeq = 0
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'api-version': '2026-04-17',
      'idempotency-key': `key-${keySeq++}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return request
}

const route = (request: Request) => handleAcp(request, async ({ body, origin }) => {
  const { createSession: create, updateSession, cancelSession, completeSession } = await import('./acp-session.server')
  const path = new URL(request.url).pathname
  const [, , , , id, action] = path.split('/')
  if (!id) return create(body, origin)
  if (action === 'cancel') return cancelSession(id, origin)
  if (action === 'complete') return completeSession(id, body, origin)
  return updateSession(id, body, origin)
})

describe('ACP checkout', () => {
  it('ウォレット未指定ならnot_ready_for_payment、指定するとready_for_paymentになる', async () => {
    const created = await (await route(post('/api/acp/checkout_sessions', { line_items: [{ id: 'ai-agents-economy', quantity: 1 }] }))).json()
    assert.equal(created.status, 'not_ready_for_payment')
    assert.equal(created.messages[0].param, '$.buyer.wallet_address')

    const updated = await (await route(post(`/api/acp/checkout_sessions/${created.id}`, { buyer: { wallet_address: WALLET } }))).json()
    assert.equal(updated.status, 'ready_for_payment')
    const config = updated.capabilities.payment.handlers[0].config
    assert.equal(config.pay_to, WALLET)
    assert.equal(config.amount, '10000')
    assert.ok(config.payment_required)
  })

  it('存在しない商品・数量2はエラーメッセージ付きでnot_ready', async () => {
    const unknown = await createSession({ line_items: [{ id: 'nope', quantity: 1 }] }, ORIGIN)
    assert.equal(unknown.messages[0].code, 'out_of_stock')
    const many = await createSession({ line_items: [{ id: 'ai-agents-economy', quantity: 2 }] }, ORIGIN)
    assert.equal(many.messages[0].param, '$.line_items[0].quantity')
  })

  it('同一Idempotency-Keyは再送、本文が違えば409', async () => {
    const body = { line_items: [{ id: 'ai-agents-economy', quantity: 1 }] }
    const headers = { 'idempotency-key': 'fixed-key' }
    const first = await route(post('/api/acp/checkout_sessions', body, headers))
    const replay = await route(post('/api/acp/checkout_sessions', body, headers))
    assert.equal(replay.headers.get('idempotent-replayed'), 'true')
    assert.equal((await replay.json()).id, (await first.json()).id)

    const conflict = await route(post('/api/acp/checkout_sessions', { line_items: [] }, headers))
    assert.equal(conflict.status, 422)
    assert.equal((await conflict.json()).code, 'idempotency_conflict')
    assert.equal(replay.headers.get('idempotency-key'), 'fixed-key')
  })

  it('認証・APIバージョン・Idempotency-Keyが無ければ拒否する', async () => {
    assert.equal((await route(post('/api/acp/checkout_sessions', {}, { authorization: '' }))).status, 401)
    assert.equal((await route(post('/api/acp/checkout_sessions', {}, { 'api-version': '2020-01-01' }))).status, 400)
    const noKey = new Request(`${ORIGIN}/api/acp/checkout_sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'api-version': '2026-04-17' },
      body: '{}',
    })
    assert.equal((await (await route(noKey)).json()).code, 'idempotency_key_required')
  })

  it('cancel後は再cancelもcompleteも405、handler不一致のcompleteは400', async () => {
    const created = await (await route(post('/api/acp/checkout_sessions', {
      line_items: [{ id: 'ai-agents-economy', quantity: 1 }],
      buyer: { wallet_address: WALLET },
    }))).json()
    const complete = `/api/acp/checkout_sessions/${created.id}/complete`
    assert.equal((await route(post(complete, { payment_data: { handler_id: 'other' } }))).status, 400)

    assert.equal((await route(post(`/api/acp/checkout_sessions/${created.id}/cancel`, {}))).status, 200)
    assert.equal((await route(post(`/api/acp/checkout_sessions/${created.id}/cancel`, {}))).status, 405)
    assert.equal((await route(post(complete, {}))).status, 405)
  })
})
