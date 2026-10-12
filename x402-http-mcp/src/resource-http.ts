import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentRequired, SettleResponse } from '@x402/core/types'
import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from './config.ts'
import { selectAllowedRequirement } from './payment-policy.ts'

const x402HttpClient = new x402HTTPClient(new x402Client())

/** HTTP response bodyをストリームで読み、上限サイズを超えた場合は中断する。 */
export async function readLimitedBody(response: Response) {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`HTTP response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** レスポンス本文をJSONとして解釈する。空本文やJSON以外はundefinedを返す。 */
export function parseJsonBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 許可したJSONまたはtext/plain本文を解析し、その他のcontent typeを拒否する。 */
export function parseResourceBody(text: string, contentType: string): unknown {
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Resource declared JSON but returned invalid JSON')
    }
  }
  if (contentType.startsWith('text/plain')) return text
  throw new Error(`Unsupported resource content type: ${contentType || '(missing)'}`)
}

/** GETを行い、redirectを拒否して制限サイズ内の応答を返す。 */
export async function requestResource(url: string, paymentHeader?: string) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain',
      ...(paymentHeader ? { 'PAYMENT-SIGNATURE': paymentHeader } : {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new Error('Redirects are not allowed for x402 resources')
  }
  const text = await readLimitedBody(response)
  return { response, text, json: parseJsonBody(text) }
}

/** HTTP responseのヘッダーと本文からx402のPaymentRequiredをデコードする。 */
export function parsePaymentRequired(response: Response, body: unknown): PaymentRequired {
  return x402HttpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body)
}

/** 支払い済みHTTP responseからsettlement receiptをデコードする。 */
export function parsePaymentSettleResponse(response: Response): SettleResponse {
  return x402HttpClient.getPaymentSettleResponse((name) => response.headers.get(name))
}

/** URLへ未署名GETし、402 challengeと許可対象のpayment requirementを取得する。 */
export async function getChallenge(url: string) {
  const { response, json } = await requestResource(url)
  if (response.status !== 402) {
    throw new Error(`Expected an x402 HTTP 402 challenge; received ${response.status}`)
  }
  const required = parsePaymentRequired(response, json)
  return { required, requirement: selectAllowedRequirement(required) }
}
