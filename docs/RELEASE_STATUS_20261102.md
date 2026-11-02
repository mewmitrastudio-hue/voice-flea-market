# 声のフリマ：2026-11-02 現在の公開条件

この文書は10月29日の各候補・検証文書にある配布停止、未反映、Worker失敗についての古い状態を更新する。過去の検証記録は履歴として残す。一般公開・審査提出の許可や完了を意味しない。

## 確認済み

- PR35、作業ブランチ `codex/receipt-capture-20261029`。本番mainへの統合なし。
- Cloudflareの最新失敗は `wrangler preview` の `previews` ブロック不足。公開App IDだけを追加したa7d2fbcのBuild / Deployment成功をCloudflare公式通知で確認。本番秘密情報のプレビューへの複製なし。認証付きプレビュー実行は未確認。
- Supabase `tyulybijubckitybgubc`：create-checkout-session v26、cancel-authorization v3、renew-authorization v3の送信サイズ制限を反映。voice-iap v5では購入環境・サーバー上の販売者・受取準備を注文予約前に確認する。署名済み購入の反映は新規販売条件と分離。反映ソースの一致、既存JWT設定、OPTIONS 200 / 未認証POST 401を確認。
- 修正済みWebは表示済み購入見積もりを購入開始時に消費し、同じ確認画面から再購入させない。ネイティブは課金直前に未完了取引を再確認し、検証不能な未完了取引を無視しない。
- アプリ173件・Worker14件成功。22a504bのRelease preflight #88、iOS #68、Worker #35は全て成功。署名なしコンパイルと実機購入は別。
- release `2026.11.02-1`、最小build31。Web SHA256 `8b3baffb9e30f5003701ae2599f3fa2f077012b68a5717ff00b36cf632f9d696`。Native SHA256 `27cab8ce99eda7e8516fbe4c0eda72c68f9573a3647d3fda489a7b572edb30d0`。
- 直接確認時点でApple payments 0、Apple/Webのprepared job ordersはいずれも0。既存注文の削除・失効処理は実施していない。
- Stripe本番口座の利用可能・保留・Connect reserve残高はJPY 0。これは全期間の売上ゼロを意味しない。接続ツールにSandbox口座は表示されなかった。

## 未完了：こちらの実装・統合検証

1. Apple実売上の配分台帳から出品者への送金作成、送金結果照合、返金後の回収・調整、銀行入金証跡と退会制限の連動。既存の配分台帳だけでは精算完了ではない。Stripeへの非Stripe収入の資金供給は日本対応だが、この口座の承認・実入金経路は未確認。
2. Apple承認待ち購入がアプリ再起動・再表示をまたぐ場合の再購入防止、放置された予約とWeb購入への切替。`Transaction.unfinished` が空でもAsk to Buyの取り消し証明にはならない。予約の時間切れ削除、強制取消、別経路での再課金を実装してはならない。
3. 実環境の双方アカウントを使う通常購入・募集購入・与信更新・受取確定・返金の一連の検証。現行refund-paymentは全残額返金の経路であり、部分返金の成功証跡はない。

残高不足や本人認証だけが未完了理由ではない。上記の実装を完了したと報告しない。

## 本人・外部環境の確認が必要な工程

- App Store Connectは今回ログイン画面へ戻った。現在の選択ビルド、審査用ログイン、商品メタデータ、契約状態は再確認できていない。
- iPhoneでの署名済み候補のインストール、通常購入、Gold/Platinum、キャンセル、承認待ち、再起動、納品・受取・返金、審査動画。以前のSilverの確認を全プラン成功に拡張しない。
- 実際のApple財務レポートと入金、Stripe資金供給の承認、送金・銀行着金の証拠。テスト成功から金銭移動成功を推定しない。

## 署名済みbuild31のアップロード

2026-11-02 08:52 JST、既存Capawesome接続でbuild31を署名・App Store Connectへアップロード成功。ソースは `abba99f7c970503eff29ab0ffaa3ae3bf0b166aa`（22a504bと同じアプリコード）。

- GitHub distribution #8: https://github.com/mewmitrastudio-hue/voice-flea-market/actions/runs/41363979986
- Capawesome build: `9f20ff6a-4e8a-4e3b-aa7b-074c662731ee`
- Deployment: `94de1c05-243b-4763-a51a-316db83bc93c`
- ログは署名IPA作成・Apple App ID 6817161473へのバイナリーアップロード成功を示す。
- `skip_waiting_for_build_processing` のためApple側処理完了・テスター配布可能状態までは確認していない。実機インストール、審査用ビルド選択、審査提出は未実施。

## 実機検証の記録方法

二つの許可済みテストアカウントで、環境・build番号・対象ID・時刻・期待結果・実際の結果を記録する。秘密鍵やパスワードは記録しない。

