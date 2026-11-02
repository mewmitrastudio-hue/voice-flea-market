# Apple精算の運用と未完了項目（2026-11-02）

## 現在の到達点

Apple財務レポートからの確定配分 → 固定した送金予約 → Stripe送金の一度だけの実行 → Stripeから取り直した証跡の保存、までを実装した。送金APIは初期状態で無効。本番の売上・配分・送金はこの作業で作成していない。

これは銀行着金までの精算完成を意味しない。Appleの配分台帳と退会保留は引き続き残す。

## 前提

- `APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID` は運営Stripe口座IDと一致すること。現在の対象は `acct_1UEbZ0IMjQxpA8It`。設定済みとは未確認。
- `APPLE_SETTLEMENT_TRANSFERS_ENABLED=true` と `APPLE_SETTLEMENT_FUNDING_APPROVED=true` の両方が必要。今回設定していない。
- Apple実収益のStripe残高への資金供給経路・プラットフォーム承認を確認する。銀行口座の登録だけではこの確認にならない。
- 出品者の受取口座はサーバーのprofilesから読み、Accounts v2の受取能力を直前確認する。
- 額・通貨・受取先はクライアント指定を使わない。Apple財務レポートの配分済み額を用い、JPYの利用可能残高が足りなければ停止する。
- Production Apple署名検証と失効確認を再実行する。Sandbox購入は対象外。

## API

`POST /functions/v1/apple-settlement`。管理者のユーザーJWTが必要。一般ユーザーは利用不可。

- `{"action":"prepare","paymentId":"対象UUID"}`: 配分・納品受取完了・返金・受取先を確認して予約を作る。同じpaymentIdは同じ予約になる。送金しない。
- `{"action":"dispatch","paymentId":"対象UUID"}`: 全条件と有効化設定を確認した上で、一度だけ送金を要求する。
- `{"action":"reconcile","paymentId":"対象UUID","transferId":"確認済みtr_ID"}`: 対象口座のStripeから送金を再取得して、予約ID・取引ID・金額・通貨・受取先・本番環境を照合する。新しい送金を作らない。

実データがない状態で動作確認のためにdispatchしない。確認用の仮の財務レポートや残高も作らない。

## 通信失敗・返金

一度dispatchを取得した予約は、通信切断・DB保存失敗・Stripe側のエラーでもpreparedへ戻さない。Stripeの冪等キーの保存期間を超えて再実行することで二重送金される危険を避ける。送金の成否不明なら、Stripeで予約metadataに一致する実物の送金を特定してreconcileする。送金が見つからないことだけを理由に再送しない。

返金が送金直前に入ればDBロック内の再確認で停止する。送金要求後の返金は既存のadjustment_requiredを維持し、送金の証跡を失わない。回収済額は減らせず、別の送金IDへの差し替えは不可。

自動回収・部分返金の配分再計算・銀行入金の個別突合・調整完了と退会解放は未実装。全額の送金取消が確認できても、それだけで財務上の調整完了にはしない。実際の銀行着金を確認していない。

## Webhook

既存の署名・モード確認後、transfer.created / transfer.updated / transfer.reversedで対象予約を照合する。通知の古い金額を使わず、Stripeから最新の送金を再取得する。DB保存失敗は503で再配信を要求する。Webhookから送金は作らない。

Stripe既存エンドポイント `we_1UQwAXIMjQxpA8ItQSPza3m6` は、許可済みの管理画面から更新済み。アクティブ・13イベントを確認した。既存8イベントを維持し、次の5イベントを追加した：

- payment_intent.canceled
- refund.created
- transfer.created
- transfer.updated
- transfer.reversed

最初の2つは既存ハンドラに処理があるが、従来の実設定に含まれていなかったもの。URL・APIバージョン・署名シークレットは変更していない。設定成功と実イベント配信成功は別で、送金イベントの実地検証は未完了。

## 検証・反映

- 全アプリテスト195件成功。新規12件はSQL実行、送金処理、Edge認証、署名付きWebhookを検証。
- 本番migration: 20261102040815 apple_settlement_dispatch_journal（ローカルCLI生成名は20261102040116）。
- apple-settlement v1、stripe-webhook v21を反映。取得した全ソースがローカルと一致。
- 未認証POSTは401。公開RPCはinvoker、claim/record/getはservice_role限定。prepareは管理者確認付き。
- 台帳はprivate schema、RLS有効、一般利用者の直接アクセス不可。追加のRLS no-policy通知は意図した遮断。既存の別件アドバイザー警告は今回変更なし。
- 本番配分0件、送金予約0件。実課金・送金・返金・入金・販売有効化・Apple審査提出は行っていない。

## 次の工程

1. 資金供給承認・設定を確認する。管理画面にはConnect送金用決済残高への「資金を追加」が表示された。金額入力・申請・実入金は実施していないため、資金供給完了とは扱わない。
2. 返金調整の回収処理と、実際の銀行入金に結びつけた照合・退会解除を実装する。
3. 利用可能な隔離テスト環境で送金・取消・通知再送を検証してから本番送金有効化を判断する。API連携は本番口座だけだが、管理画面には既存の「声のフリマサンドボックス」`acct_1UEbZAIUiTTiT5wG` があり、切替先URLを確認した。APIアクセス・外部送金の実地テストは未確認。


### Verified full-refund recovery (2026-11-02)

`apple-settlement` now accepts moderator-authorized `recover` and `reconcileRecovery` actions. Recover remains disabled unless APPLE_SETTLEMENT_TRANSFERS_ENABLED is true. It verifies the Apple transaction again, requires a full verified refund, retrieves the original Stripe transfer, then claims the remaining recoverable amount once in `apple_settlement_recoveries`. A timeout must be handled with `reconcileRecovery` and an existing Stripe reversal ID, never by resetting the claim. The reconciliation checks both transfer and reversal metadata, frozen amount, currency and transfer identity. Client-supplied refund amounts are not used. Partial buyer refunds are deliberately rejected until report-backed adjustment is implemented.

A successful recovery is NOT final settlement: Apple report debits, any remaining seller liability, and bank payout reconciliation still need evidence. No deletion guard is released by this endpoint.
