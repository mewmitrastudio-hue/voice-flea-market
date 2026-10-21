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
    private var purchaseInProgress = false
    private var purchaseEnvironment: String { Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? "Sandbox" : "Production" }

    @objc func products(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                let items = try await Product.products(for: Array(allowed))
                call.resolve(["environment": purchaseEnvironment, "products": items.filter { $0.type == .consumable }.map {
                    ["id": $0.id, "displayPrice": $0.displayPrice, "displayName": $0.displayName, "currencyCode": $0.priceFormatStyle.currencyCode]
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
            guard let id = call.getString("productId"), allowed.contains(id),
                  let raw = call.getString("orderId"), let token = UUID(uuidString: raw) else {
                call.reject("出品とプランを確認してください。"); return
            }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            do {
                guard let product = try await Product.products(for: [id]).first, product.type == .consumable else {
                    call.reject("このプランはまだ購入できません。"); return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification, allowed.contains(transaction.productID) else {
                        call.reject("購入を検証できません。再購入せず購入の反映を確認してください。"); return
                    }
                    // Never finish before the server has durably granted the boost.
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
                if case .verified(let transaction) = result, allowed.contains(transaction.productID) {
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
                if case .verified(let transaction) = result, transaction.id == id, allowed.contains(transaction.productID) {
                    await transaction.finish()
                    call.resolve(["finished": true]); return
                }
            }
            call.resolve(["finished": true])
        }
    }
}
