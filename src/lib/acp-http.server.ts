import { createHash } from 'node:crypto'
import { ACP_API_VERSION, AcpError } from './acp-session.server'

type Dict = Record<string, unknown>
type Result = { status: number; body: unknown }
type Cached = { hash: string; result?: Result }

const idempotency = ((globalThis as { __acpIdempotency?: Map<string, Cached> }).__acpIdempotency ??= new Map())

function errorResult(cause: unknown): Result {
  if (cause instanceof AcpError) {
    return {
      status: cause.status,
      body: { type: cause.type, code: cause.code, message: cause.message, ...(cause.param ? { param: cause.param } : {}) },
    }
  }
  console.error('ACP checkout failed', cause)
  return { status: 500, body: { type: 'processing_error', code: 'internal', message: '内部エラーが発生しました' } }
}

type Handler = (input: { origin: string; body: Dict }) => Promise<unknown>

// 認証・APIバージョン・冪等性(POST)を共通処理し、ACPのエラー形式で返す。
// 認証はPoCのため Bearer トークンの存在のみ確認する(ACP_API_KEY があれば一致も確認)。
export async function handleAcp(request: Request, run: Handler): Promise<Response> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  const requestId = request.headers.get('request-id')
  if (requestId) headers['request-id'] = requestId
  const respond = ({ status, body }: Result, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...headers, ...extra } })

  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  const apiKey = process.env.ACP_API_KEY
  if (!token || (apiKey && token !== apiKey)) {
    return respond({ status: 401, body: { type: 'invalid_request', code: 'unauthorized', message: 'Bearer トークンが必要です' } })
  }

  const version = request.headers.get('api-version')
  if (version !== ACP_API_VERSION) {
    return respond({
      status: 400,
      body: {
        type: 'invalid_request',
        code: 'unsupported_version',
        message: `API-Version は ${ACP_API_VERSION} のみ対応しています`,
        supported_versions: [ACP_API_VERSION],
      },
    })
  }

  const url = new URL(request.url)
  const input = { origin: url.origin, body: {} as Dict }

  if (request.method !== 'POST') {
    try {
      return respond({ status: 200, body: await run(input) })
    } catch (cause) {
      return respond(errorResult(cause))
    }
  }

  const key = request.headers.get('idempotency-key')
  if (key && key.length <= 255) headers['idempotency-key'] = key
  if (!key || key.length > 255) {
    return respond({
      status: 400,
      body: { type: 'invalid_request', code: 'idempotency_key_required', message: 'Idempotency-Key header is required (max 255 characters)' },
    })
  }

  const raw = await request.text()
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    input.body = parsed as Dict
  } catch {
    return respond({ status: 400, body: { type: 'invalid_request', code: 'invalid_json', message: 'リクエスト本文がJSONオブジェクトではありません' } })
  }

  // 同一キー・同一本文は結果を再送し、本文が違う場合や処理中は409にする。
  const cacheKey = `${token}|${url.pathname}|${key}`
  const hash = createHash('sha256').update(raw).digest('hex')
  const cached = idempotency.get(cacheKey)
  if (cached) {
    if (cached.hash !== hash) {
      return respond({ status: 422, body: { type: 'invalid_request', code: 'idempotency_conflict', message: 'Idempotency-Key has already been used with a different request body' } })
    }
    if (!cached.result) {
      return respond(
        { status: 409, body: { type: 'invalid_request', code: 'idempotency_in_flight', message: 'A request with this Idempotency-Key is currently being processed' } },
        { 'retry-after': '1' },
      )
    }
    return respond(cached.result, { 'idempotent-replayed': 'true' })
  }

  const entry: Cached = { hash }
  idempotency.set(cacheKey, entry)
  let result: Result
  try {
    result = { status: 200, body: await run(input) }
  } catch (cause) {
    result = errorResult(cause)
  }
  // 5xx は再試行できるようキャッシュしない。
  if (result.status >= 500) idempotency.delete(cacheKey)
  else entry.result = result
  return respond(result)
}
