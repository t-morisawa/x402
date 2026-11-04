import { createFileRoute } from '@tanstack/react-router'
import { handleAcp } from '../../../lib/acp-http.server'
import { cancelSession } from '../../../lib/acp-session.server'

// ACP: セッションのキャンセル
export const Route = createFileRoute('/api/acp/checkout_sessions/$id/cancel')({
  server: {
    handlers: {
      POST: ({ request, params }) => handleAcp(request, ({ origin }) => cancelSession(params.id, origin)),
    },
  },
})
