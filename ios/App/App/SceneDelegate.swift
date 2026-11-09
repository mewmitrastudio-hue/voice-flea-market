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
    var attemptNonce: UUID? = nil
    var finishReturned: Bool? = nil
    var signedTransaction: String? = nil
    var ownerID: String? = nil
    var amountJpy: Int? = nil
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
    func begin(productID: String, token: UUID, backendProjectRef: String, environment: String, ownerID: String? = nil, amountJpy: Int? = nil, attemptNonce: UUID? = nil) throws {
        // The one global file is intentional: another namespace must not hide legacy obligations.
        guard try read(backendProjectRef: backendProjectRef, environment: environment) == nil else { throw failure() }
        try persist(KoePurchaseAttempt(productID: productID, token: token, schemaVersion: 2,
            backendProjectRef: backendProjectRef, storeKitEnvironment: environment, transactionID: nil, attemptNonce: attemptNonce, ownerID: ownerID, amountJpy: amountJpy))
    }
    func recordVerifiedGrant(productID: String, token: UUID?, transactionID: String, backendProjectRef: String, environment: String) throws {
        guard let attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.productID == productID, attempt.token == token,
              transactionID.range(of: "^[0-9]{1,40}$", options: .regularExpression) != nil,
              attempt.transactionID == nil || attempt.transactionID == transactionID else { throw failure() }
        try persist(KoePurchaseAttempt(productID: attempt.productID, token: attempt.token, schemaVersion: 2,
            backendProjectRef: backendProjectRef, storeKitEnvironment: environment, transactionID: transactionID, attemptNonce: attempt.attemptNonce, finishReturned: attempt.finishReturned, signedTransaction: attempt.signedTransaction, ownerID: attempt.ownerID, amountJpy: attempt.amountJpy))
    }
    // Keep the Apple-signed proof before returning to JS, and before finish.
    // transactionID remains the durable server-grant marker for v2 compatibility.
    func retainSignedTransaction(productID: String, token: UUID?, signed: String, backendProjectRef: String, environment: String) throws {
        guard var attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.productID == productID, attempt.token == token,
              !signed.isEmpty, signed.utf8.count <= 30000 else { throw failure() }
        attempt.signedTransaction = signed
        try persist(attempt)
    }
    func recordFinishReturned(backendProjectRef: String, environment: String) throws {
        guard var attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.transactionID != nil, attempt.signedTransaction != nil else { throw failure() }
        attempt.finishReturned = true
        try persist(attempt)
    }
    // Preserve financially applied evidence separately; never label it Apple-finished.
    func archiveAppliedFinishUncertain(backendProjectRef: String, environment: String) throws {
        guard let attempt = try read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.transactionID != nil, attempt.signedTransaction != nil else { throw failure() }
        let archive = url.deletingLastPathComponent().appendingPathComponent("applied-finish-uncertain-" + attempt.token.uuidString + ".json")
        try JSONEncoder().encode(attempt).write(to: archive, options: .atomic)
        guard try JSONDecoder().decode(KoePurchaseAttempt.self, from: Data(contentsOf: archive)) == attempt else { throw failure() }
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
        #if KOEFURIMA_NATIVE_V3_HOST
        if RecoveryIntegration.hostEnabled {
            bridge?.registerPluginInstance(KoeRecoveryPlugin())
        }
        #endif
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
        // Feature off preserves the existing shipped path. Enabling new v3 must
        // not leave a fallback into this legacy charging path after v3 errors.
        #if KOEFURIMA_NATIVE_V3_HOST
        if RecoveryIntegration.newAdmissionEnabled {
            call.reject("新しい購入経路を確認してください。旧経路では開始しません。"); return
        }
        #endif
        Task { @MainActor in
            guard !purchaseInProgress else { call.reject("購入の確認中です。"); return }
            guard let id = call.getString("productId"), isAllowed(id),
                  let raw = call.getString("orderId"), let token = UUID(uuidString: raw),
                  let owner = call.getString("ownerId"), UUID(uuidString: owner) != nil,
                  let accessToken = call.getString("accessToken"), !accessToken.isEmpty else {
                call.reject("出品とプランを確認してください。"); return
            }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            do {
                let environment = try await purchaseEnvironment()
                guard call.getString("environment") == environment else {
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
                    case .verified:
                        // Unknown SKUs cannot be silently skipped between preview and charge.
                        call.reject("未反映の購入があります。再購入せず購入の反映を確認してください。"); return
                    case .unverified:
                        call.reject("未処理の購入を検証できません。新しい購入は開始していません。"); return
                    }
                }
                let journal = try purchaseJournal()
                let attemptNonce = UUID()
                try journal.begin(productID: id, token: token, backendProjectRef: backendProjectRef, environment: environment, ownerID: owner, amountJpy: amount, attemptNonce: attemptNonce)
                _ = try await nativeAttemptRequest(action: "nativeBegin", accessToken: accessToken,
                    fields: ["orderId": token.uuidString, "productId": id, "environment": environment, "amountJpy": amount, "attemptNonce": attemptNonce.uuidString])
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification, transaction.productID == id,
                          transaction.appAccountToken == token,
                          isTransaction(transaction, environment: environment, signed: verification.jwsRepresentation) else {
                        call.reject("購入を検証できません。再購入せず購入の反映を確認してください。"); return
                    }
                    try journal.retainSignedTransaction(productID: id, token: token, signed: verification.jwsRepresentation, backendProjectRef: backendProjectRef, environment: environment)
                    // Never finish before the server has durably granted the purchase.
                    call.resolve(["status": "purchased", "transactionId": String(transaction.id), "signedTransaction": verification.jwsRepresentation])
                case .userCancelled:
                    // StoreKit provides no server-verifiable no-charge cancellation proof.
                    // Keep the precharge hold; never turn a client assertion into release.
                    call.reject("Appleの購入画面を閉じました。取消結果の確認が必要なため記録を保持しています。再購入せず運営へお問い合わせください。")
                case .pending: call.resolve(["status": "pending"])
                @unknown default: call.reject("購入結果を確認できません。購入の反映を確認してください。")
                }
            } catch { call.reject("購入処理を確認できません。購入済みの場合は購入の反映を確認してください。") }
        }
    }
    @objc func pendingTransactions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard !purchaseInProgress else { call.reject("購入の確認中です。"); return }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            let attempt: KoePurchaseAttempt?
            let environment: String
            do {
                environment = try await purchaseEnvironment()
                let journal = try purchaseJournal()
                guard let owner = call.getString("ownerId"), UUID(uuidString: owner) != nil,
                      let accessToken = call.getString("accessToken"), !accessToken.isEmpty else { throw NSError(domain: "KoeGrant", code: 10) }
                let status = try await nativeAttemptRequest(action: "nativeStatus", accessToken: accessToken)
                let current = try journal.read(backendProjectRef: backendProjectRef, environment: environment)
                if let pending = status["pending"] as? [String: Any] {
                    guard (pending["ownerId"] as? String)?.lowercased() == owner.lowercased(),
                          pending["environment"] as? String == environment,
                          let order = pending["orderId"] as? String, let token = UUID(uuidString: order),
                          let product = pending["productId"] as? String, isAllowed(product),
                          let amount = pending["amountJpy"] as? Int, amount > 0,
                          let rawNonce = pending["attemptNonce"] as? String, let nonce = UUID(uuidString: rawNonce) else { throw NSError(domain: "KoeGrant", code: 11) }
                    if let current {
                        guard current.token == token, current.productID == product, current.attemptNonce == nonce else { throw NSError(domain: "KoeGrant", code: 12) }
                    } else {
                        try journal.begin(productID: product, token: token, backendProjectRef: backendProjectRef, environment: environment, ownerID: owner, amountJpy: amount, attemptNonce: nonce)
                    }
                    if let savedID = pending["transactionId"] as? String, let savedJWS = pending["signedTransaction"] as? String {
                        try journal.retainSignedTransaction(productID: product, token: token, signed: savedJWS, backendProjectRef: backendProjectRef, environment: environment)
                        try journal.recordVerifiedGrant(productID: product, token: token, transactionID: savedID, backendProjectRef: backendProjectRef, environment: environment)
                    }
                }
                attempt = try journal.read(backendProjectRef: backendProjectRef, environment: environment)
                if let expectedOwner = attempt?.ownerID, expectedOwner.lowercased() != owner.lowercased() { throw NSError(domain: "KoeGrant", code: 13) }
            }
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
                    guard isTransaction(transaction, environment: environment, signed: result.jwsRepresentation),
                          transaction.appAccountToken != nil else {
                        call.reject("購入環境を検証できません。記録は保持しています。"); return
                    }
                    if let ownedAttempt = attempt {
                        guard ownedAttempt.productID == transaction.productID, ownedAttempt.token == transaction.appAccountToken,
                              ownedAttempt.transactionID == nil || ownedAttempt.transactionID == String(transaction.id) else {
                            call.reject("購入記録が一致しません。記録は保持しています。"); return
                        }
                        do { try purchaseJournal().retainSignedTransaction(productID: transaction.productID, token: transaction.appAccountToken, signed: result.jwsRepresentation, backendProjectRef: backendProjectRef, environment: environment) }
                        catch { call.reject("購入記録を保存できません。再購入しないでください。"); return }
                    }
                    if let storedOwner = attempt?.ownerID, storedOwner.lowercased() != call.getString("ownerId")?.lowercased() {
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
            if let attempt, !matchingTransaction, let signed = attempt.signedTransaction,
               let payload = signedPayload(signed), let recordedID = payload["transactionId"] as? String,
               payload["productId"] as? String == attempt.productID,
               (payload["appAccountToken"] as? String)?.lowercased() == attempt.token.uuidString.lowercased(),
               payload["environment"] as? String == environment,
               attempt.transactionID == nil || attempt.transactionID == recordedID {
                // Stored JWS is only a candidate. Server re-verification is mandatory.
                matchingTransaction = true
                let kind = call.getString("kind") ?? ""
                let isVoice = attempt.productID.contains(".voice.")
                if kind.isEmpty || (kind == "voice" && isVoice) || (kind == "boost" && !isVoice) {
                    rows.append(["transactionId": recordedID, "signedTransaction": signed])
                }
            }
            if let attempt, let recordedID = attempt.transactionID, !matchingTransaction {
                for await result in Transaction.all {
                    if case .verified(let transaction) = result, String(transaction.id) == recordedID,
                       isTransaction(transaction, environment: environment, signed: result.jwsRepresentation), transaction.productID == attempt.productID,
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
    // Parse only StoreKit-verified JWS when checking a live transaction. Persisted
    // bytes are NEVER treated as verified: the fixed server re-verifies them.
    private func signedPayload(_ signed: String) -> [String: Any]? {
        let parts = signed.split(separator: ".", omittingEmptySubsequences: false)
        guard signed.utf8.count <= 30000, parts.count == 3 else { return nil }
        var body = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        body += String(repeating: "=", count: (4 - body.count % 4) % 4)
        guard let bytes = Data(base64Encoded: body) else { return nil }
        return (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
    }
    private func isTransaction(_ transaction: Transaction, environment: String, signed: String) -> Bool {
        guard let payload = signedPayload(signed),
              payload["environment"] as? String == environment,
              payload["transactionId"] as? String == String(transaction.id),
              payload["productId"] as? String == transaction.productID,
              payload["bundleId"] as? String == Bundle.main.bundleIdentifier,
              (payload["appAccountToken"] as? String)?.lowercased() == transaction.appAccountToken?.uuidString.lowercased() else { return false }
        if #available(iOS 16.0, *) {
            return (environment == "Sandbox" && transaction.environment == .sandbox)
                || (environment == "Production" && transaction.environment == .production)
        }
        // iOS 15: environment comes from the SAME StoreKit .verified JWS,
        // never a decoded unverified transaction or a JS-provided environment.
        return ["Sandbox", "Production"].contains(environment)
    }
    private func nativeAttemptRequest(action: String, accessToken: String, fields: [String: Any] = [:]) async throws -> [String: Any] {
        let url = URL(string: "https://\(backendProjectRef).supabase.co/functions/v1/boost-iap")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        var body = fields; body["action"] = action
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let session = URLSession(configuration: .ephemeral, delegate: KoeNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == url,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["success"] as? Bool == true else { throw NSError(domain: "KoeAttempt", code: 1) }
        return result
    }
    private func confirmServerGrant(signed: String, transactionID: String, owner: String, accessToken: String, environment: String) async throws -> [String: Any] {
        guard let payload = signedPayload(signed), payload["transactionId"] as? String == transactionID,
              let product = payload["productId"] as? String, isAllowed(product),
              payload["environment"] as? String == environment,
              let order = payload["appAccountToken"] as? String, UUID(uuidString: order) != nil,
              payload["currency"] as? String == "JPY", let price = payload["price"] as? Int,
              price > 0, price % 1000 == 0 else { throw NSError(domain: "KoeGrant", code: 1) }
        let route = product.contains(".voice.") ? "voice-iap" : "boost-iap"
        let url = URL(string: "https://\(backendProjectRef).supabase.co/functions/v1/\(route)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["action": "verify", "signedTransaction": signed, "nativeProtocol": 1])
        // Do not forward the authenticated request through redirects.
        let session = URLSession(configuration: .ephemeral, delegate: KoeNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == url,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["success"] as? Bool == true,
              let grant = result["nativeGrant"] as? [String: Any], grant["version"] as? Int == 1,
              grant["backendProjectRef"] as? String == backendProjectRef,
              (grant["ownerId"] as? String)?.lowercased() == owner.lowercased(),
              grant["transactionId"] as? String == transactionID,
              (grant["orderId"] as? String)?.lowercased() == order.lowercased(),
              grant["productId"] as? String == product, grant["environment"] as? String == environment,
              grant["amountJpy"] as? Int == price / 1000 else { throw NSError(domain: "KoeGrant", code: 2) }
        return grant
    }
    private func acknowledgeFinished(_ journal: KoePurchaseJournal, environment: String, accessToken: String) async throws {
        guard let attempt = try journal.read(backendProjectRef: backendProjectRef, environment: environment),
              attempt.finishReturned == true, let transactionID = attempt.transactionID else { throw NSError(domain: "KoeGrant", code: 14) }
        if let nonce = attempt.attemptNonce, let amount = attempt.amountJpy {
            _ = try await nativeAttemptRequest(action: "nativeFinished", accessToken: accessToken,
                fields: ["orderId": attempt.token.uuidString, "productId": attempt.productID, "environment": environment,
                         "amountJpy": amount, "transactionId": transactionID, "attemptNonce": nonce.uuidString])
        }
    }
    private func finishOwnedTransaction(_ transaction: Transaction, signed: String, environment: String, owner: String, grant: [String: Any], accessToken: String) async throws {
        guard isAllowed(transaction.productID), isTransaction(transaction, environment: environment, signed: signed),
              let token = transaction.appAccountToken else { throw NSError(domain: "KoePurchaseProvenance", code: 2) }
        let journal = try purchaseJournal()
        // Reinstall: adopt only AFTER the original server proves exact ownership
        // and durable application. No empty-history inference and no foreign migration.
        if try journal.read(backendProjectRef: backendProjectRef, environment: environment) == nil {
            try journal.begin(productID: transaction.productID, token: token, backendProjectRef: backendProjectRef, environment: environment,
                              ownerID: owner, amountJpy: grant["amountJpy"] as? Int, attemptNonce: UUID(uuidString: grant["attemptNonce"] as? String ?? ""))
        }
        if let rawNonce = grant["attemptNonce"] as? String {
            guard let nonce = UUID(uuidString: rawNonce),
                  try journal.read(backendProjectRef: backendProjectRef, environment: environment)?.attemptNonce == nonce else { throw NSError(domain: "KoeGrant", code: 15) }
        }
        try journal.retainSignedTransaction(productID: transaction.productID, token: token, signed: signed, backendProjectRef: backendProjectRef, environment: environment)
        try journal.recordVerifiedGrant(productID: transaction.productID, token: token,
            transactionID: String(transaction.id), backendProjectRef: backendProjectRef, environment: environment)
        await transaction.finish()
        try journal.recordFinishReturned(backendProjectRef: backendProjectRef, environment: environment)
        try await acknowledgeFinished(journal, environment: environment, accessToken: accessToken)
        try journal.clearFinished(productID: transaction.productID, token: token,
            transactionID: String(transaction.id), backendProjectRef: backendProjectRef, environment: environment)
    }
    @objc func finish(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard !purchaseInProgress, let raw = call.getString("transactionId"), let id = UInt64(raw),
                  let owner = call.getString("ownerId"), UUID(uuidString: owner) != nil,
                  let accessToken = call.getString("accessToken"), !accessToken.isEmpty else { call.reject("購入番号・ログイン状態を確認できません。"); return }
            purchaseInProgress = true
            defer { purchaseInProgress = false }
            do {
                let environment = try await purchaseEnvironment()
                let journal = try purchaseJournal()
                let attempt = try journal.read(backendProjectRef: backendProjectRef, environment: environment)
                if let expectedOwner = attempt?.ownerID, expectedOwner.lowercased() != owner.lowercased() { throw NSError(domain: "KoeGrant", code: 3) }
                for await result in Transaction.unfinished {
                    if case .verified(let transaction) = result, transaction.id == id {
                        guard isTransaction(transaction, environment: environment, signed: result.jwsRepresentation) else { throw NSError(domain: "KoeGrant", code: 4) }
                        if let attempt {
                            guard attempt.productID == transaction.productID, attempt.token == transaction.appAccountToken,
                                  attempt.transactionID == nil || attempt.transactionID == raw else { throw NSError(domain: "KoeGrant", code: 5) }
                        }
                        let grant = try await confirmServerGrant(signed: result.jwsRepresentation, transactionID: raw, owner: owner, accessToken: accessToken, environment: environment)
                        if let amount = attempt?.amountJpy, grant["amountJpy"] as? Int != amount { throw NSError(domain: "KoeGrant", code: 6) }
                        try await finishOwnedTransaction(transaction, signed: result.jwsRepresentation, environment: environment, owner: owner, grant: grant, accessToken: accessToken)
                        call.resolve(["finished": true]); return
                    }
                }
                guard let attempt else { throw NSError(domain: "KoePurchaseProvenance", code: 3) }
                guard attempt.transactionID == raw else { throw NSError(domain: "KoePurchaseProvenance", code: 4) }
                // Old v2 grants without JWS still require Apple's matching history.
                if attempt.finishReturned == true, let signed = attempt.signedTransaction {
                    let grant = try await confirmServerGrant(signed: signed, transactionID: raw, owner: owner, accessToken: accessToken, environment: environment)
                    guard grant["productId"] as? String == attempt.productID,
                          (grant["orderId"] as? String)?.lowercased() == attempt.token.uuidString.lowercased(),
                          attempt.amountJpy == nil || grant["amountJpy"] as? Int == attempt.amountJpy else { throw NSError(domain: "KoeGrant", code: 7) }
                    // Only a durable finish-returned marker plus freshly verified
                    // server grant permits cleanup without consumable history.
                    try await acknowledgeFinished(journal, environment: environment, accessToken: accessToken)
                    try journal.clearFinished(productID: attempt.productID, token: attempt.token, transactionID: raw, backendProjectRef: backendProjectRef, environment: environment)
                    call.resolve(["finished": true]); return
                }
                for await result in Transaction.all {
                    if case .verified(let transaction) = result, transaction.id == id {
                        let grant = try await confirmServerGrant(signed: result.jwsRepresentation, transactionID: raw, owner: owner, accessToken: accessToken, environment: environment)
                        try await finishOwnedTransaction(transaction, signed: result.jwsRepresentation, environment: environment, owner: owner, grant: grant, accessToken: accessToken)
                        call.resolve(["finished": true]); return
                    }
                }
                // A missing StoreKit transaction is NOT cancellation or finish evidence.
                // Release only the purchase latch after fresh server verification proves
                // this exact purchase has already been applied. Preserve both records.
                if let signed = attempt.signedTransaction, let nonce = attempt.attemptNonce {
                    let grant = try await confirmServerGrant(signed: signed, transactionID: raw, owner: owner, accessToken: accessToken, environment: environment)
                    guard grant["productId"] as? String == attempt.productID,
                          (grant["orderId"] as? String)?.lowercased() == attempt.token.uuidString.lowercased(),
                          let amount = attempt.amountJpy, grant["amountJpy"] as? Int == amount,
                          (grant["attemptNonce"] as? String)?.lowercased() == nonce.uuidString.lowercased() else { throw NSError(domain: "KoeGrant", code: 16) }
                    _ = try await nativeAttemptRequest(action: "nativeDeferFinish", accessToken: accessToken,
                        fields: ["orderId": attempt.token.uuidString, "productId": attempt.productID, "environment": environment,
                                 "amountJpy": amount, "transactionId": raw, "attemptNonce": nonce.uuidString])
                    try journal.archiveAppliedFinishUncertain(backendProjectRef: backendProjectRef, environment: environment)
                    call.resolve(["finished": false, "financiallyApplied": true, "finishUncertain": true]); return
                }
                throw NSError(domain: "KoePurchaseProvenance", code: 5)
            } catch { call.reject("購入の接続先・反映・完了を確認できません。元の記録を保持しています。再購入や履歴削除はしないでください。") }
        }
    }
}
private final class KoeNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
