import UIKit
import Capacitor
import StoreKit

// This code is appended to the existing SceneDelegate.swift by the preparation script.
class KoeBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(KoeBoostPlugin())
    }
}

@objc(KoeBoostPlugin)
public class KoeBoostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KoeBoostPlugin"
    public let jsName = "KoeBoost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise)
    ]
    private let allowed = Set(["silver", "gold", "platinum"].map { "com.ayuhide.koenofurima.boost.\($0)" })
    private func isAllowed(_ id: String) -> Bool {
        allowed.contains(id) || id.range(of: "^com\\.ayuhide\\.koenofurima\\.voice\\.jpy[1-9][0-9]{0,7}$", options: .regularExpression) != nil
    }
    private var purchaseInProgress = false
    private var purchaseEnvironment: String { Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? "Sandbox" : "Production" }

    @objc func products(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                let requested = call.getArray("productIds", String.self) ?? Array(allowed)
                guard !requested.isEmpty, requested.count <= 30, requested.allSatisfy({ isAllowed($0) }) else {
                    call.reject("商品を確認できません。"); return
                }
                let items = try await Product.products(for: requested)
                call.resolve(["environment": purchaseEnvironment, "products": items.filter { $0.type == .consumable }.map {
                    ["id": $0.id, "displayPrice": $0.displayPrice, "displayName": $0.displayName, "currencyCode": $0.priceFormatStyle.currencyCode, "price": NSDecimalNumber(decimal: $0.price).stringValue]
                }])
            } catch { call.reject("商品情報を取得できません。時間をおいて再試行してください。") }
        }
    }
    @objc func purchase(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.getString("environment") == purchaseEnvironment else {
                call.reject("購入環境の設定が一致しません。購入は開始していません。"); return
            }
            guard !purchaseInProgress else { call.reject("購入の確認中です。"); return }
            guard let id = call.getString("productId"), isAllowed(id),
                  let raw = call.getString("orderId"), let token = UUID(uuidString: raw) else {
                call.reject("出品とプランを確認してください。"); return
            }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            do {
                guard let product = try await Product.products(for: [id]).first, product.type == .consumable else {
                    call.reject("このプランはまだ購入できません。"); return
                }
                let boostAmounts = ["com.ayuhide.koenofurima.boost.silver": 300,
                                    "com.ayuhide.koenofurima.boost.gold": 800,
                                    "com.ayuhide.koenofurima.boost.platinum": 1500]
                guard let amount = boostAmounts[id] ?? call.getInt("amountJpy"),
                      product.priceFormatStyle.currencyCode == "JPY", product.price == Decimal(amount) else {
                    call.reject("出品・プランの価格とAppleの商品価格が一致しません。購入は開始していません。"); return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification, transaction.productID == id,
                          transaction.appAccountToken == token else {
                        call.reject("購入を検証できません。再購入せず購入の反映を確認してください。"); return
                    }
                    // Never finish before the server has durably granted the purchase.
                    call.resolve(["status": "purchased", "transactionId": String(transaction.id), "signedTransaction": verification.jwsRepresentation])
                case .userCancelled: call.resolve(["status": "cancelled"])
                case .pending: call.resolve(["status": "pending"])
                @unknown default: call.reject("購入結果を確認できません。購入の反映を確認してください。")
                }
            } catch { call.reject("購入処理を確認できません。購入済みの場合は購入の反映を確認してください。") }
        }
    }
    @objc func pendingTransactions(_ call: CAPPluginCall) {
        Task { @MainActor in
            var rows: [[String: String]] = []
            for await result in Transaction.unfinished {
                if case .verified(let transaction) = result, isAllowed(transaction.productID) {
                    if let kind = call.getString("kind"),
                       (kind == "voice" && !transaction.productID.contains(".voice.")) ||
                       (kind == "boost" && !allowed.contains(transaction.productID)) { continue }
                    rows.append(["transactionId": String(transaction.id), "signedTransaction": result.jwsRepresentation])
                }
            }
            call.resolve(["transactions": rows])
        }
    }
    @objc func finish(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let raw = call.getString("transactionId"), let id = UInt64(raw) else { call.reject("購入番号を確認できません。"); return }
            for await result in Transaction.unfinished {
                if case .verified(let transaction) = result, transaction.id == id, isAllowed(transaction.productID) {
                    await transaction.finish()
                    call.resolve(["finished": true]); return
                }
            }
            call.resolve(["finished": true])
        }
    }
}
