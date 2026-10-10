# OpenCode AIエージェント決済デモ 設計書

更新日: 2026-10-10
状態: 実装前の設計

## 1. 目的

ローカルのOpenCodeから、会話中の依頼に応じてAIエージェントが有料記事を探し、利用者が決済条件を確認・承認した後に記事本文を取得するデモを作る。

デモで確認すること:

- OpenCodeのtool useから外部の有料APIを利用できる。
- x402のHTTP 402応答で価格・ネットワークなどの支払条件を機械的に取得できる。
- エージェントが支払いを勝手に確定せず、利用者の承認とウォレット署名を経て本文を取得する。
- 既存Webサンプルと同じBase Sepolia USDC決済を使い、決済結果を検証できる。

## 2. 既存サンプルの再利用

現行のSignal Journalは、記事一覧情報と記事本文を分離し、`GET /api/article/:slug`をx402で保護している。未払い時はx402 v2のHTTP 402と`PAYMENT-REQUIRED`を返し、支払署名付きの再送をfacilitatorが検証・settleした後に本文と`PAYMENT-RESPONSE`を返す。

| 項目 | 既存実装 | エージェントデモでの扱い |
|---|---|---|
| 記事一覧 | `src/data/articles.ts` | 無料のMCP検索ツールで利用 |
| 記事本文 | `src/data/article-bodies.server.ts` | 決済後だけ既存APIから返す |
| 有料API | `src/routes/api/article/$slug.ts` | 既存のx402エンドポイントを再利用 |
| x402サーバー | `src/lib/payment.server.ts` | Base Sepolia / Exact EVM / facilitatorを再利用 |
| 価格・通貨 | `src/lib/payment-config.ts` | 現状の0.01 USDCをデモ価格として表示 |
| ブラウザー決済 | `src/components/PaidArticle.tsx` | ウォレット接続・署名処理を承認画面へ切り出して再利用 |

エージェント用には`X402_PAY_TO`を設定し、サーバー固定の受取先を使う。現在のWebサンプルの自己送金用`payTo`クエリはエージェントフローでは使わない。Web購入とエージェント購入を同じ受取先・記事APIに通すことで、決済サーバーを二重実装しない。

## 3. 推奨アーキテクチャ

```text
利用者 ──会話──> OpenCode / LLM
                    │ MCP tool call
                    ▼
              ローカルMCPサーバー (stdio)
                │ 1. 無署名GETで402条件を取得
                │ 2. OpenCodeのtool permissionで都度承認
                │ 3. localhostの承認画面を開く
                │ 4. 署名済みx402 payloadを受信して有料APIへ再送
                ▼
         Signal Journal (既存Web/API)
                │ 402 + PAYMENT-REQUIRED
                ▼
         ローカル承認画面 (既存wagmi)
                │ ウォレット署名済みpayloadをlocalhost callbackへ
                ▼
         Facilitator ──> Base Sepolia
```

OpenCodeとの接続にはローカルMCPサーバーを使う。MCPサーバーはLLMに道具を公開し、HTTP通信と承認待ちを担当する。秘密鍵はMCPサーバーに置かず、既存Web画面と同じEIP-1193ウォレットから利用者がEIP-712署名する。

承認を二段階にする:

1. **OpenCodeのtool permission**: 支払いtoolを`ask`にし、利用者が呼び出しを一度だけ承認する。価格と記事は事前にquote toolの結果で会話に表示する。支払いtoolの入力にも記事slug・quote ID・承認対象額を含める。
2. **ウォレット署名**: ローカル承認画面で受取先・金額・通貨・ネットワークを再表示し、ウォレット署名を利用者が確定する。署名拒否時は支払いを行わない。

OpenCode permissionの`always`や`--auto`を使うとtool承認を省略し得る。デモ手順ではMCPの支払いtoolを毎回`ask`にし、OpenCodeでは`once`だけを選ぶ。ウォレット署名も毎回必要とする。

## 4. ユーザー体験

例:

```text
利用者: AIエージェントが自分で買い物をする仕組みの記事を読んで要約して。
エージェント: 記事「AIエージェントは、どうやって自分で買い物をするのか」を見つけました。
             価格は0.01 USDC、Base Sepoliaです。購入しますか？
利用者: はい。
OpenCode: purchase_article toolの実行を承認しますか？ [once / always / reject]
利用者: once
承認画面: Signal Journal / 記事名 / 0.01 USDC / Base Sepolia / 受取先 を表示
ウォレット: EIP-712署名の確認
利用者: 署名を承認
エージェント: 記事本文を取得しました。要約は…… (BaseScanの取引リンク)
```

会話での「はい」はLLMへの指示であり、決済承認そのものとして扱わない。実際の実行にはOpenCodeのtool permissionとウォレット署名が必要。

