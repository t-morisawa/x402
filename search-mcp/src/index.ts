import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { articles } from '../../src/data/articles.ts'

if (existsSync(resolve(process.cwd(), '.env'))) {
  process.loadEnvFile(resolve(process.cwd(), '.env'))
}

const defaultBaseUrl = process.env.X402_DEMO_URL?.trim() || 'http://localhost:3000'
const baseUrl = new URL(defaultBaseUrl)
if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
  throw new Error('X402_DEMO_URL must be an HTTP(S) URL without credentials')
}

const ignoredTerms = new Set([
  '記事', '探して', '検索', '価格', '確認', '購入', '要約', 'する', 'して', '読んで',
  'article', 'articles', '2026', 'the', 'for', 'and', 'with',
])
const searchAliases: Record<string, string[]> = {
  'ai-agents-economy': [
    'mechanism of AI agents buying things themselves',
    'agentic commerce',
    'AI agent shopping',
    'autonomous agents making purchases',
  ],
  'stablecoin-everyday': ['stablecoins', 'digital dollars', 'payments'],
  'web-micropayments': ['pay per article', 'web micropayments', 'online journalism'],
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

const server = new McpServer({ name: 'mocksearch', version: '1.0.0' })

server.registerTool(
  'search_web',
  {
    title: 'Search the web (mock)',
    description: 'Search a small mock web index. Returns article titles, snippets and URLs only; it does not inspect payment requirements or fetch article bodies.',
    inputSchema: { query: z.string().trim().min(1).max(200) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query }) => {
    const terms = query.toLocaleLowerCase('ja')
      .split(/[\s、。,.!?！？「」『』はをがにでとからのへや]/u)
      .filter((term) => term.length >= 2 && !ignoredTerms.has(term))
    const matches = articles
      .map((article) => {
        const aliases = searchAliases[article.slug] ?? []
        const searchable = `${article.title}\n${article.lead}\n${article.category}\n${aliases.join('\n')}`.toLocaleLowerCase('ja')
        const score = terms.filter((term) => searchable.includes(term)).length
        return { article, score }
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ article }) => ({
        title: article.title,
        snippet: article.lead,
        url: new URL(`/api/article/${encodeURIComponent(article.slug)}`, baseUrl).toString(),
      }))

    return result(matches)
  },
)

await server.connect(new StdioServerTransport())
console.error('Mock web search MCP connected over stdio')
