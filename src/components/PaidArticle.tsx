import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { wrapFetchWithPayment, x402Client } from '@x402/fetch'
import { baseSepolia } from 'wagmi/chains'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import type { Article } from '../data/articles'
import { BASE_SEPOLIA_NETWORK } from '../lib/payment-config'

type PaidContent = {
  body: string[]
  transaction: string
  payer: string
}

export function PaidArticle({ article }: { article: Article }) {
  const { address, chainId, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [content, setContent] = useState<PaidContent | null>(null)
  const [error, setError] = useState('')
  const [isPaying, setIsPaying] = useState(false)

  async function unlockArticle() {
    setError('')
    if (!address || !walletClient) {
      setError('先にページ上部からウォレットを接続してください。')
      return
    }
    if (chainId !== baseSepolia.id) {
      setError('署名する前にBase Sepoliaへ切り替えてください。')
      return
    }

    setIsPaying(true)
    try {
      const signer = toClientEvmSigner({
        address,
        signTypedData: (typedData) => walletClient.signTypedData({
          ...typedData,
          account: address,
        } as never),
      })
      const client = new x402Client().register(
        BASE_SEPOLIA_NETWORK,
        new ExactEvmScheme(signer),
      )
      const fetchWithPayment = wrapFetchWithPayment(fetch, client)
      const response = await fetchWithPayment(
        `/api/article/${article.slug}?payTo=${encodeURIComponent(address)}`,
      )
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '決済に失敗しました。')
      if (!result.transaction) throw new Error('決済応答に取引ハッシュがありません。')
      setContent(result as PaidContent)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '決済に失敗しました。もう一度お試しください。')
    } finally {
      setIsPaying(false)
    }
  }

  return (
    <section className="paywall-panel">
      {!content ? (
        <>
          <div className="locked-preview" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </div>
          <div className="paywall-content">
            <div className="lock-icon"><span>↗</span></div>
            <p className="eyebrow">ONE STORY. YOURS TO KEEP.</p>
            <h2>この記事の続きを読む</h2>
            <p className="paywall-description">記事本文はBase Sepolia上の決済後に表示されます。購入後はいつでもこのページで読み返せます。</p>
            {!isConnected ? (
              <p className="paywall-hint">ページ上部からウォレットを接続してください。</p>
            ) : chainId !== baseSepolia.id ? (
              <button className="button button-dark purchase-button" disabled={isSwitching} onClick={() => switchChain({ chainId: baseSepolia.id })}>
                {isSwitching ? '切り替えています…' : 'Base Sepolia に切り替える'}
              </button>
            ) : (
              <button className="button button-dark purchase-button" disabled={isPaying} onClick={unlockArticle}>
                {isPaying ? <><span className="spinner" /> ウォレットで署名中…</> : <>0.01 USDC で読む <span>↗</span></>}
              </button>
            )}
            {isPaying && <p className="paywall-hint">ウォレットで署名を承認してください。ガス代は不要です。</p>}
            {error && <p className="payment-error" role="alert">{error}</p>}
            <div className="payment-details"><span>BASE SEPOLIA</span><span>USDC · EIP-3009</span><span>GASLESS SIGNATURE</span></div>
          </div>
        </>
      ) : (
        <div className="unlocked-article">
          <div className="unlocked-heading">
            <span className="unlocked-label"><span className="online-dot" /> PAYMENT SETTLED</span>
            <a href={`https://sepolia.basescan.org/tx/${content.transaction}`} target="_blank" rel="noreferrer" className="transaction-link">
              BaseScanで取引を確認 <span>↗</span>
            </a>
          </div>
          <div className="article-body">
            {content.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          </div>
          <div className="receipt"><span>TX HASH</span><code>{content.transaction}</code><a href={`https://sepolia.basescan.org/tx/${content.transaction}`} target="_blank" rel="noreferrer">EXPLORER ↗</a></div>
        </div>
      )}
      <Link className="paywall-backlink" to="/">← 記事一覧に戻る</Link>
    </section>
  )
}