## 5. MCPツール仕様

### `search_articles`

- 用途: 無料の記事検索。
- 入力: `query` (文字列)。
- 出力: `slug`, `title`, `lead`, `price`, `network`。記事本文は返さない。
- 処理: `articles`の公開メタデータを検索する。キーワード検索の初期実装では、タイトル・リード文を対象にする。

### `get_article_quote`

- 用途: 記事を購入せずにx402の価格条件を取得する。
- 入力: `slug`。
- 処理: 記事APIへ支払いヘッダーなしでGETし、402応答から`PAYMENT-REQUIRED`とbodyの支払条件をx402 HTTP clientでデコードする。未署名リクエストなので決済は発生しない。
- 出力: `quoteId`, `slug`, `title`, `amount`, `asset`, `network`, `payTo`, `expiresAt`。
- quoteはMCPサーバーのメモリー内に短時間だけ保存し、デモでは有効期限を2分とする。再起動後・期限切れ後はquoteを取り直す。

### `purchase_article`

- 用途: quoteで示した記事を利用者の承認後に取得する。
- 入力: `quoteId`, `slug`, `confirmedAmount`。値は保存済みquoteと完全一致すること。
- OpenCode設定: このtoolは`ask`。一度の実行ごとに承認を求め、`always`で恒久許可しない運用をデモ手順に明記する。
- 処理: quoteの有効性と条件を再確認し、承認ページ用の一回限りnonceを生成する。既定ブラウザーで`/agent/approve`を開き、署名済みpayloadまたは拒否を待つ。承認ページは同じ記事APIから新しい402条件を取得し、quoteと同一の金額・通貨・ネットワーク・受取先であることを検証してから署名を求める。署名済みpayloadをnonce付きlocalhost callbackでMCPサーバーに返し、MCPがそのpayloadで記事APIを再要求する。本文を返すのはAPIの決済成功応答だけとする。
- 出力: 記事の`title`, `body`, `transaction`, `network`, `payer`, `amount`。本文は決済成功応答に含まれるものだけを返す。
- 拒否・タイムアウト: 決済を送らず、明示的な中止結果を返す。ツール再実行により新しいquoteを作成する。

## 6. 決済シーケンス

1. OpenCodeはMCPの`search_articles`を呼び、記事候補を会話に出す。
2. `get_article_quote`が記事APIを未署名で呼ぶ。APIはx402 v2の402応答を返し、MCPは支払条件を抽出する。
3. OpenCodeはタイトル・金額・ネットワークを利用者に提示する。
4. 利用者が購入意思を示した場合、エージェントは`purchase_article`を呼ぶ。OpenCodeの`ask` permissionが実行前に利用者へ確認を出す。
5. 実行が許可された場合、MCPはlocalhost承認ページを開き、nonceを使ったcallback待受を開始する。
6. 承認ページはウォレットを接続し、サーバーから402条件を再取得する。画面上の条件とquoteを照合してから署名を要求する。
7. MCPが受け取ったpayloadを`PAYMENT-SIGNATURE`付きで記事APIに再送する。サーバーはfacilitatorに検証・settlementを依頼し、成功時だけ記事本文を返す。
8. 承認ページは署名済みx402 payloadだけをnonce付きlocalhost callbackへ返す。MCPはcallbackを検証し、payloadを`PAYMENT-SIGNATURE`ヘッダーに載せて記事APIへ再送する。APIのsettlement成功応答を検証後、本文をOpenCode tool resultとして返す。
9. エージェントは記事を要約し、BaseScanの取引リンクを会話に含める。

## 7. API・プロセス境界

- Web/APIサーバー: 現在のSignal Journal。`GET /api/article/:slug`を再利用する。
- MCPサーバー: ローカルstdio MCP。OpenCodeから起動され、記事APIへのHTTPクライアントになる。
- 承認UI: Signal Journalの`/agent/approve`画面。wagmi・x402 clientのブラウザー実装を再利用する。
- localhost callback: MCPプロセスが`127.0.0.1`に一時ポートでbindする。callback先はその要求で発行したランダムnonceに限定し、署名済みx402 payloadだけを受け付け、完了後にlistenerを閉じる。callbackを受け取っただけでは支払い成功とみなさず、必ず記事APIのsettlement結果を確認する。
- CORS/CSRF: callbackは承認UIの既知originのみ許可し、推測困難なnonceを一回だけ受理する。callback payloadに秘密鍵・署名用seedを含めない。
- OpenCode設定: `mcp`にローカルサーバーを登録し、該当MCPのtool名をpermission `ask`に設定する。具体的な設定キーやMCP SDKのAPIは実装時にインストールするOpenCode/MCPバージョンの公式ドキュメントで確認する。

## 8. 検証・エラー処理

