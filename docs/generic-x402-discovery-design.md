# 汎用検索から始める x402 有料記事発見・購入デモ 設計書

更新日: 2026-10-11
状態: 実装済み

## 1. まず押さえる考え方

このデモでは、MCPとx402を別の役割として扱う。

- **MCP**は、OpenCode/LLMに検索やHTTPアクセスなどのtoolを見せるインターフェース。
- **x402**は、HTTPリソースが`402 Payment Required`で支払条件を伝え、支払い証明付きのHTTPリクエストでリソースを返すプロトコル。

したがって、記事サーバーがMCPを提供する必要はない。記事サーバーは現在のままHTTP APIを提供し、x402に応答すればよい。クライアント側には記事固有ではない汎用x402 HTTPクライアント機能が必要になる。

「専用の決済MCPなし」は、**記事提供者ごとの`search_articles`や`purchase_article`を登録しない**意味にするのが最も実現しやすい。HTTPリクエストに署名して再送する機能まで一切持たないという意味なら、通常の検索MCPやOpenCodeの`webfetch`だけでは決済できないため、汎用x402クライアントをOpenCodeのcustom tool/pluginなどで別途実装する必要がある。本案では、既存デモとの連続性とOpenCodeへの接続の容易さから、汎用x402クライアントをローカルMCPとして提供する。

## 2. 目的

利用者のOpenCodeにはSignal Journalやその有料記事用のtoolを事前登録せず、次の流れをデモする。

1. 汎用検索MCPのモックが記事URLを検索結果として返す。
2. エージェントが検索結果のURLを汎用x402クライアントへ渡す。
3. クライアントが通常のHTTP GETを行い、HTTP 402から価格・ネットワーク・トークン・受取先を読む。
4. 利用者がOpenCodeとウォレットの両方で支払いを承認する。
5. クライアントが`PAYMENT-SIGNATURE`付きで同じURLへ再リクエストし、記事サーバーから本文を受け取る。

この段階では、汎用APIのOpenAPI仕様を動的に読み込む機能や、検索結果から新しいMCPサーバーへ接続する機能は対象外とする。今回の有料記事は単一のGETリソースなので、HTTP 402とレスポンス本文だけでデモが成立する。

x402が伝えるのは支払い条件であり、URLの機能やレスポンスの意味そのものではない。今回は検索結果のタイトル・スニペットとJSON記事本文で内容を理解できる。任意のAPIの引数や操作方法まで動的に扱う段階では、OpenAPIやサイト説明など、API仕様を発見する別の仕組みが必要になる。

## 3. 推奨アーキテクチャ

```text
利用者
  │ 自然言語の依頼
  ▼
OpenCode / LLM
  ├── mock-search MCP
  │     search_web(query) -> title / snippet / URL
  │     記事固有の購入tool・価格・支払先は知らない
  │
  └── generic-x402 MCP
        ├── inspect_url(url) -> 未署名GET、402条件をquoteとして返す
        └── fetch_url(quoteId, 確認条件) -> ask承認後に署名・再送
                  │
                  ├── localhostのウォレット承認画面
                  │       EIP-712署名 -> 一回限りlocalhost callback
                  │
                  ▼
          Signal Journal HTTP API
          GET /api/article/ai-agents-economy
                  │
                  ├── 402 + PAYMENT-REQUIRED
                  └── PAYMENT-SIGNATURE付きGET
                            │
                            ▼
                      Facilitator -> Base Sepolia
```

サーバー側にMCPサーバーは置かない。既存Signal Journalが、有料記事本文をHTTPのx402リソースとして公開する。検索MCPはクライアント側のモックであり、Signal Journalとは独立した検索機能のふりをする。

### MCPを一切使わない構成との違い

本案は**記事専用MCPをなくす**設計であって、x402クライアント機能そのものは残す。検索MCPがURLを見つけるだけではEIP-712署名や`PAYMENT-SIGNATURE`付き再送は行えない。

将来、OpenCode固有のcustom tool/pluginで`inspect_url`と`fetch_url`を実装すれば、クライアント構成からMCP自体をなくすこともできる。ただし、HTTP 402の解釈・承認・署名・再送という決済処理はどこかの信頼されたクライアント機能に必要である。

## 4. デモ時の会話イメージ

