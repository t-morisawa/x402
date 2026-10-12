import { randomUUID } from 'node:crypto'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from '../../src/lib/payment-config.ts'
import { ADDRESS_PATTERN, MAX_PRICE_UNITS, QUOTE_TTL_MS, USDC_DECIMALS } from './config.ts'

export type Quote = {
  quoteId: string
  url: string
  requirement: PaymentRequirements
  description: string
  expiresAt: number
}

/** USDCの最小単位 (6 decimals) を、画面表示用の十進表記へ変換する。 */
export function formatUsdc(amount: string) {
  const value = BigInt(amount)
  const unit = 10n ** BigInt(USDC_DECIMALS)
  const fraction = (value % unit).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${value / unit}.${fraction}` : (value / unit).toString()
}

/** 支払い条件から、許可ポリシーに合う最安のBase Sepolia USDC exact条件を選ぶ。 */
export function selectAllowedRequirement(required: PaymentRequired) {
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

/** 二つのpayment requirementが同一条件か、金額・宛先等を含めて比較する。 */
export function sameRequirement(a: PaymentRequirements, b: PaymentRequirements) {
  return a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase() &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    JSON.stringify(a.extra) === JSON.stringify(b.extra)
}

/** quote IDに対応する有効な一時quoteを取得し、URLと有効期限を検証する。 */
export function getQuote(quotes: Map<string, Quote>, quoteId: string, url: string) {
  const quote = quotes.get(quoteId)
  if (!quote || quote.url !== url || quote.expiresAt <= Date.now()) {
    quotes.delete(quoteId)
    throw new Error('Quote not found or expired. Inspect the URL again before purchasing.')
  }
  return quote
}

/** 承認画面に渡すchallengeを、ポリシーで選んだ支払い条件だけに絞る。 */
export function paymentRequiredForApproval(required: PaymentRequired, requirement: PaymentRequirements): PaymentRequired {
  return { ...required, accepts: [requirement] }
}

/** resource情報と支払条件が、利用者が確認したquoteから変わっていないか確認する。 */
export function challengeMatchesQuote(
  challenge: { required: PaymentRequired; requirement: PaymentRequirements },
  quote: Quote,
) {
  return sameRequirement(challenge.requirement, quote.requirement) &&
    challenge.required.resource.url === quote.url &&
    (challenge.required.resource.description || quote.url) === quote.description
}

/** ウォレット署名の支払条件とresource URLが、利用者に提示したquoteに一致するか検証する。 */
export function assertPayloadMatchesQuote(payload: PaymentPayload, quote: Quote) {
  if (!sameRequirement(payload.accepted, quote.requirement)) {
    throw new Error('Wallet signature does not match the inspected quote')
  }
  if (payload.resource?.url && payload.resource.url !== quote.url) {
    throw new Error('Wallet signature is bound to a different resource URL')
  }
}

export function createQuote(options: Omit<Quote, 'quoteId' | 'expiresAt'>): Quote {
  return {
    ...options,
    quoteId: randomUUID(),
    expiresAt: Date.now() + QUOTE_TTL_MS,
  }
}
