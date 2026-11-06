import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { baseSepolia } from 'wagmi/chains'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { decodeMandateTerms, mandateTypedData } from '../../lib/mandate'

type MandateSearch = {
  mandate: string
  callbackUrl: string
  quoteId: string
  nonce: string
}

type PageState = 'ready' | 'signing' | 'complete' | 'rejected'

export const Route = createFileRoute('/agent/mandate')({
  validateSearch: (search: Record<string, unknown>) => search as unknown as MandateSearch,
  component: MandatePage,
})

function formatUsdc(units: string) {
  const value = BigInt(units)
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${value / 1_000_000n}.${fraction}` : (value / 1_000_000n).toString()
}

function MandatePage() {
  const { mandate: encoded, callbackUrl, quoteId, nonce } = Route.useSearch()
  const { address, chainId, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [state, setState] = useState<PageState>('ready')
  const [error, setError] = useState('')

  const { terms, parseError } = useMemo(() => {
    try {
      return { terms: decodeMandateTerms(encoded), parseError: '' }
    } catch (cause) {
      return { terms: undefined, parseError: cause instanceof Error ? cause.message : '許可証を読み取れません。' }
    }
  }, [encoded])

  async function postCallback(body: Record<string, string>) {
    const callback = new URL(callbackUrl)
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== `/callback/${nonce}`) {
      throw new Error('ローカルコールバックが不正です。エージェントからやり直してください。')
    }
    const response = await fetch(callback.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, quoteId }),
    })
    if (!response.ok) throw new Error('エージェントとの接続が切れました。ツールをもう一度実行してください。')
  }

  async function reject() {
    setError('')
    try {
      await postCallback({ status: 'rejected' })
      setState('rejected')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'キャンセルを通知できませんでした。')
    }
  }

  async function sign() {
    setError('')
    if (!terms || !isConnected || !address || !walletClient) {
      setError('先にページ上部からBase Sepolia対応ウォレットを接続してください。')
      return
    }
    if (chainId !== baseSepolia.id) {
      setError('署名の前にBase Sepoliaへ切り替えてください。')
      return
    }
    setState('signing')
    try {
      const signature = await walletClient.signTypedData({ ...mandateTypedData(terms), account: address } as never)
      await postCallback({ status: 'approved', signature })
      setState('complete')
    } catch (cause) {
      setState('ready')
      setError(cause instanceof Error ? cause.message : '署名を完了できませんでした。')
    }
  }

  if (state === 'complete' || state === 'rejected') {
    return (
      <section className="agent-approval">
        <div className="agent-approval-card">
          <p className="eyebrow">X402 HTTP · SPENDING MANDATE</p>
          <h1>{state === 'complete' ? '許可証に署名しました' : '許可証をキャンセルしました'}</h1>
          <p>{state === 'complete' ? 'この範囲内の購入は、エージェントが自動で支払います。この画面を閉じてください。' : '許可証は作られていません。この画面を閉じてください。'}</p>
          {error && <p className="payment-error" role="alert">{error}</p>}
        </div>
      </section>
    )
  }

  return (
    <section className="agent-approval">
      <div className="agent-approval-card">
        <p className="eyebrow">X402 HTTP · SPENDING MANDATE</p>
        <h1>自動決済の許可証に署名</h1>
        <p className="agent-approval-intro">署名すると、この範囲内の購入ではエージェントが毎回の承認なしで支払います。</p>
        {terms && (
          <dl className="agent-payment-terms">
            <div><dt>1回あたりの上限</dt><dd>{formatUsdc(terms.maxPerPurchase)} USDC</dd></div>
            <div><dt>総予算</dt><dd>{formatUsdc(terms.budget)} USDC</dd></div>
            <div><dt>有効期限</dt><dd>{new Date(terms.expiresAt * 1000).toLocaleString()}</dd></div>
            <div><dt>支払い先</dt><dd>{terms.payees.map((payee) => <code key={payee}>{payee}</code>)}</dd></div>
            <div><dt>支払うウォレット</dt><dd><code>{terms.agent}</code></dd></div>
            <div><dt>ネットワーク</dt><dd>Base Sepolia · USDC</dd></div>
          </dl>
        )}
        <p className="agent-approval-note">署名はこの許可証の証跡になります。USDCは「支払うウォレット」から出るため、あなたのウォレットからは動きません。</p>
        {!isConnected ? (
          <p className="agent-approval-hint">ページ上部からウォレットを接続してください。</p>
        ) : chainId !== baseSepolia.id ? (
          <button className="button button-dark agent-approval-primary" disabled={isSwitching} onClick={() => switchChain({ chainId: baseSepolia.id })}>
            {isSwitching ? '切り替えています…' : 'Base Sepolia に切り替える'}
          </button>
        ) : (
          <button className="button button-dark agent-approval-primary" disabled={!terms || state === 'signing'} onClick={sign}>
            {state === 'signing' ? <><span className="spinner" /> ウォレットで署名中…</> : <>許可証に署名する <span>↗</span></>}
          </button>
        )}
        <button className="agent-approval-cancel" disabled={state === 'signing'} onClick={reject}>署名せずにキャンセル</button>
        {(error || parseError) && <p className="payment-error" role="alert">{error || parseError}</p>}
      </div>
    </section>
  )
}