```text
利用者: AIエージェントが自分で買い物をする仕組みの記事を探して、読んで要約して。

エージェント: 検索結果にSignal Journalの記事がありました。
             記事: AIエージェントは、どうやって自分で買い物をするのか
             URL: http://localhost:3000/api/article/ai-agents-economy
             検索結果には価格・チェーン・受取先の情報はありません。

エージェント: URLを確認したところ、取得には0.01 USDC (Base Sepolia) が必要です。
             受取先は 0x… です。購入しますか？

利用者: はい。
OpenCode: x402http_fetch_url の実行を承認しますか？ [once / always / reject]
利用者: once

承認画面: URL / 0.01 USDC / Base Sepolia / USDC / 受取先を表示
ウォレット: EIP-712署名を確認
利用者: 署名を承認

エージェント: 記事を取得しました。要約は…… (BaseScan取引リンク)
```

検索結果は記事の所在や概要だけを知らせる。購入可能か、いくらかかるかは、クライアントが実際にURLへアクセスして初めてx402応答から判明する。

## 5. MCP tool仕様

### 5.1 モック汎用検索MCP: `mocksearch_search_web`

- 入力: `query`。
- 出力: `title`, `snippet`, `url`の配列。
- 今回はSignal Journalの記事を検索可能な固定インデックスに入れておく。
- 出力には価格、ネットワーク、USDCコントラクト、受取先、決済方法を含めない。
- 記事を取得する専用toolやx402 SDKは持たない。

検索MCPが記事のタイトルや無料プレビューを返すのは問題ない。ただし、402応答を事前取得して検索結果に混ぜないことで、「検索でURLを発見し、利用時に支払条件を知る」順序を保つ。

### 5.2 汎用x402クライアントMCP: `x402http_inspect_url`

- 入力: `url`。初期デモではHTTP GET専用。
- 処理: 支払いヘッダーなしでURLへリクエストし、HTTP 402の場合にx402 v2の`PAYMENT-REQUIRED`とレスポンスbodyから条件を読み取る。
- 出力: `quoteId`, `url`, `method`, `description`, `amount`, `asset`, `network`, `payTo`, `expiresAt`。
- 署名も支払い付き再送も行わない。quote生成は無料。
- quoteはローカルMCPプロセスのメモリーに保存し、URL・GETメソッド・選択したpayment requirementと結び付ける。有効期限は2分、一回限りとする。

`PAYMENT-REQUIRED`ヘッダーがない、402以外のエラー、未対応スキーム・ネットワーク・assetなどは区別して返す。無料HTTP 200応答を受けた場合は、決済toolに進まず通常のGET結果として説明するか、今回のMVPでは「x402保護リソースではない」と返す。

### 5.3 汎用x402クライアントMCP: `x402http_fetch_url`

- 入力: `quoteId`, `url`, `confirmedAmount`, `confirmedNetwork`, `confirmedAsset`, `confirmedPayTo`。
- OpenCode permission: このtoolのみ`ask`に設定する。
- 実行前: quoteの期限、URL、HTTPメソッド、確認条件が保存済みquoteと一致することを検証する。
- ウォレット承認画面: 汎用x402 MCPが直前に取得した最新の402 challengeを受け取り、quoteと同一の条件を表示してから署名する。ブラウザーからリソースoriginへ直接fetchしないため、相手サーバーのCORS設定に依存しない。
- 支払い: ブラウザーから一回限りのlocalhost callbackへ署名済みx402 payloadを返し、MCPクライアントが`PAYMENT-SIGNATURE`を付けて元のURLへGETする。
- 成功条件: HTTP応答が成功し、`PAYMENT-RESPONSE`のsettlementが成功していること。成功時だけ本文とreceiptをtool resultにする。
- 失敗・拒否: payloadを元URL以外へ送らない。本文を返さず、quoteを無効にする。

モデルが渡す`confirmedAmount`などは承認画面の表示用・比較用であり、支払条件を決める根拠ではない。条件の正本はURLから取得した402 responseである。

## 6. 決済シーケンス

