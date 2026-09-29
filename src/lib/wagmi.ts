// coinbaseWallet, injected: ユーザーが使えるウォレット接続方式（コネクタ）のモジュールです。
import { coinbaseWallet, injected } from '@wagmi/connectors'
// createConfig, http: wagmiの設定を作成する関数と、ブロックチェーン通信（RPC）を行うためのHTTPトランスポート（通信モジュール）です。
import { createConfig, http } from 'wagmi'
//baseSepolia: Base Sepolia テストネットワーク（チェーンID: 84532）の設定情報（RPC URLやメタデータ）があらかじめ入っているプリセットデータです。
import { baseSepolia } from 'wagmi/chains'

export const wagmiConfig = createConfig({
  // このアプリがサポートするチェーンを配列で渡します。
  chains: [baseSepolia],
  // ユーザーがログイン（接続）する際に提示するウォレットの選択肢
  connectors: [
    // ブラウザ拡張機能として注入（Inject）されたウォレット（MetaMask、Phantom、Rabbyなど）を自動検知して接続できるようにします
    injected({ shimDisconnect: true }),
    // Coinbase Wallet アプリや拡張機能で接続できるようにします。
    coinbaseWallet({ appName: 'Signal Journal' }),
  ],
  // 各チェーンに対して「どの通信手段（RPCエンドポイント）でブロックチェーンからデータを読み書きするか」を指定します。
  // http() を引数なしで呼ぶと、wagmi があらかじめ用意しているデフォルトのパブリックRPCノード（無料の通信サーバー）を自動的に利用して通信を行います。
  transports: { [baseSepolia.id]: http() },
  // Next.js などの SSR（サーバーサイドレンダリング）フレームワークに対応させるためのフラグ
  ssr: true,
})
