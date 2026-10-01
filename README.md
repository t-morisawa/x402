# Signal Journal — x402 有料記事 PoC

Base Sepolia 上のUSDC決済でニュース記事を解放するローカル実験アプリです。記事本文は有料APIからだけ返し、x402 facilitatorが署名検証とオンチェーン決済を行います。

## 起動

Node.js 22以降を用意し、このディレクトリで実行します。

```bash
npm install
cp .env.example .env
npm run dev
```

`http://localhost:3000` を開きます。`.env` の `X402_PAY_TO` が空なら自己送金モード、Base Sepoliaの受取アドレスを設定すると固定受取モードになります。受取アドレスは公開情報です。

スマホの通常ブラウザーからMetaMaskアプリへ接続するには、[WalletConnect Dashboard](https://dashboard.walletconnect.com/)でProject IDを取得し、`.env`の`VITE_WALLETCONNECT_PROJECT_ID`に設定してから開発サーバーを再起動してください。接続メニューの「スマホのMetaMask（WalletConnect）」を選ぶと、WalletConnect経由でMetaMaskアプリに接続できます。Project IDはブラウザーに公開される識別子で、秘密鍵ではありません。

## 実送金の確認

1. MetaMaskまたはCoinbase Walletを接続します。ウォレットUIはブラウザのハイドレーション後に表示されます。
2. Base Sepoliaへ切り替えます。
3. Base SepoliaのUSDCを用意します。Circle faucetは <https://faucet.circle.com/> で、ネットワークにBase Sepoliaを選択します。
4. 記事詳細で「0.01 USDC で読む」を押し、ウォレットで署名します。
5. 決済完了後、記事本文とBaseScanの取引リンクが表示されます。

テストUSDCのコントラクトは `0x036CbD53842c5426634e7929541eC2318f3dCF7e` です。ウォレットに残高が表示されない場合は、このアドレスをトークンとして追加してください。支払いはEIP-3009の署名を使うため、利用者のガス用Sepolia ETHは不要です。

## 実装メモ

- 有料API: `GET /api/article/:slug`
- 未払い時はx402 v2のHTTP 402応答と`PAYMENT-REQUIRED`ヘッダーを返します。支払い後は本文と`PAYMENT-RESPONSE`ヘッダーを返します。
- `@x402/core` / `@x402/evm`で要件生成・署名検証・決済、`@x402/fetch`で署名付き再送を行います。
- MetaMaskなどのEIP-1193ウォレットとCoinbase Walletをwagmiで接続します。
- 受取先は`X402_PAY_TO`、facilitator URLは`X402_FACILITATOR_URL`で設定できます。
- 公式テスト用facilitator: `https://x402.org/facilitator`

このPoCはテストネット専用です。自己送金モードでは接続ウォレット自身が受取先になり、決済トランザクションはBase Sepolia上に記録されます。
