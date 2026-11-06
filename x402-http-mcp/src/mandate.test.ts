import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from '../../src/lib/payment-config.ts'
import { mandateTypedData } from '../../src/lib/mandate.ts'
import { signPayment } from './agent-signer.ts'
import { checkAutoPay, createTerms, getActiveMandate, parseUsdc, registerMandate, release, reserve, revokeMandate } from './mandate.ts'

const PAYEE = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const AGENT = '0x3333333333333333333333333333333333333333'

const requirement = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact',
  network: BASE_SEPOLIA_NETWORK,
  amount: '10000',
  asset: BASE_SEPOLIA_USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
  ...overrides,
})

const terms = (overrides: Partial<Parameters<typeof createTerms>[0]> = {}) =>
  createTerms({ agent: AGENT, payees: [PAYEE], maxPerPurchase: '0.05', budget: '0.1', ttlMinutes: 60, ...overrides })

async function signed(overrides = {}) {
  const user = privateKeyToAccount(generatePrivateKey())
  const t = terms(overrides)
  const signature = await user.signTypedData(mandateTypedData(t) as never)
  return { user, t, signature }
}

test('parseUsdc converts decimals and rejects bad input', () => {
  assert.equal(parseUsdc('0.05'), 50_000n)
  assert.equal(parseUsdc('1'), 1_000_000n)
  assert.throws(() => parseUsdc('0.0000001'))
  assert.throws(() => parseUsdc('-1'))
})

test('createTerms enforces the fixed policy limits', () => {
  assert.throws(() => terms({ maxPerPurchase: '0.11' }), /per-purchase/)
  assert.throws(() => terms({ budget: '1.5' }), /budget/)
  assert.throws(() => terms({ budget: '0.01' }), /budget/)
  assert.throws(() => terms({ payees: [] }), /payees/)
  assert.throws(() => terms({ ttlMinutes: 1441 }), /ttlMinutes/)
  assert.equal(terms({ payees: [PAYEE.toUpperCase().replace('0X', '0x'), PAYEE] }).payees.length, 1)
})

test('registerMandate recovers the signer and allows only one active mandate', async () => {
  const { user, t, signature } = await signed()
  const mandate = await registerMandate(t, signature)
  assert.equal(mandate.user, user.address)
  assert.equal(getActiveMandate(), mandate)

  const second = await signed()
  await assert.rejects(() => registerMandate(second.t, second.signature), /active mandate/)

  revokeMandate()
  assert.equal(getActiveMandate(), undefined)
  const third = await registerMandate(second.t, second.signature)
  assert.equal(third.user, second.user.address)
  revokeMandate()
})

test('tampered terms do not recover to the signer', async () => {
  const { user, t, signature } = await signed()
  const tampered = { ...t, budget: '1000000' }
  const mandate = await registerMandate(tampered, signature)
  assert.notEqual(mandate.user, user.address)
  revokeMandate()
})

test('checkAutoPay accepts in-range payments and rejects everything else', async () => {
  const { t, signature } = await signed()
  const mandate = await registerMandate(t, signature)
  const now = Date.now()

  checkAutoPay(mandate, requirement(), now)
  assert.throws(() => checkAutoPay(mandate, requirement({ payTo: OTHER }), now), /Payee/)
  assert.throws(() => checkAutoPay(mandate, requirement({ amount: '50001' }), now), /per-purchase/)
  assert.throws(() => checkAutoPay(mandate, requirement({ asset: OTHER }), now), /Asset/)
  assert.throws(() => checkAutoPay(mandate, requirement(), now + 2 * 60 * 60_000), /expired/)

  reserve(mandate, 50_000n)
  reserve(mandate, 45_000n)
  assert.throws(() => checkAutoPay(mandate, requirement(), now), /remaining budget/)
  release(mandate, 45_000n)
  checkAutoPay(mandate, requirement(), now)

  revokeMandate()
  assert.throws(() => checkAutoPay(mandate, requirement(), now), /revoked/)
})

test('signPayment signs with the agent key and binds the chosen requirement', async () => {
  process.env.X402_AGENT_PRIVATE_KEY = generatePrivateKey()
  const expected = privateKeyToAccount(process.env.X402_AGENT_PRIVATE_KEY as `0x${string}`)
  const accepted = requirement()
  const required: PaymentRequired = { x402Version: 2, resource: { url: 'http://localhost:3000/api/article/x' }, accepts: [accepted] }

  const header = await signPayment(required, accepted)
  const payload = decodePaymentSignatureHeader(header)
  assert.deepEqual(payload.accepted, accepted)
  const authorization = (payload.payload as { authorization: { from: string; to: string; value: string } }).authorization
  assert.equal(authorization.from, expected.address)
  assert.equal(authorization.to, PAYEE)
  assert.equal(authorization.value, '10000')

  delete process.env.X402_AGENT_PRIVATE_KEY
  await assert.rejects(() => signPayment(required, accepted), /X402_AGENT_PRIVATE_KEY/)
})