| ケース | 合格条件 |
|---|---|
| 通常購入 / 募集購入 | 認証済み買主、正しい相手・商品・JPY金額。課金1回、取引・会話の関連1件 |
| 販売者設定不足 | Apple課金画面へ進まない。注文予約を新規に残さない |
| キャンセル / 連打 | 同じ表示済み見積もりから2回課金しない。取消を購入済み扱いしない |
| 承認待ち / 再起動 | 反映確認が再課金しない。遅れて届いた購入を正しい取引へ1回だけ反映 |
| 納品 / 受取 | 買主だけが受取確定。Webは確認済みcapture/transfer、Appleは再検証した購入に基づく |
| 全額 / 部分返金 | 署名済み通知と正しい取引で照合。取消済み取引の納品や二重精算を防止 |
| 退会 | 未完了取引・未精算・返金調整を消さない。解消後のみ許可 |

金銭移動・実機・未完成の実装を含む上記条件が揃うまでmain統合・一般販売・Apple審査提出は行わない。

## 追加修正：2026-11-02 09:19 JST

- `0a99092fe55d2ce4cd5ac9c362943530a9b3a4ee`：StoreKitを開く前に端末へ購入記録を原子的に保存。アプリを再起動しても記録を読み、未確定購入があれば新規購入を止める。検証不能・破損・書込み失敗は購入開始を拒否。明示的なキャンセル、またはサーバー反映後の一致する商品ID・注文UUIDによるfinishのみ解除する。
- 空の未完了取引一覧を承認待ち終了の根拠にしない。音声とブースト双方のUIで未確定記録を扱う。別商品・別注文のfinishでは購入記録を消さない。
- ネイティブ候補はrelease `2026.11.02-2` / build32。Web SHA256 `4f4736d4b0158e9e9e7f48ed8b69c47340387f00af854ea202844b7c8d00e863`、Native SHA256 `b27537193fec2cf70a420ce008067dfabb7e2071cda340c2a1686252ccb9802c`。
- 0a99092のRelease preflight #91、Worker #38、iOS #71は全成功。Mac上の実Swift保存・再起動・重複防止・別注文解除拒否・破損・書込み失敗テスト、およびシミュレータとiPhone Releaseコンパイル成功。build32は未署名・Apple未アップロード。アップロード済みbuild31にはこの端末保存修正を含まない。
- `9aa3590807e9fdc7573125a9c4f00a1db921c83c`：通常商品について、Apple/Webの購入予約に共通ロックを追加し、相手経路の未確定予約や未完了購入・与信・部分返金を先に確認する。確認済みWeb予約終了を経ずにAppleへ切り替えない。Apple予約の時間切れ解除は行わない。
- 上記SQLをSupabaseへ反映済み。両関数の本体MD5はローカルと一致（Web `f86d4f96d064862026222e17b5293bc9` / Apple `2470110ae3c79b0651d1e85f9b093789`）。既存のsellerId返却、service_role限定実行、空のsearch_pathを維持。既存データの両経路未確定予約の重複は0組。新規注文・送金・返金は実行していない。
- 追加SQLを含む全アプリテスト177件成功。セキュリティ検査はERRORなし、既知のWARNのみで新たな権限公開なし。

### 残る制約

端末記録は再インストールや別端末まで保証しない。Apple側で承認が取り消された場合の証明取得・未確定記録解除、放置されたサーバー予約の解消は未完了。安全のため経路変更を拒否することと、予約解消まで実装済みであることは別。

Apple精算の送金作成・照合・返金回収・銀行着金・退会制限の連動は引き続き未実装。本人認証と実機検証だけが残っているとは報告しない。本番main統合、販売有効化、審査提出なし。

CLIの外部分析サービス通信は自動承認レビューに拒否された。再試行せず、作成済みSQLを直接連携で反映したため、この拒否による未反映作業はない。

## 追加修正：2026-11-02 09:32 JST — Apple配分のDB制約整合

実スキーマを含む統合テストで、配分処理がpayments_channel_evidence制約に違反することを再現。従来の最小台帳テストでは検出できていなかった。配分額は専用apple_proceeds_allocations台帳にのみ保存し、Apple決済のplatform_fee_jpy/seller_amount_jpyはNULLを維持するよう修正した。決済の証拠制約を緩めていない。

配分後もProduction Appleの出品者はsettlement_waitとして表示し、購入者の完了表示と第三者からの非表示を維持。既存の返金後調整・二重配分防止・管理者制限のテストも成功。全アプリテスト177件成功。

Supabase migration 20261102003116を反映済み。関数本体MD5はpending_trade_summary=d6ed36392272dce262358693bf58acf8、allocate_apple_proceeds=57b827282a0bff8fe8541d7e94ded9c9でローカルと一致。authenticated限定の既存権限と空search_pathを維持。反映前の既存配分は0件。売上配分・送金・返金などの実取引は作成していない。

この修正は配分処理の不具合修正であり、送金照合・返金回収・銀行着金連動の完成ではない。build32の署名/アップロード、実機検証、未確定予約の解消も引き続き未完了。

## 追加確認：2026-11-02 — build32配布・送金証跡照合

