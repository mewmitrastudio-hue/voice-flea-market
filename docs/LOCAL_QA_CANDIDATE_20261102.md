# 2026-11-02 相棒ローカルQA候補34

## 適用範囲
基点: PR35 head `438079fa50b9043d9ea87494a9400035b69f19cd`。
候補: `2026.11.02-4` / minimum build34。既存build33、公開Web、mainとは別の未配布候補。
本番DB・設定変更、リモートpush、実決済、返金、送金、実退会、Apple提出は行っていない。

## 再現して修正した問題
1. 退会のセッション取得中にアカウントが切り替わると、確認した本人と異なる主体で削除要求できる競合。確認主体を固定しsession.user一致を必須にした。
2. 出品・プロフィールのアップロード待機中にアカウント/フォームが変わると、別利用者や途中変更内容で保存される競合。入力・主体を開始時固定し継続前後に検証。
3. ブロック確認中の対象変更で、確認していない相手をブロックする競合。主体・対象固定。
4. 通知読込失敗を「通知なし」に見せる問題。失敗を表示、既存バッジ保持、一括既読書込中止。
5. チャット送信成功の応答だけ失われる場合の再試行重複。端末内に本文SHA256に紐付くUUIDを永続保存し、同IDの本人/会話/本文一致を照会して再確認。同ID以外で自動再送しない。保存不能なら送信開始しない。本文自体を追加で保存しない。
6. 音声/Boost共通の未反映購入が反対側の画面で処理されず誤案内となる問題。未完了種類をネイティブから返し、正しい反映画面へ誘導。未確定購入のタイムアウト解除や勝手な再課金はしない。

## 検証の意味
- 自動テストは実コードをVM/ローカルPGlite/Stripe・Appleモックで検証。実端末・実送金の証拠ではない。
- Sandbox Apple決済を本番送金フラグONで入力してもEdge409、送金claim/create/recordが0である追加テストを実行。
- 実DBに対して行ったのはmessagesスキーマ/主キー/権限/RLSおよび退会処理定義のSELECTのみ。メッセージ本文取得・書込なし。
- チャットID方式は同一端末の永続保存の範囲。別端末/同時タブ間の完全な一回送信保証、利用者による記録削除後の保証はしない。
- 元アカウントのアップロード完了後にアカウントが切り替わる場合、孤立ファイルを別アカウントで削除しない。サーバー所有の安全な清掃は別課題。

## 未完了・リリースゲート
- Apple部分返金の未決費用・端数・回収不足の債務配分。承認済みの資料照合・銀行承認ワークフローは後段の追加実装参照。実資料照合と本番適用は未実行。
- Appleの曖昧な承認待ち/放置予約を、証拠なしに消さず解消する最終経路。
- Production資金供給承認と実資金の証跡。Sandbox成功を銀行着金として扱わない。
- この候補のSwift実行・iOS Simulator/Release compile・署名・TestFlight配布。現在環境にSwift/Xcodeなし。
- ローカルChromiumはsocket permissionで起動失敗し画面QA未実行。実iPhoneで登録/ログイン、出品・音声、購入/納品/受取/返金、3Boost、通報/ブロック/退会を確認。
- 審査向けメタデータ、IAP、ログイン、動画。録画は上記の動作確認後。

自動テストが成功しても「完成品」「録画だけ」「申請ボタンだけ」とは報告しない。

## テスト中に検出した統合不具合
初回全体テストでは234件中233件成功、1件がチャットの直接localStorageアクセスと既存ストレージ共通化ルールの衝突を検出した。ルールのテストを弱めず、共通facadeに永続保存必須API（disk readback、fallbackなし）を追加して修正。既存の通常UI用メモリfallbackは維持。拒否・容量不足・正常・黙示失敗・古いメモリcacheの5ケースを追加。

ローカル再現コマンド: `node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`。Worker: `node --test workers/apple-verifier/test/*.test.mjs`。候補bundle: `CI_BUILD_NUMBER=34 npm run capawesome:build && npm run ios:verify`。

## 最終ローカル検証結果（13:54 UTC）
- アプリ全体: 239件成功、失敗0、skip0（逐次実行、約103秒）。
- Apple署名Worker: 14件成功、失敗0。
- Web/iOS bundle生成・同期・ハッシュ整合: 成功。ローカルbuild番号34。
- Web SHA256: `4f0ffdef872fabd41a4175892c1afcf03169cdae8334cd7efb6778b7bcbc2742`。
- Native SHA256: `259971ce55b32bdb49946b86e66f450dc73ce7a59bb1425935165603121eee21`。
- `git diff --check`: 成功。
- Swiftコンパイル、署名・配布、実機/ブラウザ画面、実資金: 未実行。上記未完了ゲートは継続。
- 実行ログは `/workspace/shared/voice-qa-evidence/final-app-tests-v2.log`、`final-worker-tests.log`、`final-bundle-build.log`。

