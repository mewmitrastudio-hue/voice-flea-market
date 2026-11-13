import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = KoeBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// KOEFURIMA_NATIVE_BOOST_BEGIN
import UIKit
import Capacitor
import StoreKit

// KOEFURIMA_PURCHASE_JOURNAL_BEGIN
// Persist before opening StoreKit. An empty unfinished stream is not proof
// that an Ask to Buy request was cancelled. Never expire this record by time.
struct KoePurchaseAttempt: Codable, Equatable {
    let productID: String
    let token: UUID
    let schemaVersion: Int?
    let backendProjectRef: String?
    let storeKitEnvironment: String?
    let transactionID: String?
}
struct KoePurchaseJournal {
    let url: URL
    private func failure() -> NSError { NSError(domain: "KoePurchaseProvenance", code: 1) }
    func read() throws -> KoePurchaseAttempt? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(KoePurchaseAttempt.self, from: Data(contentsOf: url))
    }
    func read(backendProjectRef: String, environment: String) throws -> KoePurchaseAttempt? {
        guard backendProjectRef.range(of: "^[a-z]{20}$", options: .regularExpression) != nil,
              ["Sandbox", "Production"].contains(environment) else { throw failure() }
        guard let attempt = try read() else { return nil }
        guard attempt.schemaVersion == 2, attempt.backendProjectRef == backendProjectRef,
              attempt.storeKitEnvironment == environment else { throw failure() }
        if let transactionID = attempt.transactionID,
           transactionID.range(of: "^[0-9]{1,40}$", options: .regularExpression) == nil { throw failure() }
        return attempt
    }
    private func persist(_ attempt: KoePurchaseAttempt) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(attempt).write(to: url, options: .atomic)
        guard try read() == attempt else { throw failure() }
    }
    func begin(productID: String, token: UUID, backendProjectRef: String, environment: String) throws {
        // The one global file is intentional: another namespace must not hide legacy obligations.
        guard try read(backendProjectRef: backendProjectRef, environment: environment) == nil else { throw failure() }
        try persist(KoePurchaseAttempt(productID: productID, token: token, schemaVersion: 2,
            backendProjectRef: backendProjectRef, storeKitEnvironment: environment, transactionID: nil))
    }
    func recordVerifiedGrant(productID: String, token: UUID?, transactionID: String, backendProjectRef: String, environment: String) throws {
        guard let attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.productID == productID, attempt.token == token,
              transactionID.range(of: "^[0-9]{1,40}$", options: .regularExpression) != nil,
              attempt.transactionID == nil || attempt.transactionID == transactionID else { throw failure() }
        try persist(KoePurchaseAttempt(productID: attempt.productID, token: attempt.token, schemaVersion: 2,
            backendProjectRef: backendProjectRef, storeKitEnvironment: environment, transactionID: transactionID))
    }
    func clearCancelled(productID: String, token: UUID, backendProjectRef: String, environment: String) throws {
        guard let attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.productID == productID, attempt.token == token, attempt.transactionID == nil else { throw failure() }
        try FileManager.default.removeItem(at: url)
    }
    func clearFinished(productID: String, token: UUID?, transactionID: String, backendProjectRef: String, environment: String) throws {
        guard let attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.productID == productID, attempt.token == token,
              attempt.transactionID == transactionID else { throw failure() }
        try FileManager.default.removeItem(at: url)
    }
}
// KOEFURIMA_PURCHASE_JOURNAL_END

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
    // The normal marketplace uses only its original backend. Existing legacy or
    // foreign journal data is never migrated, cleared or attributed by inference.
    private let backendProjectRef = "tyulybijubckitybgubc"
    private var purchaseInProgress = false
    private func purchaseJournal() throws -> KoePurchaseJournal {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return KoePurchaseJournal(url: directory.appendingPathComponent("koe-purchase-attempt.json"))
    }
    private func purchaseEnvironment() async throws -> String {
        if #available(iOS 16.0, *) {
            // A TestFlight install may not have an app receipt yet. Absence is
            // not evidence of Production. Use Apple's verified app transaction.
            let result = try await AppTransaction.shared
            guard case .verified(let transaction) = result,
                  transaction.bundleID == Bundle.main.bundleIdentifier else {
                throw NSError(domain: "KoeStore", code: 1)
            }
            if transaction.environment == .sandbox { return "Sandbox" }
            if transaction.environment == .production { return "Production" }
            throw NSError(domain: "KoeStore", code: 2)
        }
        // iOS 15 has no AppTransaction. Only recognize explicit receipt names.
        switch Bundle.main.appStoreReceiptURL?.lastPathComponent {
        case "sandboxReceipt": return "Sandbox"
        case "receipt": return "Production"
        default: throw NSError(domain: "KoeStore", code: 3)
        }
    }

    @objc func products(_ call: CAPPluginCall) {
        Task { @MainActor in
            var failureCode = "KOE_PRODUCTS_LOOKUP"
            do {
                let requested = call.getArray("productIds", String.self) ?? Array(allowed)
                guard !requested.isEmpty, requested.count <= 30, requested.allSatisfy({ isAllowed($0) }) else {
                    call.reject("商品を確認できません。"); return
                }
                let items = try await Product.products(for: requested)
                failureCode = "KOE_PRODUCTS_ENVIRONMENT"
                let environment = try await purchaseEnvironment()
                // Read immediately for this request; never persist a customer's
                // storefront as profile data or infer currency from device locale.
                let storefront = await Storefront.current
                call.resolve(["environment": environment, "storefrontCountry": storefront?.countryCode ?? "", "products": items.filter { $0.type == .consumable }.map {
                    ["id": $0.id, "displayPrice": $0.displayPrice, "displayName": $0.displayName, "currencyCode": $0.priceFormatStyle.currencyCode, "price": NSDecimalNumber(decimal: $0.price).stringValue]
                }])
            } catch { call.reject("商品情報を取得できません。時間をおいて再試行してください。確認コード：\(failureCode)", failureCode) }
        }
    }
    @objc func purchase(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard #available(iOS 18.0, *) else { call.reject("安全な購入復旧にはiOS 18以降が必要です。購入は開始していません。"); return }
            guard !purchaseInProgress else { call.reject("購入の確認中です。"); return }
            guard let id = call.getString("productId"), isAllowed(id),
                  let raw = call.getString("orderId"), let token = UUID(uuidString: raw) else {
                call.reject("出品とプランを確認してください。"); return
            }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            // Fixed local stage only: never expose StoreKit errors, IDs or signed data.
            var failureCode = "KOE_PURCHASE_ENVIRONMENT"
            do {
                let environment = try await purchaseEnvironment()
                guard call.getString("environment") == environment else {
                    call.reject("購入環境の設定が一致しません。購入は開始していません。"); return
                }
                failureCode = "KOE_PURCHASE_PRODUCT_LOOKUP"
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
                // Recheck at the point of purchase: approval may have arrived
                // after the JavaScript preview scanned unfinished transactions.
                for await outstanding in Transaction.unfinished {
                    switch outstanding {
                    case .verified:
                        // Unknown SKUs cannot be silently skipped between preview and charge.
                        call.reject("未反映の購入があります。再購入せず購入の反映を確認してください。"); return
                    case .unverified:
                        call.reject("未処理の購入を検証できません。新しい購入は開始していません。"); return
                    }
                }
                failureCode = "KOE_PURCHASE_JOURNAL_SAVE"
                let journal = try purchaseJournal()
                try journal.begin(productID: id, token: token, backendProjectRef: backendProjectRef, environment: environment)
                failureCode = "KOE_PURCHASE_STOREKIT"
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification, transaction.productID == id,
                          transaction.appAccountToken == token,
                          isTransaction(transaction, environment: environment) else {
                        call.reject("購入を検証できません。再購入せず購入の反映を確認してください。"); return
                    }
                    // Never finish before the server has durably granted the purchase.
                    call.resolve(["status": "purchased", "transactionId": String(transaction.id), "signedTransaction": verification.jwsRepresentation])
                case .userCancelled:
                    failureCode = "KOE_PURCHASE_CANCEL_RECORD"
                    try journal.clearCancelled(productID: id, token: token, backendProjectRef: backendProjectRef, environment: environment)
                    call.resolve(["status": "cancelled"])
                case .pending: call.resolve(["status": "pending"])
                @unknown default: call.reject("購入結果を確認できません。購入の反映を確認してください。")
                }
            } catch {
                // Stage identifies where confirmation stopped, not the underlying cause.
                // Keep the purchase journal and existing recovery behavior unchanged.
                call.reject("購入処理を確認できません。購入済みの場合は購入の反映を確認してください。確認コード：\(failureCode)", failureCode)
            }
        }
    }
    @objc func pendingTransactions(_ call: CAPPluginCall) {
        Task { @MainActor in
            let attempt: KoePurchaseAttempt?
            let environment: String
            var failureCode = "KOE_PENDING_ENVIRONMENT"
            do {
                environment = try await purchaseEnvironment()
                failureCode = "KOE_PENDING_JOURNAL_READ"
                attempt = try purchaseJournal().read(backendProjectRef: backendProjectRef, environment: environment)
            }
            catch { call.reject("前回の購入記録を確認できません。新しい購入は開始できません。確認コード：\(failureCode)", failureCode); return }
            var matchingTransaction = false
            var pendingKinds = Set<String>()
            var rows: [[String: String]] = []
            for await result in Transaction.unfinished {
                guard case .verified(let transaction) = result else {
                    call.reject("未処理の購入を検証できません。再購入せず、時間をおいて反映を確認してください。"); return
                }
                guard isAllowed(transaction.productID) else {
                    call.reject("未処理の商品の接続先を確認できません。記録を削除せず元の環境で照合してください。"); return
                }
                if isAllowed(transaction.productID) {
                    guard isTransaction(transaction, environment: environment), let ownedAttempt = attempt,
                          ownedAttempt.productID == transaction.productID, ownedAttempt.token == transaction.appAccountToken,
                          ownedAttempt.transactionID == nil || ownedAttempt.transactionID == String(transaction.id) else {
                        call.reject("購入の接続先を確認できません。元の環境で照合し、記録は削除しないでください。"); return
                    }
                    pendingKinds.insert(transaction.productID.contains(".voice.") ? "voice" : "boost")
                    // Match the durable attempt before filtering: the other
                    // purchase screen must not mislabel a verified purchase as approval pending.
                    if attempt?.productID == transaction.productID, attempt?.token == transaction.appAccountToken { matchingTransaction = true }
                    if let kind = call.getString("kind"),
                       (kind == "voice" && !transaction.productID.contains(".voice.")) ||
                       (kind == "boost" && !allowed.contains(transaction.productID)) { continue }
                    rows.append(["transactionId": String(transaction.id), "signedTransaction": result.jwsRepresentation])
                }
            }
            if let attempt, let recordedID = attempt.transactionID, !matchingTransaction {
                for await result in Transaction.all {
                    if case .verified(let transaction) = result, String(transaction.id) == recordedID,
                       isTransaction(transaction, environment: environment), transaction.productID == attempt.productID,
                       transaction.appAccountToken == attempt.token {
                        matchingTransaction = true
                        let kind = call.getString("kind") ?? ""
                        let isVoice = transaction.productID.contains(".voice.")
                        if kind.isEmpty || (kind == "voice" && isVoice) || (kind == "boost" && !isVoice) {
                            rows.append(["transactionId": recordedID, "signedTransaction": result.jwsRepresentation])
                        }
                        break
                    }
                }
                guard matchingTransaction else {
                    call.reject("購入完了後の記録を再確認できません。記録を保持しています。再購入や履歴削除はしないでください。"); return
                }
            }
            let requestedKind = call.getString("kind") ?? ""
            let otherKind = requestedKind == "voice" ? "boost" : "voice"
            let blockingKind = attempt.map { $0.productID.contains(".voice.") ? "voice" : "boost" }
                ?? (pendingKinds.contains(otherKind) ? otherKind : pendingKinds.sorted().first ?? "")
            call.resolve(["transactions": rows, "purchaseBlocked": attempt != nil || !pendingKinds.isEmpty, "approvalPending": attempt != nil && !matchingTransaction, "blockingKind": blockingKind, "journalPresent": attempt != nil, "journalVersion": 2, "backendProjectRef": backendProjectRef, "environment": environment])
        }
    }
    private func isTransaction(_ transaction: Transaction, environment: String) -> Bool {
        if #available(iOS 18.0, *) {
            return (environment == "Sandbox" && transaction.environment == .sandbox)
                || (environment == "Production" && transaction.environment == .production)
        }
        // The app receipt is not sufficient proof of this transaction's environment.
        return false
    }
    private func finishOwnedTransaction(_ transaction: Transaction, environment: String) async throws {
        guard isAllowed(transaction.productID), isTransaction(transaction, environment: environment) else {
            throw NSError(domain: "KoePurchaseProvenance", code: 2)
        }
        let journal = try purchaseJournal()
        // Caller reaches finish only after the original server has confirmed the exact grant.
        // Persist that exact transaction before StoreKit finish. Never clear first.
        try journal.recordVerifiedGrant(productID: transaction.productID, token: transaction.appAccountToken,
            transactionID: String(transaction.id), backendProjectRef: backendProjectRef, environment: environment)
        await transaction.finish()
        try journal.clearFinished(productID: transaction.productID, token: transaction.appAccountToken,
            transactionID: String(transaction.id), backendProjectRef: backendProjectRef, environment: environment)
    }
    @objc func finish(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let raw = call.getString("transactionId"), let id = UInt64(raw) else { call.reject("購入番号を確認できません。"); return }
            do {
                let environment = try await purchaseEnvironment()
                let attempt = try purchaseJournal().read(backendProjectRef: backendProjectRef, environment: environment)
                guard let attempt else { throw NSError(domain: "KoePurchaseProvenance", code: 3) }
                for await result in Transaction.unfinished {
                    if case .verified(let transaction) = result, transaction.id == id {
                        try await finishOwnedTransaction(transaction, environment: environment)
                        call.resolve(["finished": true]); return
                    }
                }
                // A crash after StoreKit finish but before journal removal leaves the
                // exact grant marker. Recover only that verified owned transaction.
                guard attempt.transactionID == raw else { throw NSError(domain: "KoePurchaseProvenance", code: 4) }
                for await result in Transaction.all {
                    if case .verified(let transaction) = result, transaction.id == id {
                        try await finishOwnedTransaction(transaction, environment: environment)
                        call.resolve(["finished": true]); return
                    }
                }
                throw NSError(domain: "KoePurchaseProvenance", code: 5)
            } catch { call.reject("購入の接続先・反映・完了を確認できません。元の記録を保持しています。再購入や履歴削除はしないでください。") }
        }
    }
}
