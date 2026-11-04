# StoreKit未確定購入：局所修正可能範囲と停止条件

## 現在のコード
- BoostPlugin.swift のKoePurchaseJournalは購入前にproduct/tokenを永続化し、userCancelledまたはサーバー反映後の一致finishのみ解除。
- server apple_voice_orders はprepared/paid/revoked。Appleの未確定注文があればWeb側購入をロック。
- 今回候補では別種類（voice/boost）のunfinishedも検知し、正しい反映画面を案内した。空unfinished、再インストール、時間経過で解消したことにしない。

## 外部仕様で確認した限界
Apple公式『Testing Ask to Buy in Xcode』は、承認待ち→却下の場合アプリにtransactionが届かないと説明している。
https://developer.apple.com/documentation/storekit/testing-ask-to-buy-in-xcode

pending成功時はTransaction.updatesに届く。
https://developer.apple.com/documentation/storekit/product/purchaseresult/pending

したがって空Transaction.unfinishedを「却下/キャンセル済み」証明にし、server予約削除・別経路再課金を許可する変更は安全に導けない。現在の実装は安全側で停止するが、そのままでは自動解消は完成していない。

## 局所で決まる作業
- 原購入のverified transactionが到着した場合の正確な反映と一度だけfinishを維持/検証。
- 未確定の理由・本人/商品/経路を誤表示しない。今回種類判定と案内修正済み。
- 次段階では起動/復帰のTransaction.updates購読と既存認証済みサーバー照合の接続を実装可能。ただしSwift/XcodeでのコンパイルとAsk to Buy承認/却下/再起動実機シミュレーション環境が必要。署名待ちの取引を購読のみで成功/取消とはしない。

## 追加で必要な判断/証拠（選択肢）
1. 安全優先の暫定運用：未確定購入は原経路の反映確認と問い合わせのみ、別経路の再購入は止める。販売準備完了ではなく残る利用制限として明示する。
2. 自動解消を必須にする：Appleの当該購入に結びつく確実な取消/終了証拠の取得設計を確認し、監査記録とサーバーロック下でのみ解消。現時点のコード/APIにその証拠取得経路はない。利用者の自己申告・空履歴・待ち時間を代替しない。

再現試験に必要：Mac/XcodeのStoreKit Test、当該商品のStoreKit configuration、候補ソース、実端末では最新候補TestFlightと許可済みSandboxアカウント。承認待ちを作った実アカウントの履歴を勝手に削除しない。
