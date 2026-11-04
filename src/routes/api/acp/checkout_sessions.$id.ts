import { createFileRoute } from '@tanstack/react-router'
import { handleAcp } from '../../../lib/acp-http.server'
import { getSession, updateSession } from '../../../lib/acp-session.server'

// ACP: セッションの取得(GET)と更新(POST)
export const Route = createFileRoute('/api/acp/checkout_sessions/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleAcp(request, ({ origin }) => getSession(params.id, origin)),
      POST: ({ request, params }) => handleAcp(request, ({ body, origin }) => updateSession(params.id, body, origin)),
    },
  },
})
