import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { x402Client, x402HTTPClient } from '@x402/fetch'
import { baseSepolia } from 'wagmi/chains'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { BASE_SEPOLIA_NETWORK } from '../../lib/payment-config'

type ApprovalSearch = {
  slug: string
  title: string
  amount: string | number
  asset: string
  network: string
  payTo: string
  callbackUrl: string
  quoteId: string
  nonce: string
}

type PageState = 'ready' | 'signing' | 'complete' | 'rejected'

export const Route = createFileRoute('/agent/approve')({
  validateSearch: (search: Record<string, unknown>) => search as unknown as ApprovalSearch,
  component: AgentApprovalPage,
})

function AgentApprovalPage() {
  const { slug, title, amount, asset, network, payTo, callbackUrl, quoteId, nonce } = Route.useSearch()
  const { address, chainId, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [state, setState] = useState<PageState>('ready')
  const [error, setError] = useState('')

  function validateCallbackUrl() {
    const url = new URL(callbackUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== `/callback/${nonce}`) {
      throw new Error('ローカル決済コールバックが不正です。OpenCodeから操作をやり直してください。')
    }
    return url.toString()
  }

  async function postCallback(body: Record<string, string>) {
    const url = validateCallbackUrl()
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, quoteId }),
    })
    if (!response.ok) throw new Error('OpenCodeとの接続が切れました。ツールをもう一度実行してください。')
  }

  async function rejectPayment() {
    setError('')
    try {
      await postCallback({ status: 'rejected' })
      setState('rejected')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'キャンセルを通知できませんでした。')
    }
  }

  async function signPayment() {
    setError('')
    if (!isConnected || !address || !walletClient) {
      setError('先にページ上部からBase Sepolia対応ウォレットを接続してください。')
      return
    }
    if (chainId !== baseSepolia.id) {
      setError('署名の前にBase Sepoliaへ切り替えてください。')
      return
    }
    if (network !== BASE_SEPOLIA_NETWORK) {
      setError('Base Sepolia以外のネットワークへの支払いは許可されていません。')
      return
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(payTo) || !/^0x[a-fA-F0-9]{40}$/.test(asset)) {
      setError('受取先またはUSDCコントラクトアドレスが不正です。')
      return
    }

    setState('signing')
    let callbackSent = false
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
      const httpClient = new x402HTTPClient(client)

      const resourceUrl = new URL(`/api/article/${encodeURIComponent(slug)}`, window.location.origin)
      const challengeResponse = await fetch(resourceUrl, { headers: { Accept: 'application/json' } })
      if (challengeResponse.status !== 402) {
        const body = await challengeResponse.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `決済条件を取得できませんでした (HTTP ${challengeResponse.status})`)
      }

      const challengeBody = await challengeResponse.clone().json().catch(() => ({}))
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => challengeResponse.headers.get(name),
        challengeBody,
      )
      const expectedAmount = String(amount)
      const expectedTerms = { scheme: 'exact', network, amount: expectedAmount, asset, payTo }
      const terms = paymentRequired.accepts.find((requirement) =>
        requirement.scheme === 'exact' &&
        requirement.network === network &&
        requirement.amount === expectedAmount &&
        requirement.asset.toLowerCase() === asset.toLowerCase() &&
        requirement.payTo.toLowerCase() === payTo.toLowerCase(),
      )
      if (!terms) {
        const actualTerms = paymentRequired.accepts.map(({ scheme, network: actualNetwork, amount: actualAmount, asset: actualAsset, payTo: actualPayTo }) => ({
          scheme,
          network: actualNetwork,
          amount: actualAmount,
          asset: actualAsset,
          payTo: actualPayTo,
        }))
        console.warn('[agent-payment] quote/challenge mismatch', { expectedTerms, actualTerms })
        throw new Error(`記事サーバーの支払条件が表示内容と異なります。署名していません。 表示: ${JSON.stringify(expectedTerms)} / API: ${JSON.stringify(actualTerms)}`)
      }

      const payload = await httpClient.createPaymentPayload(paymentRequired)
      const headers = httpClient.encodePaymentSignatureHeader(payload)
      const paymentHeader = headers['PAYMENT-SIGNATURE'] ?? headers['payment-signature']
      if (!paymentHeader) throw new Error('x402の支払署名ヘッダーを作成できませんでした。')

      await postCallback({ status: 'approved', paymentHeader })
      callbackSent = true
      setState('complete')
    } catch (cause) {
      let callbackRejected = false
      if (!callbackSent) {
        try {
          await postCallback({ status: 'rejected' })
          callbackRejected = true
        } catch {
          // The approval bridge may already have timed out or closed.
        }
      }
      setState(callbackRejected ? 'rejected' : 'ready')
      setError(cause instanceof Error ? cause.message : '署名を完了できませんでした。')
    }
  }

  if (state === 'complete' || state === 'rejected') {
    return (
      <section className="agent-approval">
        <div className="agent-approval-card">
          <p className="eyebrow">SIGNAL JOURNAL · AGENT CHECKOUT</p>
          <h1>{state === 'complete' ? '署名を送信しました' : '購入をキャンセルしました'}</h1>
          <p>{state === 'complete' ? 'OpenCodeが決済を検証し、成功した場合に記事を取得します。この画面を閉じてください。' : '決済は送信されていません。この画面を閉じてください。'}</p>
          {error && <p className="payment-error" role="alert">{error}</p>}
        </div>
      </section>
    )
  }

  return (
    <section className="agent-approval">
      <div className="agent-approval-card">
        <p className="eyebrow">SIGNAL JOURNAL · AGENT CHECKOUT</p>
        <h1>購入内容を確認</h1>
        <p className="agent-approval-intro">OpenCodeのAIエージェントが、次の記事を取得しようとしています。</p>
        <dl className="agent-payment-terms">
          <div><dt>記事</dt><dd>{title}</dd></div>
          <div><dt>金額</dt><dd>{(Number(amount) / 1_000_000).toFixed(2)} USDC</dd></div>
          <div><dt>ネットワーク</dt><dd>Base Sepolia</dd></div>
          <div><dt>受取先</dt><dd><code>{payTo}</code></dd></div>
          <div><dt>支払通貨</dt><dd><code>{asset}</code></dd></div>
        </dl>
        <p className="agent-approval-note">ウォレット署名を行うと、この金額の支払いが承認されます。署名後、OpenCodeが決済を検証して記事を取得します。</p>
        {!isConnected ? (
          <p className="agent-approval-hint">ページ上部からウォレットを接続してください。</p>
        ) : chainId !== baseSepolia.id ? (
          <button className="button button-dark agent-approval-primary" disabled={isSwitching} onClick={() => switchChain({ chainId: baseSepolia.id })}>
            {isSwitching ? '切り替えています…' : 'Base Sepolia に切り替える'}
          </button>
        ) : (
          <button className="button button-dark agent-approval-primary" disabled={state === 'signing'} onClick={signPayment}>
            {state === 'signing' ? <><span className="spinner" /> ウォレットで署名中…</> : <>ウォレットで支払いを承認 <span>↗</span></>}
          </button>
        )}
        <button className="agent-approval-cancel" disabled={state === 'signing'} onClick={rejectPayment}>支払わずにキャンセル</button>
        {error && <p className="payment-error" role="alert">{error}</p>}
        <div className="payment-details"><span>BASE SEPOLIA</span><span>USDC · EIP-3009</span><span>署名後にsettle</span></div>
      </div>
    </section>
  )
}
