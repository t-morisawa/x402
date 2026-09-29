import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Providers } from '../components/Providers'
import { WalletControls } from '../components/WalletControls'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Signal Journal — ネットの新しい声を読む' },
      { name: 'description', content: '小さな決済で読める、テクノロジーとカルチャーのニュース。' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }, { rel: 'preconnect', href: 'https://fonts.googleapis.com' }, { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' }, { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Noto+Serif+JP:wght@400;500;600;700&display=swap' }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
})

function RootLayout() {
  return (
    <Providers>
      <div className="site-shell">
        <header className="site-header">
          <Link to="/" className="wordmark"><span className="wordmark-icon">s.</span><span>SIGNAL<span className="wordmark-light">/JOURNAL</span></span></Link>
          <nav className="header-nav"><Link to="/" activeOptions={{ exact: true }}>最新記事</Link><a href="#about">このメディアについて</a></nav>
          <WalletControls />
        </header>
        <main><Outlet /></main>
        <footer className="site-footer" id="about">
          <Link to="/" className="footer-mark">SIGNAL / JOURNAL</Link>
          <p>読むことから、ウェブの未来を考える。</p>
          <span>PAY PER STORY · BASE SEPOLIA</span>
        </footer>
      </div>
    </Providers>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  )
}
