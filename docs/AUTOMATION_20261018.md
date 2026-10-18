# 声のフリマ 自動整備の運用

## 設定する自動処理

| 処理 | 実行する時 | 自動で行うこと | 行わないこと |
| --- | --- | --- | --- |
| Release preflight | main向けPR、関連ファイルのmain更新 | npmの固定依存関係を導入、テスト、ソースのハッシュと版・組み込みを確認 | 本番データの変更、署名付き配信 |
| Verify and build iOS app | mainのiOS関連更新 | 既存のDebug/Releaseコンパイル確認。古い同一ブランチの実行を取り消す | App Store一般公開 |
| Public Web health | 毎朝7:23日本時間ごろ、Web関連更新 | 2つのHTTPS URL、HTTP 200、アプリのHTML、最新版番号を確認。失敗時は再試行し結果をActionsに記録 | ログイン、DBへの書き込み、課金 |
| Dependabot | 毎週月曜 | npmとGitHub Actionsの更新候補PRを作成。Capacitor関連はまとめる | 自動マージ、有料プラン契約 |
| Capawesome既存自動化 | release/ios更新 | 既存の署名設定でビルドし、既存のApp Store Connect宛先へ送信 | Appleの審査通過や一般公開の保証 |

GitHubの定刻処理は遅延することがあり、公開リポジトリが長期間更新されない場合は停止されることがあります。常時監視ではありません。
Actionsの失敗は実行結果で確認できます。メール通知の到着はGitHubの本人側通知設定に依存し、未確認です。

## 費用と権限

GitHub公開リポジトリの標準ランナーを使用。有料ランナー、外部監視契約、新しいAPIキー、個人トークンは追加しません。新しいワークフローの権限はcontents: readのみ。既存のSupabase手動配信は変更しません。
Capawesomeは従来の契約・利用枠を消費するため、日次確認や依存更新PRからはビルドを起動しません。release/iosの更新を意図的な配信操作として残します。新たな支払いは承認なしで実行しません。
この変更はブランチ保護の必須チェック設定を変更しません。チェック失敗時にマージを管理者権限で強制的に禁止できる状態とは断定しません。

## 2026-10-18の確認済み

- Capawesomeの自動化作成・有効化、ビルド10成功、配信成功。
- App Store Connectに1.0(10)到着。内部テストグループ1件・テスター1人。本人の起動画面で下端の残りの見切れを確認。
- 追加修正2026.10.18-2をPR #5でmainへ反映、release/ios更新。GitHubのWeb配信・iOS Debug/Release確認は成功。
- 2つの公開URLをHTTP 200・2026.10.18-2として読み取り確認。
- ビルド11以降の署名付き配信・実機表示は未確認。今回の自動化整備ではrelease/iosを追加で動かしません。

## 本人の操作・判断が残ること

- Stripeの機密操作認証の復旧、必要な本人確認。サポートへの追記送信の完了は未確認。
- Appleの契約・税務・銀行・販売方式など本人の判断を必要とする確定。Apple .p8問い合わせは回答未確認。
- 最終ビルドの実機テストとApple指定の画面録画。起動から通常の流れ、登録・ログイン・退会、通報・ブロック、有料コンテンツ利用を含める。
- iOSの通常音声販売の決済方式、日本向け条件、商品・鍵・通知・Sandbox検証、審査用アカウント、プライバシー・配信地域を最終確認。

Stripe接続経由の読み取り成功は、アプリサーバーの本番キー設定が完了した証拠ではありません。ブースト購入は無効を維持します。

## 公式情報

- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file