## 追加金融検証後の最終結果（14:15 UTC、上の239件checkpointを更新）
- アプリ全体: **289件成功、失敗0、skip0**（最終ソース固定、逐次、約107秒）。
- Apple署名Worker: **15件成功、失敗0**。
- Web/iOS候補bundle生成・同期・ハッシュ整合成功、minimum build34のまま。Web SHA256 `e2bd9876e92878a5b8c8c1a86de16417a2dec7eb9464233733039117aa78deef`。Native hashは上記と同じ。
- 部分返金を全額化する不具合を修正し、金額を推測しないdurable review holdを追加。DBマイグレーションはローカルCLI生成・PGlite検証のみ、本番未反映。
- pure payout evidence verifier 38ケースを追加。自動Payout所属とStripe paid確認の証跡整合のみ。銀行着金・精算完了を返さず、現行endpointへ未統合。
- 要照合holdのfinance画面通知と読取失敗/アカウント切替保護を追加。
- 最終ログ: `financial-app-tests.log`、`financial-worker-tests.log`、`financial-bundle-build.log`（/workspace/shared/voice-qa-evidence）。
- 詳細残件: FINANCIAL_RELEASE_GATES_20261102.md、APPLE_PAYOUT_EVIDENCE_DESIGN_20261102.md、STOREKIT_PENDING_GATE_20261102.md。

この追加修正は危険な進行を防ぐもので、部分返金の金額配分/最終精算/銀行照合を完成させたものではない。返金費用・端数・不足債務の扱い、銀行証跡の承認手順は既存仕様にないため勝手に決定していない。すべて未配布・実機未確認。

## 運営の原本照合承認ワークフロー（14:18 UTCの方針承認後）
- Apple返品の原本報告行と取引の対応付けをprivate台帳に記録。購入者への追加返金・売り手からの自動回収は行わず、不明費用・不足・端数は保留。
- Stripeの正しい接続アカウントから読み取り専用で完全ページ取得し、Appleの現在証拠も再確認。銀行明細原本の確認は運営が明示承認する。
- 全バッチが確定正額・手数料なし・合計一致で、正常未返金取引のみ精算完了へ進める。mixed fee/debitは証拠保存のみ。
- 送信結果不明は同じ操作IDの状態照会のみ。資料変更で旧SHA・承認チェックを消し、誤原本の承認を防ぐ。
- 本番用管理API・Webhook・DBマイグレーションはローカル候補のみ。権限拡大・実送金・本番反映・実退会は実行していない。
- MewMitraアカウント整理は dry-run 計画のみ。UID未特定、削除なし。最小審査素材と会計記録を保持する。

### 退会の最終財務チェックと外部副作用の順序
旧処理は公開Storage削除後にDBの退会完了処理を呼んでいたため、遅延返金で最終チェックが拒否しても公開素材だけ消える可能性があった。候補では計画検証→DB最終チェック/匿名化→公開Storage削除→signout→Auth softdeleteの順に修正。DB拒否時は外部削除0、Storage失敗時は従来のpendingサポート対応を維持。購入済みprivate納品物と会計記録は削除対象外。

## 最終固定ソースの検証結果（2026-11-02 14:48 UTC）
- アプリ全体：**346件成功、失敗0、skip0**（逐次、139.259秒）。
- Apple署名Worker：**15件成功、失敗0、skip0**。
- ローカルbuild34のbundle生成・同期・ハッシュ検証、git diff --check：成功。Swift compile・署名・配布は未実行。
- Web SHA256：`a3b885e99de2abf3c43e7f49b7347dad14be59c51ce1c06c57b29722ae14ecf6`
- Native SHA256：`259971ce55b32bdb49946b86e66f450dc73ce7a59bb1425935165603121eee21`
- 証跡：manual-app-tests.log、manual-worker-tests.log、manual-bundle-build.log。
- 再現：`node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`、`npm test --prefix workers/apple-verifier`、`CI_BUILD_NUMBER=34 npm run capawesome:build && npm run ios:verify`。
- リモートPR35 headは14:42 UTCに基点と同一であることを確認。変更49ファイルはローカルstagedのみ、commit/pushなし。