- build32を10:30:52 JSTにApp Store Connectへアップロード成功。ソースe4c7535b5766e3d6f08991eaa69fa56b87e9f00f。GitHub distribution #9: https://github.com/mewmitrastudio-hue/voice-flea-market/actions/runs/41372593623 。Capawesome build d423c6f6-ba94-44e6-8a3f-e2f15f86b1c5、deployment 1b00389f-6632-4ff5-85f8-3969f5f5dce2。Apple側の処理完了・TestFlight表示・実機成功・審査提出は未確認。上記のbuild32未アップロードという過去時点の記述を更新する。
- Web受取のStripe Transfer照合を共通化・厳格化。object、ID、相手、金額、通貨、本番/テスト、元決済、取消額・取消フラグの整合を検証。不一致と部分/全額取消では受取を確定しない。Stripe残高への送金と銀行着金を分離し、銀行着金は常に未確認と返す。
- 全アプリテスト181件成功。実エンドポイントのハーネスでも不一致時に台帳記録・受取確定RPCへ進まないことを確認。
- Supabase accept-delivery / renew-authorization / cancel-authorizationを各v4へ反映。取得した全配布ファイルがローカルと一致、verify_jwt=trueを維持。既存配布との差分はreceipt-captureと新規transfer-evidenceのみ。
- 今回の変更でApple配分からの送金作成、返金回収、銀行着金・退会連動が完成したわけではない。実送金・返金・一般販売・main統合・Apple審査提出は実施していない。

## 追加修正：2026-11-02 — 返金後の出品者精算と退会

実際の退会準備関数を使った回帰テストで、Apple売上の配分後に全額返金されると、adjustment_requiredの配分が残っていても出品者の退会が許可される不具合を再現した（修正前6成功・1失敗）。

apple_settlement_pending_for_userにallocated_unpaid/adjustment_requiredの出品者配分を確認する条件を追加。既存の未精算Production売上の条件も維持。調整中は退会記録を作らず、出品も無効化しない。購入者への返金が完了している場合、出品者側の精算待ちを購入者へ転嫁しない。配分のない全額返金に架空の精算待ちを作らない。

退会・返金・配分の関連テスト11件成功。Supabaseへ反映済み。配布関数本体MD5はb7272913630ee4138d8a2b4bd9fc1df7でローカルと一致。空search_pathとanon/authenticated直接実行不可を維持。セキュリティ検査は変更前後で同じ既知WARN、ERRORなし。実際の退会・送金・返金は実行していない。

これは未解決の精算を保護する修正。送金作成、回収・調整完了、銀行着金証跡の実装・実取引確認が完了したことを意味しない。

## 追加実装：2026-11-02 — Apple精算の送金予約・証跡

Apple配分台帳に結びついた一意の送金予約、送金直前の署名・失効・受取能力・残高確認、DBロックによる一度だけのdispatch、取得し直したStripe送金証跡の保存を実装。通信切断・記録失敗後も予約を初期化しない。返金後のadjustment_requiredと銀行着金未確認を維持。新規12件を含む全195テスト成功。

本番migration 20261102040815、apple-settlement v1、stripe-webhook v21反映・全ソース一致確認。未認証401。配分・予約とも0件で実送金なし。Stripe通知イベント追加は認証要求が繰り返され未確認。設定有効化、資金供給承認、外部送金の実地検証、自動回収、部分返金精算、銀行着金突合、精算後の退会解除は残る。詳細はAPPLE_SETTLEMENT_OPERATIONS.md。精算全体・審査準備の完了とは報告しない。


## 2026-11-02 06:00 UTC — verified progress, not release completion

- Build 33: source `7a6dc754770b774f41988573c4bf3c28ce5832cc`; GitHub distribution run `41395716110` succeeded. Capawesome build `23222212-4ef2-47e6-aaa9-a77171b26ca6`, deployment `8fbfca2d-a25d-42c9-827a-6d8e65099c2e`. App Store Connect binary upload succeeded at 05:47 UTC. Processing/testing availability was NOT checked: browser is signed out. No review submission.
- Existing isolated Stripe sandbox `acct_1UEbZAIUiTTiT5wG`: simulated JPY 1,000 funding; test transfer `tr_1UXE67IUiTTiT5wGYSQkdUlz` for JPY 541 to existing fake test recipient `acct_1UEfvAIUiTtY4ux4`. Reversals `trr_1UXE6WIUiTTiT5wGFfKFoA45` (100) and `trr_1UXE70IUiTTiT5wGQw4uHDoO` (441). Fresh transfer retrieval confirmed amount_reversed=541, reversed=true, livemode=false. This proves Stripe sandbox mechanics only, not production funding or application end-to-end delivery. No real money moved.
- Apple settlement recovery journal migration applied; apple-settlement Edge v2 ACTIVE, JWT verification enabled. Recovery requires fresh authoritative Apple revocation and database-confirmed full refund. Durable one-shot claim prevents a second reversal after unknown response. Explicit reconciliation retrieves Stripe evidence. Financial adjustment remains pending and account deletion remains blocked.
- Full local suite: 198 passed, 0 failed. Security advisor has no new recovery RPC exposure; private RLS table intentionally has no client policies. Existing unrelated advisories remain.
- Production funding approval, real bank payout reconciliation, refund report allocation/partial refund adjustment and terminal resolution of ambiguous StoreKit pending remain incomplete. Do not label groups 1–4 complete or the app ready for review/recording on this evidence.
