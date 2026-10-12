import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { PaymentPayload } from '@x402/core/types'

// ウォレット画面の操作が終わるまで、ローカルcallbackを最大3分待つ。
const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024

type ApprovalResult =
  | { status: 'approved'; quoteId: string; paymentHeader: string }
  | { status: 'rejected'; quoteId: string }

/**
 * 承認画面のURLを既定のブラウザーで開く。
 * ブラウザープロセスはMCP処理から切り離し、起動した時点で呼び出し元へ戻る。
 */
async function launchBrowser(url: string) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * ローカルのウォレット承認画面を開き、承認・拒否の結果を待ち受ける。
 *
 * 127.0.0.1だけで一時HTTPサーバーを起動し、信頼したUI originと一回限りのnonceを確認したcallbackだけを受け付ける。
 * 承認時は署名済みPAYMENT-SIGNATUREヘッダーを返し、拒否・タイムアウト時はその状態を返す。
 * ここでは支払いを送信せず、署名payloadを呼び出し元へ渡すだけ。
 */
export async function requestWalletApproval(options: {
  approvalPageUrl: string
  uiOrigin: string
  quoteId: string
}): Promise<ApprovalResult> {
  const nonce = randomBytes(24).toString('hex')
  let settled = false
  let resolveResult: (result: ApprovalResult) => void
  let rejectResult: (error: Error) => void

  const resultPromise = new Promise<ApprovalResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const callbackUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const corsOrigin = request.headers.origin

    if (corsOrigin !== options.uiOrigin) {
      response.writeHead(403).end('Origin not allowed')
      return
    }

    response.setHeader('Access-Control-Allow-Origin', options.uiOrigin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }

    if (request.method !== 'POST' || callbackUrl.pathname !== `/callback/${nonce}` || settled) {
      response.writeHead(404).end('Not found')
      return
    }

    let rawBody = ''
    let bodyTooLarge = false
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      rawBody += chunk
      if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) bodyTooLarge = true
    })
    request.on('end', () => {
      if (bodyTooLarge) {
        response.writeHead(413).end('Payload too large')
        return
      }

      try {
        const body = JSON.parse(rawBody) as Record<string, unknown>
        if (body.quoteId !== options.quoteId) throw new Error('Quote mismatch')

        if (body.status === 'rejected') {
          settled = true
          response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
          // promiseを返して待機中だった処理を進める
          resolveResult({ status: 'rejected', quoteId: options.quoteId })
          return
        }

        if (body.status !== 'approved' || typeof body.paymentHeader !== 'string' || body.paymentHeader.length > MAX_BODY_BYTES) {
          throw new Error('Invalid approval response')
        }

        settled = true
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        // promiseを返して待機中だった処理を進める
        resolveResult({
          status: 'approved',
          quoteId: options.quoteId,
          paymentHeader: body.paymentHeader,
        })
      } catch {
        response.writeHead(400).end('Invalid approval response')
      }
    })
  })

  server.on('error', (error) => rejectResult(error))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not start local wallet approval callback')
  }

  const callbackUrl = `http://127.0.0.1:${address.port}/callback/${nonce}`
  const approvalUrl = new URL(options.approvalPageUrl)
  approvalUrl.searchParams.set('callbackUrl', callbackUrl)
  approvalUrl.searchParams.set('quoteId', options.quoteId)
  approvalUrl.searchParams.set('nonce', nonce)

  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    rejectResult(new Error('Wallet approval timed out'))
  }, CALLBACK_TIMEOUT_MS)

  try {
    await launchBrowser(approvalUrl.toString())
    // ここでユーザの入力を待機（コールバックでpromiseを解決）
    return await resultPromise
  } finally {
    clearTimeout(timeout)
    server.close()
  }
}

/**
 * 外部から受け取った値がx402 v2 PaymentPayloadの最低限の形を満たすか検証する。
 * trueの場合はTypeScript上でもPaymentPayloadとして扱えるよう型を絞り込む。
 */
export function isPaymentPayload(value: unknown): value is PaymentPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<PaymentPayload>
  const accepted = payload.accepted
  return Boolean(
    payload.x402Version === 2 &&
    accepted && typeof accepted === 'object' &&
    typeof accepted.scheme === 'string' &&
    typeof accepted.network === 'string' &&
    typeof accepted.amount === 'string' &&
    typeof accepted.asset === 'string' &&
    typeof accepted.payTo === 'string' &&
    payload.payload && typeof payload.payload === 'object',
  )
}