1. OpenCodeはユーザーの依頼に応じて`mocksearch_search_web`を呼び、URLと検索スニペットを得る。
2. エージェントは候補URLを利用する前に、`x402http_inspect_url`で支払条件を調べる。
3. MCPは未署名GETを行う。Signal Journalは既存実装のとおり402と機械可読な支払条件を返す。
4. エージェントは記事名と402由来の金額・通貨・ネットワーク・受取先を利用者へ提示する。
5. ユーザーが続行した場合に`x402http_fetch_url`を呼ぶ。OpenCodeのpermission `ask`で一度だけの実行を承認する。
6. 汎用MCPが最新402条件を承認画面へ渡し、内容・金額・受取先を表示する。
7. 利用者がウォレットでEIP-712署名する。拒否された場合はpayloadを送らない。
8. MCPは署名payloadとURLの結び付きを再検証し、元URLに`PAYMENT-SIGNATURE`を付けてGETする。
9. Signal Journalはfacilitatorで検証・settleし、成功時だけ記事本文と`PAYMENT-RESPONSE`を返す。
10. 汎用x402 toolはsettlement receiptを確認して本文をOpenCodeへ返す。エージェントは取得内容を要約する。

OpenCode permissionでの承認とウォレット署名は、異なる境界での承認である。会話上の「買ってよい」は購入意図を示すが、それ単独では支払いの実行条件にならない。

## 7. サーバー側にMCPを提供するか

| 選択肢 | 評価 |
|---|---|
| HTTP x402だけ提供 (推奨) | 他社の検索・agent・クライアントが同じURLを使える。MCPの事前登録なしで発見・購入するデモ意図に合う。 |
| 記事用MCPも提供 | MCPクライアントには便利だが、専用toolの登録・tool schemaの発見が必要になり、今回確認したいHTTP 402による動的な支払条件発見が見えにくくなる。 |
| MCPのみ提供 | 今回の目的には不適。HTTP上のx402決済を汎用クライアントから利用する経路にならない。 |

そのためSignal Journalは、現在の`GET /api/article/:slug`、x402サーバー、facilitator連携を維持する。Web UIと既存のブラウザー購入もそのまま共存できる。サーバー側に追加のMCP endpointは作らない。

## 8. 今回のデモで固定する条件

「汎用」は記事slugやサイト固有toolに依存しないという意味であり、初期実装をインターネット全体へ無制限に接続するという意味ではない。

- HTTP GETのみ。POST等の副作用のあるメソッドは対象外。
- HTTP 402、x402 v2、`exact`スキームのみ。
- Base Sepolia (`eip155:84532`) 上の既存USDCコントラクトのみ。
- 1回あたり最大0.10 USDC。現在の記事価格は0.01 USDC。
- 対象originは環境設定のSignal Journal originだけ。これによりMVPではlocalhostへの任意アクセス/SSRFを避ける。
- redirectは追従せず拒否する。最終URLがquote対象URLから変わるケースを許可しない。
- quoteと署名payloadをURL・メソッドに結び付け、一回限りで利用する。
- 応答サイズとrequest timeoutに上限を設定する。本文は`text`または`application/json`に限定する。
- MCP・ブラウザー双方で秘密鍵を保持せず、ウォレット署名を毎回人が操作する。
- 記事本文は非信頼コンテンツとしてLLMへ渡し、記事中の命令文をsystem/developer指示として扱わない。

実際のWeb上の未知originへ広げる場合は、origin許可方針、private IP/DNS rebinding対策、ドメイン信頼・支出制御を別途設計する。

## 9. 公式ガイドのMCPブリッジを利用する案

