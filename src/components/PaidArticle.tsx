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
    // 前回の試行で表示したエラーを消す。
    setError('')
    // 署名に必要なウォレット情報がなければ、接続を促して処理を中断する。
    if (!address || !walletClient) {
      setError('先にページ上部からウォレットを接続してください。')
      return
    }
    // EIP-712署名のチェーンと決済先ネットワークをBase Sepoliaに揃える。
    if (chainId !== baseSepolia.id) {
      setError('署名する前にBase Sepoliaへ切り替えてください。')
      return
    }

    // ボタンを処理中表示にして、連続操作を防ぐ。
    setIsPaying(true)
    try {
      // wagmiのウォレットクライアントをx402が使う署名者形式に変換する。
      const signer = toClientEvmSigner({
        address,
        // x402から受け取ったEIP-712データをウォレットに渡し、署名結果を返す。
        signTypedData: (typedData) => walletClient.signTypedData({
          ...typedData,
          account: address,
        } as never),
      })
      // Base Sepoliaのexact決済方式に、このウォレット署名者を登録する。
      const client = new x402Client().register(
        BASE_SEPOLIA_NETWORK,
        // ExactEvmSchemeは、EVM系ネットワーク向けのx402「定額決済方式」を実装するクラス
        // ExactEvmSchemeは支払い要求を受け取ると、EIP-3009の署名に必要なデータを組み立て、渡されたsigner.signTypedDataを呼び出します
        new ExactEvmScheme(signer),
      )
      // 402応答を受けた際にx402が署名と支払い付き再送を行うfetchを作る。
      const fetchWithPayment = wrapFetchWithPayment(fetch, client)
      // 記事APIを呼び出す。payToはこのウォレット自身に指定する。
      const response = await fetchWithPayment(
        `/api/article/${article.slug}?payTo=${encodeURIComponent(address)}`,
      )
      // API応答をJSONとして読み取る。
      const result = await response.json()
      // HTTPエラーならAPIが返した内容を表示用の例外にする。
      if (!response.ok) throw new Error(result.error || '決済に失敗しました。')
      // 成功応答に取引ハッシュがなければ、決済完了として扱わない。
      if (!result.transaction) throw new Error('決済応答に取引ハッシュがありません。')
      // 決済済みの記事本文と取引情報を画面に反映する。
      setContent(result as PaidContent)
    } catch (cause) {
      // 署名拒否や通信・決済エラーを画面に表示する。
      setError(cause instanceof Error ? cause.message : '決済に失敗しました。もう一度お試しください。')
    } finally {
      // 成功・失敗のどちらでも処理中表示を解除する。
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
