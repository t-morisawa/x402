import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { x402Client, x402HTTPClient } from '@x402/fetch'
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { baseSepolia } from 'wagmi/chains'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import type { Article } from '../data/articles'
import { BASE_SEPOLIA_NETWORK } from '../lib/payment-config'

type PaidContent = {
  body: string[]
  transaction: string
  payer: string
}

// ACP checkout APIを呼ぶ。エラー時はACPのmessageを例外にする。
async function acpFetch(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer demo',
      'API-Version': '2026-04-17',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message || '決済に失敗しました。')
  return result
}

export function PaidArticle({ article }: { article: Article }) {
  // 接続中のウォレットの情報を取得
  const { address, chainId, isConnected } = useAccount()
  // walletClientを初期化してウォレットに接続
  const { data: walletClient } = useWalletClient()
  // 接続中ウォレットのネットワーク切り替え機能の初期化
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
      const httpClient = new x402HTTPClient(client)

      // 1. ACPのチェックアウトセッションを作る。自己送金モード(X402_PAY_TO未設定)では接続ウォレットが受取先になる。
      const session = await acpFetch('/api/acp/checkout_sessions', {
        line_items: [{ id: article.slug, quantity: 1 }],
        buyer: { wallet_address: address },
      })
      const handler = session.capabilities.payment.handlers.find(
        (item: { name: string }) => item.name === 'example.x402poc.exact_evm',
      )
      if (session.status !== 'ready_for_payment' || !handler?.config.payment_required) {
        throw new Error(session.messages?.[0]?.content || '購入を開始できませんでした。')
      }

      // 2. セッションが返したx402の支払い要件に署名する(ここでウォレット承認が入る)。
      const paymentRequired = decodePaymentRequiredHeader(handler.config.payment_required)
      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired)
      const headers = httpClient.encodePaymentSignatureHeader(paymentPayload)
      const token = headers['PAYMENT-SIGNATURE'] ?? headers['payment-signature']
      if (!token) throw new Error('支払い署名を作成できませんでした。')

      // 3. 署名をcompleteに渡して決済を確定する。
      const completed = await acpFetch(`/api/acp/checkout_sessions/${session.id}/complete`, {
        payment_data: {
          handler_id: handler.id,
          instrument: { type: 'x402', credential: { type: 'x402_payment_signature', token } },
        },
      })
      const receipt = completed.order?.x402
      if (completed.status !== 'completed' || !receipt?.transaction) {
        throw new Error(completed.messages?.[0]?.content || '決済に失敗しました。')
      }
      const result = { body: completed.order.content.body, transaction: receipt.transaction, payer: receipt.payer }
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