提示された[x402 MCP Server guide](https://docs.x402.org/guides/mcp-server-with-x402)は、この構成に近い。ガイド中のTypeScript例では、OpenCode等が起動する**ローカルMCPサーバー**がHTTPクライアントとして動き、外部のx402 APIを呼ぶ。したがって、有料記事サーバーがMCPを提供しなくても利用できる。

ただし、ガイドのサンプルをそのまま登録するだけでは、今回の発見フローにはならない。

- `RESOURCE_SERVER_URL`と`ENDPOINT_PATH`を環境変数で固定し、toolは固定endpointを呼ぶ例になっている。検索結果で発見したURLを入力する汎用toolではない。
- `EVM_PRIVATE_KEY`等をローカルMCPプロセスに渡し、402後にx402 wrapperが自動署名・再送する。人間が記事名や支払先を確認するウォレット画面は含まれない。
- サンプルのtoolは検索をせず、x402条件もユーザーへ先にquoteとして提示しない。

そのため本案では、公式例を**HTTP x402を扱う実装の土台**として参照しつつ、MCP toolと承認フローをデモ用に変更する。

1. 固定の`RESOURCE_SERVER_URL` / `ENDPOINT_PATH`を、検索結果から渡される`url`引数に置き換える。
2. 支払いを発生させない`inspect_url`と、quoteを確認してから実行する`fetch_url`を用意する。
3. private keyによる自動決済は使わず、既存のwagmi承認画面で利用者のウォレット署名を取得する。
4. `fetch_url`にOpenCodeの`ask` permissionを設定し、さらにコード側でquote条件と上限額を検証する。

同ページの`createx402MCPClient` / `x402MCPClient`は、別のMCPサーバーが提供する有料MCP toolをMCP protocol上で呼ぶためのクライアントである。今回のSignal JournalはHTTP APIをx402で保護しているため、HTTPクライアント層で402を扱う。実装では、quoteを表示してから利用者承認へ進めるよう、`@x402/axios`の自動決済wrapperではなく`@x402/core`の低レベルHTTP client APIを使う。

**結論:** 公式例をベースにローカルMCPブリッジを作る方針を推奨する。記事専用MCPを作る必要はないが、検索URLを受け取り、人間承認とウォレット署名を行うための汎用ブリッジ部分はデモ用に実装・改修する。

## 10. OpenCode登録イメージ

OpenCodeへ登録するのは、記事提供者固有のMCPではなく、モック検索と汎用x402クライアントの2つ。

```jsonc
{
  "mcp": {
    "mocksearch": {
      "type": "local",
      "command": ["node", "--import", "tsx", "search-mcp/src/index.ts"]
    },
    "x402http": {
      "type": "local",
      "command": ["node", "--import", "tsx", "x402-http-mcp/src/index.ts"]
    }
  },
  "permission": {
    "x402http_fetch_url": "ask"
  }
}
```

検索MCPは`search-mcp/src/index.ts`、汎用x402 HTTPクライアントMCPは`x402-http-mcp/src/index.ts`に実装する。MCP tool名のprefix・permission keyはOpenCodeのtool名に合わせて設定する。

## 11. 実装ファイル構成

- `x402-http-mcp`は`inspect_url`と`fetch_url`を提供し、記事データに依存せず許可origin上のURLを扱う。
- `x402-http-mcp/src/index.ts`にはMCP toolと決済フローを置き、`config.ts`、`resource-http.ts`、`payment-policy.ts`へURL設定・HTTP処理・quote検証のhelperを分離する。
- `search-mcp`は検索モック`search_web`を提供し、記事URLとスニペットのみを返す。
- `src/routes/agent/approve.tsx`は汎用resource URLとx402 challengeの条件を表示する。MCPからchallengeを受け取るため、リソースoriginのCORSに依存しない。
- `src/routes/api/article/$slug.ts`、`src/lib/payment.server.ts`、facilitator連携は原則変更不要。
- OpenCode設定は`mocksearch`と`x402http`を登録し、`x402http_fetch_url`だけ`ask`にする。
- MCP toolが記事固有ではないことを検証するため、検索mock以外のサーバーコードから記事メタデータを参照しない。

## 12. 受け入れ条件

1. OpenCodeにSignal Journal固有の`search_articles` / `purchase_article` toolがなくても、汎用検索結果から記事URLを取得できる。
2. 検索MCPの結果にはx402価格・ネットワーク・受取先が含まれない。
3. 未署名GETで402から支払条件を取得でき、その時点ではsettlementが発生しない。
4. tool結果と承認画面にURL、記事説明、0.01 USDC、Base Sepolia、受取先が表示される。
5. 許容origin外、redirect、別network/asset、0.10 USDC超過、quoteと異なる条件は署名前に拒否する。
6. OpenCodeで`once`承認し、ウォレット署名した場合のみ、汎用x402 clientが同一URLへ支払い付きGETを送る。
7. `PAYMENT-RESPONSE`の成功確認後だけ記事本文とreceiptがtool resultに返る。
8. Signal Journalサーバーに記事専用MCPを登録せずに一連のデモが成立する。

## 13. 参考

- 既存決済デモ: `README.md`、`src/routes/api/article/$slug.ts`、`src/lib/payment.server.ts`。
- 既存ローカル承認・MCP設計: `docs/agent-payment-design.md`。
- x402 client/server protocol: <https://docs.x402.org/core-concepts/client-server>。
- x402 buyer quickstart: <https://docs.x402.org/getting-started/quickstart-for-buyers>。
- x402 MCP bridge guide: <https://docs.x402.org/guides/mcp-server-with-x402>。
- OpenCode local MCP: <https://docs.opencode.ai/docs/mcp-servers>。
- OpenCode permissions: <https://dev.opencode.ai/docs/permissions>。
