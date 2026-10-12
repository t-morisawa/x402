import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_DEMO_URL = 'http://localhost:3000'
export const QUOTE_TTL_MS = 2 * 60 * 1000
export const REQUEST_TIMEOUT_MS = 15_000
export const MAX_RESPONSE_BYTES = 1_000_000
export const MAX_PRICE_UNITS = 100_000n // 0.10 USDC (6 decimals)
export const USDC_DECIMALS = 6
export const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

if (existsSync(resolve(process.cwd(), '.env'))) {
  process.loadEnvFile(resolve(process.cwd(), '.env'))
}

/** デモ画面と検索結果のURLを作る、ローカルSignal JournalのベースURLを取得する。 */
export function getDemoUrl() {
  const url = new URL(process.env.X402_DEMO_URL || DEFAULT_DEMO_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('X402_DEMO_URL must be an HTTP(S) URL without credentials')
  }
  return url
}

/**
 * 汎用x402 MCPからアクセス可能なorigin一覧を取得する。
 * 未指定の場合はデモサーバー自身のoriginだけを許可する。
 */
export function getAllowedOrigins() {
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

/** URL形式とorigin allowlistを検証し、fragmentを除いたURLを返す。 */
export function validateResourceUrl(rawUrl: string) {
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
