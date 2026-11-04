import { createFileRoute } from '@tanstack/react-router'
import { handleAcp } from '../../../lib/acp-http.server'
import { createSession } from '../../../lib/acp-session.server'

// ACP: チェックアウトセッションの作成
export const Route = createFileRoute('/api/acp/checkout_sessions')({
  server: {
    handlers: {
      POST: ({ request }) => handleAcp(request, ({ body, origin }) => createSession(body, origin)),
    },
  },
})
