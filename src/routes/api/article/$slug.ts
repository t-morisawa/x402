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
          const paymentServer = await getPaymentServer()
          const context = createRequestContext(request, params.slug)
          const payment = await paymentServer.processHTTPRequest(context)

          if (payment.type === 'payment-error') {
            const { status, headers, body, isHtml } = payment.response
            const responseHeaders = new Headers(headers)
            responseHeaders.set('content-type', isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8')
            return new Response(isHtml ? String(body ?? '') : JSON.stringify(body ?? {}), {
              status,
              headers: responseHeaders,
            })
          }

          if (payment.type !== 'payment-verified') {
            return Response.json({ error: '支払い要件を処理できませんでした' }, { status: 500 })
          }

          const settlement = await paymentServer.processSettlement(
            payment.paymentPayload,
            payment.paymentRequirements,
            payment.declaredExtensions,
          )
          if (!settlement.success) {
            const responseHeaders = new Headers(settlement.response.headers)
            responseHeaders.set('content-type', 'application/json; charset=utf-8')
            return new Response(JSON.stringify(settlement.response.body ?? { error: settlement.errorMessage }), {
              status: settlement.response.status,
              headers: responseHeaders,
            })
          }

          const body = getArticleBody(params.slug)
          if (!body) return Response.json({ error: '記事本文が見つかりません' }, { status: 404 })

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
          console.error('x402 article payment failed', error)
          return Response.json(
            { error: error instanceof Error ? error.message : '決済の処理に失敗しました' },
            { status: 502 },
          )
        }
      },
    },
  },
})
