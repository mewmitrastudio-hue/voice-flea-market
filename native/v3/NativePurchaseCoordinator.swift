import Foundation

protocol NativeAdmissionTransport: RecoveryLaunchTransport {
    func prepareInitial(_ saved: InitialPreparation, session: OwnerSession) async throws -> AdmissionAttempt
    func prepareRetry(_ predecessor: AttemptIdentity, request: RetryRequest, session: OwnerSession) async throws -> AdmissionAttempt
    func reportPending(_ identity: AttemptIdentity, session: OwnerSession) async throws
    func status(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState
}
extension NativeHTTPTransport: NativeAdmissionTransport {}

struct PreparedNativeProduct {
    let productID: String
    let amountJpy: Int
    let displayPrice: String
    // Prepared before begin; invoking this closure must not fetch a product or
    // hop to a different actor before StoreKit purchase. The journal owns entry.
    let launch: (isolated RecoveryJournal, UUID) async throws -> NativePurchaseResult
}
struct VerifiedNativePurchase {
    let evidence: VerifiedEvidence
    let finish: (isolated RecoveryJournal) async throws -> Void
}
enum NativePurchaseResult { case userCancelled, pending, unknown, verified(VerifiedNativePurchase) }
protocol NativeProductCatalog {
    func prepare(productID: String, amountJpy: Int) async throws -> PreparedNativeProduct
}
struct NativeQuoteView {
    let quoteID: UUID; let identity: AttemptIdentity; let previousOrderID: UUID?; let displayPrice: String
    var dictionary: [String: Any] {
        var value: [String: Any] = ["protocol": 3, "quoteId": quoteID.uuidString.lowercased(), "orderId": identity.orderID.uuidString.lowercased(),
            "productId": identity.productID, "amountJpy": identity.amountJpy, "displayPrice": displayPrice,
            "environment": identity.environment, "state": "prepared"]
        if let previousOrderID { value["previousOrderId"] = previousOrderID.uuidString.lowercased() }
        return value
    }
}
struct NativeOutcomeView {
    let orderID: UUID; let localOutcome: String; let serverState: ServerAttemptState?
    let cancellationReportPending: Bool; let retryAvailable: Bool; let finishState: String
    let receiptClassification: ReceiptDisposition?; let reviewRequired: Bool?; let fulfillmentGranted: Bool?
    var dictionary: [String: Any] {
        var value: [String: Any] = ["protocol": 3, "orderId": orderID.uuidString.lowercased(), "localOutcome": localOutcome,
            "serverState": serverState.map { $0.rawValue as Any } ?? NSNull(), "cancellationReportPending": cancellationReportPending,
            "retryAvailable": retryAvailable, "finishState": finishState]
        if let receiptClassification { value["receiptClassification"] = receiptClassification.rawValue }
        if let reviewRequired { value["reviewRequired"] = reviewRequired }
        if let fulfillmentGranted { value["fulfillmentGranted"] = fulfillmentGranted }
        return value
    }
}
actor NativePurchaseCoordinator {
    private struct Quote { let view: NativeQuoteView; let product: PreparedNativeProduct; let generation: UUID }
    private let journal: RecoveryJournal
    private let transport: NativeAdmissionTransport
    private let catalog: NativeProductCatalog
    private let admissionEnabled: Bool
    private var quotes: [UUID: Quote] = [:]
    private var busy = false
    init(journal: RecoveryJournal, transport: NativeAdmissionTransport, catalog: NativeProductCatalog,
         admissionEnabled: Bool = RecoveryIntegration.newAdmissionEnabled) {
        self.journal = journal; self.transport = transport; self.catalog = catalog; self.admissionEnabled = admissionEnabled
    }
    private func start() throws {
        guard admissionEnabled else { throw RecoveryError.disabled }
        guard !busy else { throw RecoveryError.busy }
        busy = true
    }
    func invalidateQuotes() { quotes.removeAll() }
    private func quote(_ identity: AttemptIdentity, previous: UUID?, session: OwnerSession) async throws -> NativeQuoteView {
        let product = try await catalog.prepare(productID: identity.productID, amountJpy: identity.amountJpy)
        try await journal.checkSession(session)
        guard product.productID == identity.productID, product.amountJpy == identity.amountJpy,
              !product.displayPrice.isEmpty, let generation = session.generation else { throw RecoveryError.invalid }
        let record = try await journal.read(identity.orderID)
        try await journal.checkSession(session)
        guard record.identity == identity, record.state == .prepared, record.receipts.isEmpty else { throw RecoveryError.conflict }
        quotes = quotes.filter { $0.value.view.identity.orderID != identity.orderID }
        let view = NativeQuoteView(quoteID: UUID(), identity: identity, previousOrderID: previous, displayPrice: product.displayPrice)
        quotes[view.quoteID] = Quote(view: view, product: product, generation: generation)
        return view
    }
    func prepare(kind: String, subjectID: UUID, boostPlan: String? = nil) async throws -> NativeQuoteView {
        try start(); defer { busy = false }
        let session = try await journal.currentSession()
        let saved = try await journal.reserveInitial(kind: kind, subjectID: subjectID, boostPlan: boostPlan, session: session)
        let reply = try await transport.prepareInitial(saved, session: session)
        try await journal.checkSession(session)
        let identity = try reply.identity(owner: session.ownerID)
        guard identity.orderID == saved.freshOrderID, reply.previousOrderId == nil, reply.state == .prepared else { throw RecoveryError.invalid }
        try await journal.installPrepared(identity)
        return try await quote(identity, previous: nil, session: session)
    }
    func prepareRetry(previousOrderID: UUID) async throws -> NativeQuoteView {
        try start(); defer { busy = false }
        let session = try await journal.currentSession()
        let old = try await journal.read(previousOrderID)
        try await journal.checkSession(session)
        guard old.identity.ownerID == session.ownerID, old.identity.environment == session.environment else { throw RecoveryError.invalid }
        let request = try await journal.reserveExplicitRetry(previousOrderID)
        let reply = try await transport.prepareRetry(old.identity, request: request, session: session)
        try await journal.checkSession(session)
        let identity = try reply.identity(owner: session.ownerID)
        guard identity.orderID == request.freshOrderID, reply.previousOrderId == previousOrderID,
              identity.intentID == old.identity.intentID, reply.state == .prepared else { throw RecoveryError.invalid }
        try await journal.installPrepared(identity, retryOf: previousOrderID)
        return try await quote(identity, previous: previousOrderID, session: session)
        // No begin or StoreKit invocation is reachable from preparation.
    }
    func purchase(quoteID: UUID) async throws -> NativeOutcomeView {
        try start(); defer { busy = false }
        guard let quote = quotes.removeValue(forKey: quoteID) else { throw RecoveryError.conflict }
        let session = try await journal.currentSession()
        try await journal.checkSession(session)
        guard session.generation == quote.generation else { throw RecoveryError.conflict }
        let identity = quote.view.identity
        // Refresh Product BEFORE begin/dispatch. Price/currency changes reject
        // without opening Apple or consuming server launch authority.
        let launchProduct = try await catalog.prepare(productID: identity.productID, amountJpy: identity.amountJpy)
        try await journal.checkSession(session)
        guard launchProduct.productID == identity.productID, launchProduct.amountJpy == identity.amountJpy else { throw RecoveryError.invalid }
        let claim = try await journal.markBeginDispatched(identity.orderID)
        do {
            let reply = try await transport.begin(identity, session: session)
            guard reply.identity == identity, reply.launchGranted else { throw RecoveryError.conflict }
            let result = try await journal.executeLaunch(identity, claim: claim, launchGranted: reply.launchGranted, session: session) { isolatedJournal in
                try await launchProduct.launch(isolatedJournal, identity.orderID)
            }
            // Actual StoreKit callback must be retained even if logout happened
            // during its sheet. Server requests and UI results require fresh session.
            switch result {
            case .userCancelled:
                try await journal.recordStoreKitResult(identity.orderID, result: .userCancelled)
                try await journal.checkSession(session)
                do { try await journal.retryCancellationReport(identity.orderID, session: session, transport: transport) }
                catch { try await journal.checkSession(session) }
                return try await outcome(identity.orderID, preferred: "cancelled", session: session)
            case .pending:
                try await journal.recordStoreKitResult(identity.orderID, result: .pending)
                try await journal.checkSession(session)
                do { try await transport.reportPending(identity, session: session) }
                catch { try await journal.checkSession(session) }
                return try await outcome(identity.orderID, preferred: "pending", session: session)
            case .unknown:
                return try await outcome(identity.orderID, preferred: "unknown", session: session)
            case .verified(let purchase):
                try await journal.retainVerified(purchase.evidence)
                try await journal.checkSession(session)
                guard purchase.evidence.token == identity.orderID else {
                    return try await outcome(identity.orderID, preferred: "unknown", session: session)
                }
                do {
                    if let permit = try await journal.reconcile(identity.orderID, transactionID: purchase.evidence.transactionID, session: session, transport: transport) {
                        try await journal.executeFinish(permit, operation: purchase.finish)
                    }
                } catch { try await journal.checkSession(session) }
                do { _ = try await transport.status(identity, session: session) }
                catch { try await journal.checkSession(session) }
                return try await outcome(identity.orderID, preferred: "receiptObserved", session: session)
            }
        } catch {
            // No begin/purchase retry. Unknown stays a durable dispatch hold.
            try await journal.checkSession(session)
            return try await outcome(identity.orderID, preferred: "unknown", session: session)
        }
    }
    func outcome(_ id: UUID, preferred: String? = nil, session: OwnerSession) async throws -> NativeOutcomeView {
        let snapshot = try await journal.outcomeSnapshot(id, session: session)
        return Self.present(snapshot, preferred: preferred)
    }
    private static func present(_ snapshot: NativeOutcomeSnapshot, preferred: String? = nil) -> NativeOutcomeView {
        let record = snapshot.record
        let all = snapshot.relatedAttempts
        let id = record.identity.orderID
        let receipt = record.receipts.last
        let review = record.receipts.contains { $0.reviewRequired || $0.disposition == .excessPaymentReview || $0.disposition == .refundReview }
        let unresolvedEvidence = record.receipts.contains {
            $0.signedEvidence.isEmpty || $0.reconciledEvidenceGeneration != $0.signedEvidence.count
        }
        // Old durable flags are retained for audit but cannot describe newer proof.
        let fulfilled = !unresolvedEvidence && record.receipts.contains { $0.fulfillmentGranted && !$0.revoked }
        var local = preferred ?? (record.cancellationWasObserved ? "cancelled" : record.state == .pendingApproval ? "pending" : "unknown")
        if review { local = "review" }
        else if unresolvedEvidence { local = "receiptObserved" }
        else if fulfilled && receipt?.disposition == .winner && receipt?.fulfillmentGranted == true && receipt?.revoked == false && record.serverState == .transactionObserved { local = "applied" }
        else if receipt != nil && local != "cancelled" { local = "receiptObserved" }
        let retry = record.cancellationWasObserved && !record.cancellationReportPending
            && record.serverState == .clientReportedCancelled && record.state == .clientReportedCancelled
            && !all.contains(where: { $0.identity.intentID == record.identity.intentID && !$0.receipts.isEmpty })
            && !all.contains(where: { $0.predecessorID == id && ($0.state != .prepared || $0.launchExecutionID != nil) })
        var finish = "notStarted"
        if record.receipts.contains(where: { $0.finishExecutions.contains(where: { $0.state != .returned }) }) { finish = "startedUnknown" }
        else if let receipt, receipt.reconciledEvidenceGeneration != receipt.signedEvidence.count { finish = "newEvidenceNeedsReconciliation" }
        else if receipt?.finishReturned == true { finish = "returnedForCurrentEvidence" }
        return NativeOutcomeView(orderID: id, localOutcome: local, serverState: record.serverState,
            cancellationReportPending: record.cancellationReportPending, retryAvailable: retry, finishState: finish,
            receiptClassification: unresolvedEvidence ? nil : receipt?.disposition,
            reviewRequired: unresolvedEvidence ? (review ? true : nil) : (receipt?.disposition == nil ? nil : review),
            fulfillmentGranted: unresolvedEvidence ? false : (receipt?.disposition == nil ? nil : fulfilled))
    }
    func summaries(session: OwnerSession) async throws -> [NativeOutcomeView] {
        let snapshots = try await journal.outcomeSnapshots(session: session)
        return snapshots.map { Self.present($0) }
    }
}
