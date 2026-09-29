import { createFileRoute } from '@tanstack/react-router'
import { findArticle } from '../../../data/articles'
import { getArticleBody } from '../../../data/article-bodies.server'
import { createRequestContext, getPaymentServer } from '../../../lib/payment.server'

export const Route = createFileRoute('/api/article/$slug')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const article = findArticle(params.slug)
        if (!article) return Response.json({ error: '記事が見つかりません' }, { status: 404 })

        if (!process.env.X402_PAY_TO && !new URL(request.url).searchParams.get('payTo')) {
          return Response.json(
            { error: '自己送金モードではウォレットアドレスが必要です。接続してから再度お試しください。' },
            { status: 400 },
          )
        }

        try {
          // facilitatorとExact EVMスキームを使う支払いサーバーを取得する。
          const paymentServer = await getPaymentServer()
          // Webリクエストをx402サーバーが扱う形式に変換する。
          const context = createRequestContext(request, params.slug)
          // 支払い要求を判定し、未払いなら402応答、支払い付きなら検証結果を返す。
          const payment = await paymentServer.processHTTPRequest(context)

          // x402が作った支払いエラー応答（未払い時の402など）を返す。
          if (payment.type === 'payment-error') {
            // x402応答からステータス、ヘッダー、本文を取り出す。
            const { status, headers, body, isHtml } = payment.response
            // x402応答のヘッダーを変更可能な形式にする。
            const responseHeaders = new Headers(headers)
            // 本文の形式に合わせてContent-Typeを設定する。
            responseHeaders.set('content-type', isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8')
            // x402が指定したステータスとヘッダーでHTTP応答を返す。
            return new Response(isHtml ? String(body ?? '') : JSON.stringify(body ?? {}), {
              status,
              headers: responseHeaders,
            })
          }

          // 支払い検証済み以外の予期しない結果はサーバーエラーにする。
          if (payment.type !== 'payment-verified') {
            return Response.json({ error: '支払い要件を処理できませんでした' }, { status: 500 })
          }

          // 検証済みの署名と支払い条件をfacilitatorに渡して決済を実行する。
          const settlement = await paymentServer.processSettlement(
            payment.paymentPayload,
            payment.paymentRequirements,
            payment.declaredExtensions,
          )
          // facilitatorでの決済に失敗した場合、その応答をクライアントへ返す。
          if (!settlement.success) {
            // facilitator応答のヘッダーを変更可能な形式にする。
            const responseHeaders = new Headers(settlement.response.headers)
            // 決済失敗の本文をJSONとして扱うよう指定する。
            responseHeaders.set('content-type', 'application/json; charset=utf-8')
            // facilitatorのエラー本文、ステータス、ヘッダーを維持して返す。
            return new Response(JSON.stringify(settlement.response.body ?? { error: settlement.errorMessage }), {
              status: settlement.response.status,
              headers: responseHeaders,
            })
          }

          // 決済成功後に記事本文を取得する。
          const body = getArticleBody(params.slug)
          // 本文がなければ記事データの不整合として404を返す。
          if (!body) return Response.json({ error: '記事本文が見つかりません' }, { status: 404 })

          // 記事本文と決済結果をJSONで返し、キャッシュを禁止する。
          return Response.json(
            {
              slug: article.slug,
              title: article.title,
              body,
              transaction: settlement.transaction,
              network: settlement.network,
              payer: settlement.payer,
              amount: settlement.amount,
            },
            { headers: { ...settlement.headers, 'cache-control': 'no-store' } },
          )
        } catch (error) {
          // 予期しない例外をサーバーログに記録する。
          console.error('x402 article payment failed', error)
          // エラー内容をJSONで返し、HTTP 502にする。
          return Response.json(
            { error: error instanceof Error ? error.message : '決済の処理に失敗しました' },
            { status: 502 },
          )
        }
      },
    },
  },
})