MCPと承認画面の両方で、次の条件を許可リストと照合する。

- 接続先originがデモサーバーとして設定したURLである。
- networkが`eip155:84532` (Base Sepolia) である。
- assetが既存設定のBase Sepolia USDCである。
- amountがquoteの値と完全一致し、デモの上限額以下である。
- payToが設定済みの固定受取先である。ユーザー入力やモデル生成の値で上書きしない。
- quoteの期限が切れていない。
- 決済後応答が成功し、transactionが存在する。

失敗時の扱い:

| 状況 | 動作 |
|---|---|
| 記事・slugが存在しない | 404相当をtool resultで返す。決済処理はしない |
| x402条件が未対応・allowlist外 | 署名を要求せず処理を拒否する |
| quote期限切れ・条件変更 | 再quoteを促し、古い条件では署名しない |
| OpenCode承認拒否 | 承認UIを開かず終了する |
| ウォレット未接続・署名拒否 | 決済せず終了する |
| facilitator失敗・settlement失敗 | 本文を返さず、APIエラーをtool resultに返す |
| callback timeout・不正nonce | 本文を返さずlistenerを閉じる |

## 9. セキュリティとデモ範囲

- テストネット専用。Base Sepolia以外のchain、USDC以外のasset、設定外の受取先を拒否する。
- MCPは秘密鍵・seed phraseを保持しない。承認ページのウォレット署名を使う。
- 記事APIは決済成功前に本文を返さず、本文応答は`no-store`を維持する。
- quoteとcallback nonceには有効期限を設け、一回使ったnonceを再利用させない。
- MCP toolの引数だけで支払条件を決定しない。x402応答とサーバー設定を信頼根拠とし、受取先・amount等を再検証する。
- `PAYMENT-SIGNATURE`やウォレット情報を通常ログに記録しない。デバッグログにも秘密情報を出さない。callback payloadは一回限りで使い、quoteに対応する記事API以外へ転送しない。
- OpenCodeの承認だけに依存せず、ウォレット側の署名操作も必須にする。OpenCodeの`--auto`はtool permissionのaskを省略し得るためデモ起動では使用しない。
- 本設計は単一ユーザーのローカルデモを対象にする。複数ユーザー向けサービス化、利用上限管理、返金、恒久的な購入履歴、商用運用の鍵管理は対象外。

## 10. 実装候補ファイル

```text
src/routes/agent/approve.tsx           # ウォレット接続と決済確認UI
src/lib/agent-approval.server.ts       # quote/callback関連のサーバー処理 (必要な場合)
agent-mcp/src/index.ts                 # stdio MCPサーバーとtool定義
agent-mcp/src/quotes.ts                # 402条件の抽出、quote期限・検証
agent-mcp/src/approval-bridge.ts       # 一時localhost callbackとnonce検証
agent-mcp/package.json                 # MCP SDK等の依存関係
docs/agent-payment-design.md           # 本設計書
```

実装前に確認すること: npm workspace化または独立packageのどちらにするか、現行TanStack Startからの`/agent/approve`追加方法、OpenCodeのMCPローカル設定とpermission設定の最新形式、MCP SDKのtool出力・キャンセル仕様。

## 11. 受け入れ条件

1. OpenCodeから記事を検索し、記事本文を含まない候補を得られる。
2. quote取得で402条件が会話に表示されるが、オンチェーン決済は発生しない。
3. `purchase_article`はOpenCodeで一度だけの承認を得るまで実行されない。
4. ウォレット署名を拒否した場合、本文が得られずsettlementも成功しない。
5. 正しい条件で署名した場合だけ本文とtransaction hashがtool resultに返る。
6. quoteのamount/network/asset/payToを変更した要求、期限切れquote、無効slugは署名処理へ進まない。
7. Webブラウザーからの既存購入フローが引き続き利用できる。

## 12. 参考資料

- リポジトリREADME: `README.md` — 現行の起動方法、Base Sepolia設定、API仕様。
- OpenCode Tools: <https://opencode.ai/docs/tools> — custom toolsとMCPの説明。
- OpenCode MCP servers: <https://docs.opencode.ai/docs/mcp-servers> — ローカルMCP登録。
- OpenCode Permissions: <https://dev.opencode.ai/docs/permissions> — `allow` / `ask` / `deny`と承認動作。
- x402 Buyers quickstart: <https://docs.x402.org/getting-started/quickstart-for-buyers> — HTTP 402からの支払クライアント。
- x402 Client/Server: <https://docs.x402.org/core-concepts/client-server> — 402、`PAYMENT-SIGNATURE`等のプロトコルフロー。

OpenCodeとx402は更新が速いため、実装時に導入バージョンを固定し、上記公式資料と実際のSDK APIを再確認する。
