import { useEffect, useState } from 'react'
import { baseSepolia } from 'wagmi/chains'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function WalletControls() {
  const [hydrated, setHydrated] = useState(false)
  const [showConnectors, setShowConnectors] = useState(false)
  const { address, chainId, isConnected } = useAccount()
  const { connectors, connect, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  useEffect(() => setHydrated(true), [])

  if (!hydrated) return <div className="wallet-placeholder" aria-hidden="true" />

  if (isConnected && address) {
    if (chainId !== baseSepolia.id) {
      return (
        <button
          className="button button-dark"
          onClick={() => switchChain({ chainId: baseSepolia.id })}
          disabled={isSwitching}
        >
          {isSwitching ? '切替中…' : 'Base Sepolia に切り替える'}
        </button>
      )
    }

    return (
      <button className="wallet-connected" onClick={() => disconnect()} title="クリックして切断">
        <span className="online-dot" />
        <span>{shortAddress(address)}</span>
        <span className="wallet-network">BASE SEPOLIA</span>
      </button>
    )
  }

  return (
    <div className="connect-control">
      <button className="button button-dark" onClick={() => setShowConnectors((open) => !open)}>
        ウォレット接続 <span aria-hidden="true">↗</span>
      </button>
      {showConnectors && (
        <div className="connector-menu">
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              onClick={() => connect({ connector }, { onSuccess: () => setShowConnectors(false) })}
              disabled={isPending}
            >
              <span className="connector-mark">{connector.name.includes('Coinbase') ? '◈' : '⬡'}</span>
              {connector.name.includes('Coinbase') ? 'Coinbase Wallet' : 'MetaMask / ブラウザウォレット'}
            </button>
          ))}
          {error && <p className="connector-error">接続できませんでした。ウォレットを確認してください。</p>}
        </div>
      )}
    </div>
  )
}
