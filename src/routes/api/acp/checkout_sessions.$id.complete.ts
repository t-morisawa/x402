import { createFileRoute } from '@tanstack/react-router'
import { handleAcp } from '../../../lib/acp-http.server'
import { completeSession } from '../../../lib/acp-session.server'

// ACP: x402の署名を受け取り、決済を確定する
export const Route = createFileRoute('/api/acp/checkout_sessions/$id/complete')({
  server: {
    handlers: {
      POST: ({ request, params }) => handleAcp(request, ({ body, origin }) => completeSession(params.id, body, origin)),
    },
  },
})
