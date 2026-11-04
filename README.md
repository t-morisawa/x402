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

## OpenCode AIエージェント決済デモ

記事専用の検索・購入MCPを使わず、モック検索MCPが返したURLを汎用x402 HTTPクライアントMCPで購入します。Signal Journal側は既存のHTTP x402 APIを提供し、記事サーバーにMCPは必要ありません。

1. `.env`の`X402_PAY_TO`に記事代金の受取先となるBase Sepoliaアドレスを設定します。
2. `.env`の`X402_ALLOWED_ORIGINS`にアクセス可能なoriginを設定します。既定は`X402_DEMO_URL`と同じorigin (`http://localhost:3000`) だけです。複数許可する場合はカンマ区切りにします。
3. ウォレットにBase Sepolia USDCを用意します。現在の記事価格は0.01 USDC、クライアントの上限は0.10 USDCです。
4. `npm run dev`でSignal Journalを起動します。
5. 別ターミナルでこのリポジトリを作業ディレクトリにして`opencode`を起動します。`opencode.json`が`mocksearch`と`x402http`のstdio MCPを登録し、`fetch_url`だけ実行時の承認を求めます。OpenCodeをすでに起動している場合は再起動してください。
6. 例: `mocksearch_search_webを使って「agentic commerce buy things themselves」の記事を検索して。外部Web検索は使わず、見つけたURLをinspect_urlで確認し、価格を提示してから購入して要約して`。
7. 検索結果に価格や受取先は含まれません。エージェントが`inspect_url`でHTTP 402の条件を取得して提示した後、`fetch_url`のOpenCode確認で`once`を選びます。
8. 開いたブラウザー画面でウォレットを接続し、URL・金額・ネットワーク・受取先を確認して署名します。決済成功時だけ記事本文と取引情報が会話に返ります。

`mocksearch`のtoolは`search_web`、`x402http`のtoolは`inspect_url`と`fetch_url`です。x402クライアントはHTTP GET専用で、URLのoriginをallowlistと照合し、Base Sepolia USDCの0.10 USDC以下の要求だけ扱います。OpenCodeを`--auto`で起動せず、permissionでは`once`を選んでください。ウォレット署名は毎回必要です。

`X402_DEMO_URL`は承認画面・検索結果のURLを作るWebサーバーURLで、既定値は`http://localhost:3000`です。WalletConnectでスマートフォンのウォレットを使う場合は、上記Web決済手順と同様に`VITE_WALLETCONNECT_PROJECT_ID`も設定してください。

## ACP (Agentic Commerce Protocol) 購入フロー

購入フローは[ACP](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) (仕様 `2026-04-17`) のcheckout APIに準拠しています。ブラウザーもエージェントも同じAPIを使います。

- `POST /api/acp/checkout_sessions` (create) / `POST .../{id}` (update) / `GET .../{id}` / `POST .../{id}/complete` / `POST .../{id}/cancel`
- 必須ヘッダー: `Authorization: Bearer <任意>` (`ACP_API_KEY`を設定すると一致を確認)、`API-Version: 2026-04-17`、全POSTに`Idempotency-Key`
- 商品ID (`line_items[].id`) は記事のslugです。数量は1のみです。
- 自己送金モード (`X402_PAY_TO`未設定) では、`buyer.wallet_address`を指定するまで`not_ready_for_payment`です。

公式ACPにx402の決済手段はないため、決済は独自のpayment handler `dev.x402.exact_evm` として宣言しています。カード/SPT (Stripe等) には対応していません。通貨は`usdc`、金額はUSDC最小単位(6桁)の整数です。

1. セッションが`ready_for_payment`になると、handlerの`config.payment_required`にx402の支払い要件(`PAYMENT-REQUIRED`ヘッダー値)が入ります。
2. クライアントがこれに署名し、`complete`の`payment_data.instrument.credential.token`に`PAYMENT-SIGNATURE`値を渡します (`handler_id`は`x402_exact_evm_base_sepolia`)。
3. 決済成功で`completed`になり、`order`に取引情報と記事本文 (独自拡張) が入ります。

エージェント用には`x402http` MCPに`acp_create_checkout` / `acp_update_checkout` / `acp_get_checkout` / `acp_cancel_checkout` / `acp_complete_checkout`があります。OpenCode (`opencode.json`) とClaude Code (`.mcp.json`) のどちらでも同じstdio MCPを使えます。`acp_complete_checkout`だけが署名画面を開き、決済は毎回ウォレット署名が必要です。検索結果の`productId`をそのまま`acp_create_checkout`に渡します。

`npm test`でcheckout APIのテスト (facilitatorはスタブ) を実行できます。
