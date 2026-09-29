import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import type { HTTPRequestContext, RouteConfig } from '@x402/core/http'
import { isAddress } from 'viem'
import { articles } from '../data/articles'

import { ARTICLE_PRICE_UNITS, BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from './payment-config'

function resolvePayTo(context: HTTPRequestContext) {
  const configuredPayTo = process.env.X402_PAY_TO?.trim()
  if (configuredPayTo) {
    if (!isAddress(configuredPayTo)) {
      throw new Error('X402_PAY_TO must be a valid EVM address')
    }
    return configuredPayTo
  }

  const requestedPayTo = context.adapter.getQueryParam?.('payTo')
  const address = Array.isArray(requestedPayTo) ? requestedPayTo[0] : requestedPayTo
  if (!address || !isAddress(address)) {
    throw new Error('A valid payTo wallet address is required for self-payment mode')
  }
  return address
}

function createPaymentServer() {
  const routes: Record<string, RouteConfig> = Object.fromEntries(
    articles.map(({ slug, title }) => [
      `GET /api/article/${slug}`,
      {
        accepts: {
          scheme: 'exact',
          network: BASE_SEPOLIA_NETWORK,
          payTo: resolvePayTo,
          price: { asset: BASE_SEPOLIA_USDC, amount: ARTICLE_PRICE_UNITS },
        },
        description: `有料記事: ${title}`,
        mimeType: 'application/json',
        serviceName: 'Signal Journal',
      },
    ]),
  )

  const facilitator = new HTTPFacilitatorClient({
    url: process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator',
  })
  const resourceServer = new x402ResourceServer(facilitator).register(
    BASE_SEPOLIA_NETWORK,
    new ExactEvmScheme(),
  )

  return new x402HTTPResourceServer(resourceServer, routes)
}

let paymentServer: ReturnType<typeof createPaymentServer> | undefined
let initializePromise: Promise<void> | undefined

export async function getPaymentServer() {
  paymentServer ??= createPaymentServer()
  initializePromise ??= paymentServer.initialize()
  await initializePromise
  return paymentServer
}

export function createRequestContext(request: Request, slug: string): HTTPRequestContext {
  const url = new URL(request.url)
  const adapter = {
    getHeader: (name: string) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => request.headers.get('accept') ?? '',
    getUserAgent: () => request.headers.get('user-agent') ?? '',
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.getAll(name).length > 1
      ? url.searchParams.getAll(name)
      : url.searchParams.get(name) ?? undefined,
  }

  return {
    adapter,
    path: `/api/article/${slug}`,
    method: request.method,
    paymentHeader: request.headers.get('payment-signature') ?? request.headers.get('x-payment') ?? undefined,
  }
}
