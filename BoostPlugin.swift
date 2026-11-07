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
    // Preparatory recording build: never purchase or finish a transaction.
    private let recordingApplePurchasesEnabled = false
    private let recordingAppleRecoveryEnabled = false
    private let recordingStripeWritesEnabled = false
    private let recordingBackendProjectRef = "neotkrfsquysuatdruhg"
    private let recordingStoreKitEnvironment = "Sandbox"
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
            do {
                let requested = call.getArray("productIds", String.self) ?? Array(allowed)
                guard !requested.isEmpty, requested.count <= 30, requested.allSatisfy({ isAllowed($0) }) else {
                    call.reject("商品を確認できません。"); return
                }
                let items = try await Product.products(for: requested)
                let environment = try await purchaseEnvironment()
                // Read immediately for this request; never persist a customer's
                // storefront as profile data or infer currency from device locale.
                let storefront = await Storefront.current
                call.resolve(["environment": environment, "storefrontCountry": storefront?.countryCode ?? "", "products": items.filter { $0.type == .consumable }.map {
                    ["id": $0.id, "displayPrice": $0.displayPrice, "displayName": $0.displayName, "currencyCode": $0.priceFormatStyle.currencyCode, "price": NSDecimalNumber(decimal: $0.price).stringValue]
                }])
            } catch { call.reject("商品情報を取得できません。時間をおいて再試行してください。") }
        }
    }
    @objc func purchase(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard #available(iOS 18.0, *) else { call.reject("安全な購入復旧にはiOS 18以降が必要です。購入は開始していません。"); return }
            guard recordingApplePurchasesEnabled && recordingAppleRecoveryEnabled && !recordingStripeWritesEnabled else { call.reject("録画用環境の購入・購入確定は停止中です。元の購入記録は保持しています。"); return }
            guard !purchaseInProgress else { call.reject("購入の確認中です。"); return }
            guard let id = call.getString("productId"), isAllowed(id),
                  let raw = call.getString("orderId"), let token = UUID(uuidString: raw) else {
                call.reject("出品とプランを確認してください。"); return
            }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            do {
                let environment = try await purchaseEnvironment()
                guard environment == recordingStoreKitEnvironment,
                      call.getString("environment") == environment else {
                    call.reject("購入環境の設定が一致しません。購入は開始していません。"); return
                }
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
                    case .verified(let transaction):
                        if isAllowed(transaction.productID) {
                            call.reject("未反映の購入があります。再購入せず購入の反映を確認してください。"); return
                        }
                    case .unverified:
                        call.reject("未処理の購入を検証できません。新しい購入は開始していません。"); return
                    }
                }
                let journal = try purchaseJournal()
                try journal.begin(productID: id, token: token, backendProjectRef: recordingBackendProjectRef, environment: environment)
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification, transaction.productID == id,
                          transaction.appAccountToken == token else {
                        call.reject("購入を検証できません。再購入せず購入の反映を確認してください。"); return
                    }
                    // Never finish before the server has durably granted the purchase.
                    call.resolve(["status": "purchased", "transactionId": String(transaction.id), "signedTransaction": verification.jwsRepresentation])
                case .userCancelled:
                    try journal.clearCancelled(productID: id, token: token, backendProjectRef: recordingBackendProjectRef, environment: environment)
                    call.resolve(["status": "cancelled"])
                case .pending: call.resolve(["status": "pending"])
                @unknown default: call.reject("購入結果を確認できません。購入の反映を確認してください。")
                }
            } catch { call.reject("購入処理を確認できません。購入済みの場合は購入の反映を確認してください。") }
        }
    }
    @objc func pendingTransactions(_ call: CAPPluginCall) {
        Task { @MainActor in
            let attempt: KoePurchaseAttempt?
            do { attempt = try purchaseJournal().read(backendProjectRef: recordingBackendProjectRef, environment: recordingStoreKitEnvironment) }
            catch { call.reject("前回の購入記録を確認できません。新しい購入は開始できません。"); return }
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
                    guard isRecordingTransaction(transaction), let ownedAttempt = attempt,
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
                       isRecordingTransaction(transaction), transaction.productID == attempt.productID,
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
            call.resolve(["transactions": rows, "purchaseBlocked": attempt != nil || !pendingKinds.isEmpty, "approvalPending": attempt != nil && !matchingTransaction, "blockingKind": blockingKind, "journalPresent": attempt != nil, "journalVersion": 2, "backendProjectRef": recordingBackendProjectRef, "environment": recordingStoreKitEnvironment, "applePurchasesEnabled": recordingApplePurchasesEnabled, "appleRecoveryEnabled": recordingAppleRecoveryEnabled, "stripeWritesEnabled": recordingStripeWritesEnabled])
        }
    }
    private func isRecordingTransaction(_ transaction: Transaction) -> Bool {
        if #available(iOS 18.0, *) { return transaction.environment == .sandbox }
        // The app receipt is not sufficient proof of this transaction's environment.
        return false
    }
    private func finishOwnedTransaction(_ transaction: Transaction) async throws {
        guard isAllowed(transaction.productID), isRecordingTransaction(transaction) else {
            throw NSError(domain: "KoePurchaseProvenance", code: 2)
        }
        let journal = try purchaseJournal()
        // Caller reaches finish only after the sandbox server has confirmed the exact grant.
        // Persist that exact transaction before StoreKit finish. Never clear first.
        try journal.recordVerifiedGrant(productID: transaction.productID, token: transaction.appAccountToken,
            transactionID: String(transaction.id), backendProjectRef: recordingBackendProjectRef, environment: recordingStoreKitEnvironment)
        await transaction.finish()
        try journal.clearFinished(productID: transaction.productID, token: transaction.appAccountToken,
            transactionID: String(transaction.id), backendProjectRef: recordingBackendProjectRef, environment: recordingStoreKitEnvironment)
    }
    @objc func finish(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard recordingAppleRecoveryEnabled && !recordingStripeWritesEnabled else { call.reject("録画用環境の購入・購入確定は停止中です。元の購入記録は保持しています。"); return }
            guard let raw = call.getString("transactionId"), let id = UInt64(raw) else { call.reject("購入番号を確認できません。"); return }
            do {
                let attempt = try purchaseJournal().read(backendProjectRef: recordingBackendProjectRef, environment: recordingStoreKitEnvironment)
                guard let attempt else { throw NSError(domain: "KoePurchaseProvenance", code: 3) }
                for await result in Transaction.unfinished {
                    if case .verified(let transaction) = result, transaction.id == id {
                        try await finishOwnedTransaction(transaction)
                        call.resolve(["finished": true]); return
                    }
                }
                // A crash after StoreKit finish but before journal removal leaves the
                // exact grant marker. Recover only that verified owned transaction.
                guard attempt.transactionID == raw else { throw NSError(domain: "KoePurchaseProvenance", code: 4) }
                for await result in Transaction.all {
                    if case .verified(let transaction) = result, transaction.id == id {
                        try await finishOwnedTransaction(transaction)
                        call.resolve(["finished": true]); return
                    }
                }
                throw NSError(domain: "KoePurchaseProvenance", code: 5)
            } catch { call.reject("購入の接続先・反映・完了を確認できません。元の記録を保持しています。再購入や履歴削除はしないでください。") }
        }
    }
}
