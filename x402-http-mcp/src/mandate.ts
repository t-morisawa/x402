import { randomUUID } from 'node:crypto'
import type { PaymentRequirements } from '@x402/core/types'
import { recoverTypedDataAddress } from 'viem'
import { BASE_SEPOLIA_USDC } from '../../src/lib/payment-config.ts'
import { mandateTypedData, type MandateTerms } from '../../src/lib/mandate.ts'
import {
  ADDRESS_PATTERN,
  MAX_MANDATE_BUDGET_UNITS,
  MAX_MANDATE_TTL_MS,
  MAX_PRICE_UNITS,
  USDC_DECIMALS,
} from './config.ts'

export type Receipt = {
  at: string
  sessionId: string
  orderId?: string
  transaction: string
  amount: string
  payTo: string
  payer?: string
}

export type Mandate = {
  terms: MandateTerms
  user: string
  signature: string
  spent: bigint
  revoked: boolean
  receipts: Receipt[]
}

// 許可証は1つだけ、MCPプロセスのメモリに持つ。
let active: Mandate | undefined

/** "0.05" のような十進表記をUSDC最小単位へ変換する。 */
export function parseUsdc(value: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!match) throw new Error(`Invalid USDC amount: ${value}`)
  return BigInt(match[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'))
}

/** 入力を検証して署名前の許可証termsを作る。上限はコード側の固定ポリシーを超えられない。 */
export function createTerms(options: {
  agent: string
  payees: string[]
  maxPerPurchase: string
  budget: string
  ttlMinutes: number
  now?: number
}): MandateTerms {
  const maxPerPurchase = parseUsdc(options.maxPerPurchase)
  const budget = parseUsdc(options.budget)
  if (options.payees.length === 0 || !options.payees.every((payee) => ADDRESS_PATTERN.test(payee))) {
    throw new Error('payees must be a non-empty list of EVM addresses')
  }
  if (maxPerPurchase <= 0n || maxPerPurchase > MAX_PRICE_UNITS) {
    throw new Error('maxPerPurchase must be above 0 and at most the per-purchase policy limit')
  }
  if (budget < maxPerPurchase || budget > MAX_MANDATE_BUDGET_UNITS) {
    throw new Error('budget must be at least maxPerPurchase and at most the mandate budget limit')
  }
  const ttlMs = options.ttlMinutes * 60_000
  if (!(ttlMs > 0) || ttlMs > MAX_MANDATE_TTL_MS) throw new Error('ttlMinutes must be between 1 and 1440')
  return {
    mandateId: randomUUID(),
    agent: options.agent,
    asset: BASE_SEPOLIA_USDC,
    payees: [...new Set(options.payees.map((payee) => payee.toLowerCase()))],
    maxPerPurchase: maxPerPurchase.toString(),
    budget: budget.toString(),
    expiresAt: Math.floor(((options.now ?? Date.now()) + ttlMs) / 1000),
  }
}

/** 署名からユーザのアドレスを復元する。 */
export async function recoverMandateSigner(terms: MandateTerms, signature: string) {
  return recoverTypedDataAddress({ ...mandateTypedData(terms), signature: signature as `0x${string}` } as never)
}

export function getActiveMandate(now = Date.now()) {
  if (active && (active.revoked || active.terms.expiresAt * 1000 <= now)) return undefined
  return active
}

/** 署名済みの許可証を登録する。有効な許可証が残っている間は新しく登録できない。 */
export async function registerMandate(terms: MandateTerms, signature: string, now = Date.now()) {
  if (getActiveMandate(now)) throw new Error('An active mandate already exists. Revoke it before creating a new one.')
  const user = await recoverMandateSigner(terms, signature)
  active = { terms, user, signature, spent: 0n, revoked: false, receipts: [] }
  return active
}

export function revokeMandate() {
  if (active) active.revoked = true
}

/** 支払い条件が許可証の範囲内か検査する。範囲外なら理由つきで例外にする。 */
export function checkAutoPay(mandate: Mandate, requirement: PaymentRequirements, now = Date.now()) {
  const { terms } = mandate
  if (mandate.revoked) throw new Error('The mandate was revoked')
  if (terms.expiresAt * 1000 <= now) throw new Error('The mandate has expired')
  if (requirement.asset.toLowerCase() !== terms.asset.toLowerCase()) throw new Error('Asset is outside the mandate')
  if (!terms.payees.includes(requirement.payTo.toLowerCase())) throw new Error('Payee is not in the mandate')
  const amount = BigInt(requirement.amount)
  if (amount > BigInt(terms.maxPerPurchase)) throw new Error('Amount exceeds the per-purchase limit of the mandate')
  if (mandate.spent + amount > BigInt(terms.budget)) throw new Error('Amount exceeds the remaining budget of the mandate')
}

/** 署名前に予算を確保し、同時実行でも予算を超えないようにする。 */
export function reserve(mandate: Mandate, amount: bigint) {
  mandate.spent += amount
}

export function release(mandate: Mandate, amount: bigint) {
  mandate.spent -= amount
}

export function summarizeMandate(mandate: Mandate) {
  const { terms } = mandate
  const remaining = BigInt(terms.budget) - mandate.spent
  return {
    mandateId: terms.mandateId,
    user: mandate.user,
    agent: terms.agent,
    payees: terms.payees,
    maxPerPurchaseUnits: terms.maxPerPurchase,
    budgetUnits: terms.budget,
    spentUnits: mandate.spent.toString(),
    remainingUnits: remaining.toString(),
    expiresAt: new Date(terms.expiresAt * 1000).toISOString(),
    revoked: mandate.revoked,
    receipts: mandate.receipts,
  }
}
