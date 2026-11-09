import Foundation
import StoreKit

// Own this object for the application lifetime, not a web view or purchase sheet.
// Future AppDelegate.didFinishLaunching must call startAtApplicationLaunch().
// Deliberately NOT installed in AppDelegate until all integration gates are passed.
@available(iOS 15.0, *)
@MainActor
final class StoreKitRecovery {
    private let journal: RecoveryJournal
    private var updates: Task<Void, Never>?
    private var unfinished: Task<Void, Never>?
    private var purchaseRunning = false
    private(set) var needsRecoveryAttention = false
    init(journal: RecoveryJournal) { self.journal = journal }
    deinit { updates?.cancel(); unfinished?.cancel() }

    func startAtApplicationLaunch() {
        guard updates == nil else { return }
        // Install updates first; duplicate delivery with unfinished is idempotent.
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                if Task.isCancelled { return }
                await self?.receive(result)
            }
        }
        unfinished = Task { [weak self] in
            for await result in Transaction.unfinished {
                if Task.isCancelled { return }
                await self?.receive(result)
            }
        }
    }
    nonisolated static func evidence(_ result: VerificationResult<Transaction>) throws -> VerifiedEvidence {
        guard case .verified(let transaction) = result,
              let token = transaction.appAccountToken else { throw RecoveryError.invalid }
        // Decode ONLY after StoreKit verification, never use unverified payloads.
        let signed = result.jwsRepresentation
        let parts = signed.split(separator: ".", omittingEmptySubsequences: false)
        guard signed.utf8.count <= 30000, parts.count == 3 else { throw RecoveryError.invalid }
        var body = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        body += String(repeating: "=", count: (4 - body.count % 4) % 4)
        guard let data = Data(base64Encoded: body),
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let environment = payload["environment"] as? String,
              ["Sandbox", "Production"].contains(environment),
              payload["transactionId"] as? String == String(transaction.id),
              payload["productId"] as? String == transaction.productID,
              payload["bundleId"] as? String == Bundle.main.bundleIdentifier,
              (payload["appAccountToken"] as? String)?.lowercased() == token.uuidString.lowercased(),
              payload["currency"] as? String == "JPY",
              let price = payload["price"] as? Int, price > 0, price % 1000 == 0 else { throw RecoveryError.invalid }
        if #available(iOS 16.0, *) {
            guard (environment == "Sandbox" && transaction.environment == .sandbox)
                || (environment == "Production" && transaction.environment == .production) else { throw RecoveryError.invalid }
        }
        // iOS 15 environment is from this same verified signed transaction, not
        // device locale, TestFlight detection or absence of an app receipt.
        return VerifiedEvidence(token: token, transactionID: String(transaction.id),
            productID: transaction.productID, environment: environment, amountJpy: price / 1000, signed: signed)
    }
    func receive(_ result: VerificationResult<Transaction>) async {
        do { try await journal.retainVerified(Self.evidence(result)) }
        catch { needsRecoveryAttention = true }
        // Unknown tokens/foreign/unverified evidence cannot be adopted or finished.
        // No active account is inferred. Server reconciliation requires its owner.
    }
    func purchaseFromExplicitUserAction(_ identity: AttemptIdentity, product: Product,
                                       session: OwnerSession, transport: RecoveryLaunchTransport) async throws {
        guard RecoveryIntegration.newAdmissionEnabled else { throw RecoveryError.disabled }
        guard !purchaseRunning, product.id == identity.productID, product.type == .consumable,
              product.priceFormatStyle.currencyCode == "JPY", product.price == Decimal(identity.amountJpy),
              session.ownerID == identity.ownerID, session.backendProjectRef == identity.backendProjectRef,
              session.environment == identity.environment, !session.bearer.isEmpty else { throw RecoveryError.invalid }
        purchaseRunning = true
        defer { purchaseRunning = false }
        guard try await journal.read(identity.orderID).identity == identity else { throw RecoveryError.conflict }
        let claim = try await journal.markBeginDispatched(identity.orderID)
        // Throw/lost response leaves dispatchUnknown; no recovery path calls purchase.
        let reply = try await transport.begin(identity, session: session)
        guard reply.identity == identity, reply.launchGranted else { throw RecoveryError.conflict }
        let result = try await journal.executeLaunch(identity, claim: claim, launchGranted: reply.launchGranted, session: session) { _ in
            try await product.purchase(options: [.appAccountToken(identity.orderID)])
        }
        switch result {
        case .success(let verification): await receive(verification)
        case .userCancelled: try await journal.recordStoreKitResult(identity.orderID, result: .userCancelled)
        case .pending: try await journal.recordStoreKitResult(identity.orderID, result: .pending)
        @unknown default: try await journal.recordStoreKitResult(identity.orderID, result: .unknown)
        }
    }
    func reconcileAndFinish(_ result: VerificationResult<Transaction>, session: OwnerSession,
                            transport: RecoveryTransport) async throws {
        // Also gated: an incomplete transport/money route must not finish a receipt.
        guard RecoveryIntegration.recoveryEnabled else { throw RecoveryError.disabled }
        let proof = try Self.evidence(result)
        guard case .verified(let transaction) = result else { throw RecoveryError.invalid }
        try await journal.retainVerified(proof)
        guard let permit = try await journal.reconcile(proof.token, transactionID: proof.transactionID,
                                          session: session, transport: transport) else { return }
        // The actor revalidates the exact evidence generation and durably starts
        // the operation before it yields. Review/refunded states have no permit.
        try await journal.executeFinish(permit) { _ in await transaction.finish() }
    }
}
