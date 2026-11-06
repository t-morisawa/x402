import { BASE_SEPOLIA_USDC } from './payment-config.ts'

// AP2の Open mandate に着想を得た独自の許可証。仕様準拠ではない(SD-JWT/VCは使わない)。
// 人がウォレットでEIP-712署名し、エージェントはその範囲内でだけ自動決済する。
export const MANDATE_DOMAIN = { name: 'x402 Demo Mandate', version: '1', chainId: 84532 } as const

export const MANDATE_TYPES = {
  OpenMandate: [
    { name: 'mandateId', type: 'string' },
    { name: 'agent', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'payees', type: 'address[]' },
    { name: 'maxPerPurchase', type: 'uint256' },
    { name: 'budget', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const

/** 金額はUSDC最小単位(6桁)の整数文字列、expiresAtはUnix秒。 */
export type MandateTerms = {
  mandateId: string
  agent: string
  asset: string
  payees: string[]
  maxPerPurchase: string
  budget: string
  expiresAt: number
}

export function mandateTypedData(terms: MandateTerms) {
  return {
    domain: MANDATE_DOMAIN,
    types: MANDATE_TYPES,
    primaryType: 'OpenMandate' as const,
    message: {
      ...terms,
      maxPerPurchase: BigInt(terms.maxPerPurchase),
      budget: BigInt(terms.budget),
      expiresAt: BigInt(terms.expiresAt),
    },
  }
}

/** 署名画面へURLで渡すため、termsをbase64url化する。 */
export function encodeMandateTerms(terms: MandateTerms) {
  const bytes = new TextEncoder().encode(JSON.stringify(terms))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeMandateTerms(encoded: string): MandateTerms {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const terms = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as MandateTerms
  if (terms.asset.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) throw new Error('許可証のassetがBase Sepolia USDCではありません')
  return terms
}
