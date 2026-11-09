import Foundation

actor CoordinatorServer: NativeAdmissionTransport {
    let journal: RecoveryJournal
    let intent = UUID()
    var records: [UUID: AdmissionAttempt] = [:]
    var grants = Set<UUID>()
    var winner: String?
    var loseBegin = false
    var rejectCancel = false
    var rejectVerify = false
    var beginGate: CheckGate?
    private(set) var fulfillmentCount = 0
    init(_ journal: RecoveryJournal) { self.journal = journal }
    func setLostBegin() { loseBegin = true }
    func setCancelRejected(_ value: Bool) { rejectCancel = value }
    func setVerifyRejected() { rejectVerify = true }
    func suspendBegin(_ gate: CheckGate) { beginGate = gate }
    func prepareInitial(_ saved: InitialPreparation, session: OwnerSession) async throws -> AdmissionAttempt {
        if let old = records[saved.freshOrderID] { return old }
        let value = AdmissionAttempt(orderId: saved.freshOrderID, intentId: intent, attemptNonce: UUID(), previousOrderId: nil,
            environment: session.environment, productId: "com.ayuhide.koenofurima.voice.jpy300", amountJpy: 300, state: .prepared)
        records[value.orderId] = value; return value
    }
    func prepareRetry(_ predecessor: AttemptIdentity, request: RetryRequest, session: OwnerSession) async throws -> AdmissionAttempt {
        if let old = records[request.freshOrderID] { return old }
        let value = AdmissionAttempt(orderId: request.freshOrderID, intentId: predecessor.intentID, attemptNonce: UUID(), previousOrderId: predecessor.orderID,
            environment: session.environment, productId: predecessor.productID, amountJpy: predecessor.amountJpy, state: .prepared)
        records[value.orderId] = value; return value
    }
    func begin(_ identity: AttemptIdentity, session: OwnerSession) async throws -> LaunchReply {
        let granted = grants.insert(identity.orderID).inserted
        try await journal.applyServerState(identity, state: .dispatchUnknown, session: session)
        if let beginGate { await beginGate.pause() }
        if loseBegin { throw NativeTransportError.rejected(503) }
        return LaunchReply(identity: identity, launchGranted: granted)
    }
    func reportCancellation(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState {
        if rejectCancel { throw NativeTransportError.rejected(503) }
        return .clientReportedCancelled
    }
    func status(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState {
        try await journal.read(identity.orderID).serverState ?? .dispatchUnknown
    }
    func reportPending(_ identity: AttemptIdentity, session: OwnerSession) async throws {
        try await journal.applyServerState(identity, state: .pendingApproval, session: session)
    }
    func verify(_ identity: AttemptIdentity, signed: String, session: OwnerSession) async throws -> DurableReceipt {
        if rejectVerify { throw NativeTransportError.rejected(503) }
        let tx = signed.components(separatedBy: ":")[0]
        if winner == nil { winner = tx; fulfillmentCount += 1 }
        let isWinner = winner == tx
        try await journal.applyServerState(identity, state: .transactionObserved, session: session)
        return DurableReceipt(identity: identity, transactionID: tx, disposition: isWinner ? .winner : .excessPaymentReview,
            durablyRecorded: true, finishAllowed: isWinner, revoked: false, reviewRequired: !isWinner, fulfillmentGranted: isWinner)
    }
}
actor CoordinatorCatalog: NativeProductCatalog {
    enum ResultKind { case cancelled, pending, unknown, success }
    private var results: [ResultKind]
    private var prepareGate: CheckGate?
    private(set) var purchaseTokens: [UUID] = []
    private(set) var finishCount = 0
    init(_ results: [ResultKind]) { self.results = results }
    func suspendPrepare(_ gate: CheckGate) { prepareGate = gate }
    func prepare(productID: String, amountJpy: Int) async throws -> PreparedNativeProduct {
        if let prepareGate { await prepareGate.pause() }
        return PreparedNativeProduct(productID: productID, amountJpy: amountJpy, displayPrice: "¥\(amountJpy)") { _, token in
            try await self.invoke(token: token, productID: productID, amount: amountJpy)
        }
    }
    func invoke(token: UUID, productID: String, amount: Int) async throws -> NativePurchaseResult {
        purchaseTokens.append(token)
        guard !results.isEmpty else { throw RecoveryError.invalid }
        switch results.removeFirst() {
        case .cancelled: return .userCancelled
        case .pending: return .pending
        case .unknown: return .unknown
        case .success:
            let tx = String(100 + purchaseTokens.count)
            let proof = VerifiedEvidence(token: token, transactionID: tx, productID: productID, environment: "Sandbox", amountJpy: amount, signed: tx + ":mock-verified")
            return .verified(VerifiedNativePurchase(evidence: proof) { _ in await self.finished() })
        }
    }
    func finished() { finishCount += 1 }
}
struct NativeCoordinatorChecks {
    static func setup(_ root: URL, results: [CoordinatorCatalog.ResultKind]) async throws -> (RecoveryJournal, NativePurchaseCoordinator, CoordinatorServer, CoordinatorCatalog, OwnerSession) {
        let journal = RecoveryJournal(directory: root.appendingPathComponent("attempts"), legacyURL: root.appendingPathComponent("legacy.json"), requireSessionFreshness: true)
        let session = try await journal.replaceSession(ownerID: UUID(), environment: "Sandbox", bearer: "coordinator-fixture")
        let server = CoordinatorServer(journal), catalog = CoordinatorCatalog(results)
        let coordinator = NativePurchaseCoordinator(journal: journal, transport: server, catalog: catalog, admissionEnabled: true)
        return (journal, coordinator, server, catalog, session)
    }
    static func run(root: URL) async throws {
        // Entire native coordinator path. Mocks do not prove Apple or real SQL behavior.
        do {
            let (journal, coordinator, server, catalog, session) = try await setup(root.appendingPathComponent("normal-cancel-retry"), results: [.cancelled, .success])
            let first = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.isEmpty, "Preparation never purchases")
            let cancelled = try await coordinator.purchase(quoteID: first.quoteID)
            try RecoveryJournalChecks.require(cancelled.localOutcome == "cancelled" && cancelled.retryAvailable && !cancelled.cancellationReportPending && cancelled.serverState == .clientReportedCancelled, "Actual normal cancellation acknowledged without financial cancellation")
            _ = try await coordinator.summaries(session: session)
            _ = try await server.reportCancellation(first.identity, session: session)
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.count == 1, "Recovery/report never purchases again")
            let retry = try await coordinator.prepareRetry(previousOrderID: first.identity.orderID)
            try RecoveryJournalChecks.require(retry.identity.orderID != first.identity.orderID && retry.identity.nonce != first.identity.nonce, "Fresh token and attempt nonce")
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.count == 1, "prepareRetry is preview only")
            let replayedPreview = try await coordinator.prepareRetry(previousOrderID: first.identity.orderID)
            try RecoveryJournalChecks.require(replayedPreview.identity == retry.identity && replayedPreview.quoteID != retry.quoteID, "Lost preview reuses child but requires new live confirmation")
            try await RecoveryJournalChecks.reject { _ = try await coordinator.purchase(quoteID: retry.quoteID) }
            let paid = try await coordinator.purchase(quoteID: replayedPreview.quoteID)
            try RecoveryJournalChecks.require(paid.localOutcome == "applied" && paid.fulfillmentGranted == true && paid.reviewRequired == false && paid.finishState == "returnedForCurrentEvidence", "Exact durable winner and finish outcome")
            try await RecoveryJournalChecks.require(catalog.purchaseTokens == [first.identity.orderID, retry.identity.orderID], "Exactly one StoreKit invocation for each explicit confirmation")
            let finishCount = await catalog.finishCount, fulfillmentCount = await server.fulfillmentCount
            try RecoveryJournalChecks.require(finishCount == 1 && fulfillmentCount == 1, "One finish and one fulfillment")
            try await RecoveryJournalChecks.reject { _ = try await coordinator.purchase(quoteID: replayedPreview.quoteID) }
            // Old receipt arrives late and is retained on old order, never a second service.
            let late = VerifiedEvidence(token: first.identity.orderID, transactionID: "999", productID: first.identity.productID, environment: first.identity.environment, amountJpy: first.identity.amountJpy, signed: "999:late-old")
            try await journal.retainVerified(late)
            let permit = try await journal.reconcile(first.identity.orderID, transactionID: "999", session: session, transport: server)
            try RecoveryJournalChecks.require(permit == nil, "Late excess does not finish")
            let laterFulfillmentCount = await server.fulfillmentCount, laterFinishCount = await catalog.finishCount
            try RecoveryJournalChecks.require(laterFulfillmentCount == 1 && laterFinishCount == 1, "Late old receipt cannot duplicate fulfillment")
            try await RecoveryJournalChecks.require(journal.read(retry.identity.orderID).receipts[0].transactionID != "999", "Old proof never overwrites new attempt")
        }
        do {
            let (journal, coordinator, server, catalog, session) = try await setup(root.appendingPathComponent("cancel-report-loss"), results: [.cancelled])
            let quote = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            await server.setCancelRejected(true)
            let cancelled = try await coordinator.purchase(quoteID: quote.quoteID)
            try RecoveryJournalChecks.require(cancelled.localOutcome == "cancelled" && cancelled.cancellationReportPending && !cancelled.retryAvailable, "Report loss keeps actual cancellation but no retry admission")
            try await RecoveryJournalChecks.reject { _ = try await coordinator.prepareRetry(previousOrderID: quote.identity.orderID) }
            await server.setCancelRejected(false)
            try await journal.retryCancellationReport(quote.identity.orderID, session: session, transport: server)
            let recovered = try await coordinator.outcome(quote.identity.orderID, session: session)
            try RecoveryJournalChecks.require(recovered.retryAvailable && !recovered.cancellationReportPending, "Report-only retry can recover admission")
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.count == 1, "Cancel report retry never reissues purchase")
        }
        for mode in [CoordinatorCatalog.ResultKind.pending, .unknown] {
            let (journal, coordinator, _, catalog, _) = try await setup(root.appendingPathComponent(UUID().uuidString), results: [mode])
            let preview = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            let outcome = try await coordinator.purchase(quoteID: preview.quoteID)
            try RecoveryJournalChecks.require(!outcome.retryAvailable && outcome.localOutcome != "cancelled", "Pending/unknown is not cancellation")
            try await RecoveryJournalChecks.reject { _ = try await coordinator.prepareRetry(previousOrderID: preview.identity.orderID) }
            let calls = await catalog.purchaseTokens.count
            let record = try await journal.read(preview.identity.orderID)
            try RecoveryJournalChecks.require(calls == 1 && !record.cancellationWasObserved, "No automatic retry or fake cancel")
        }
        do {
            let (_, coordinator, server, catalog, _) = try await setup(root.appendingPathComponent("lost-begin"), results: [.success])
            let preview = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            await server.setLostBegin()
            let outcome = try await coordinator.purchase(quoteID: preview.quoteID)
            try RecoveryJournalChecks.require(outcome.localOutcome == "unknown" && !outcome.retryAvailable, "Lost begin remains unknown")
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.isEmpty, "No purchase on lost begin")
            try await RecoveryJournalChecks.reject { _ = try await coordinator.purchase(quoteID: preview.quoteID) }
        }
        do {
            let (journal, coordinator, _, catalog, session) = try await setup(root.appendingPathComponent("quote-session"), results: [.success])
            let preview = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            _ = try await journal.replaceSession(ownerID: session.ownerID, environment: session.environment, bearer: "refreshed")
            try await RecoveryJournalChecks.reject { _ = try await coordinator.purchase(quoteID: preview.quoteID) }
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.isEmpty, "Old session quote has no execution authority")
        }
        // A newer signed version invalidates PRESENTATION of old winner flags,
        // even if server verification/status is unavailable after that arrival.
        do {
            let (journal, coordinator, server, _, session) = try await setup(root.appendingPathComponent("new-proof-display"), results: [.success])
            let quote = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            let winner = try await coordinator.purchase(quoteID: quote.quoteID)
            try RecoveryJournalChecks.require(winner.localOutcome == "applied", "Initial winner is current")
            let first = try await journal.read(quote.identity.orderID).receipts[0]
            let newProof = VerifiedEvidence(token: quote.identity.orderID, transactionID: first.transactionID,
                productID: quote.identity.productID, environment: quote.identity.environment,
                amountJpy: quote.identity.amountJpy, signed: first.transactionID + ":new-refund-version")
            try await journal.retainVerified(newProof)
            await server.setVerifyRejected()
            try await RecoveryJournalChecks.reject { _ = try await journal.reconcile(quote.identity.orderID, transactionID: first.transactionID, session: session, transport: server) }
            let pending = try await coordinator.outcome(quote.identity.orderID, session: session)
            try RecoveryJournalChecks.require(pending.localOutcome == "receiptObserved" && pending.fulfillmentGranted == false
                && pending.receiptClassification == nil && pending.reviewRequired != false
                && pending.finishState == "newEvidenceNeedsReconciliation", "New proof never reuses old winner presentation")
            let summary = try await coordinator.summaries(session: session)
            try RecoveryJournalChecks.require(summary[0].localOutcome != "applied", "Recovery summaries use the same generation rule")
            for n in 0..<10 {
                let proof = VerifiedEvidence(token: quote.identity.orderID, transactionID: first.transactionID,
                    productID: quote.identity.productID, environment: quote.identity.environment,
                    amountJpy: quote.identity.amountJpy, signed: first.transactionID + ":concurrent-\(n)")
                async let write: Void = try await journal.retainVerified(proof)
                async let read = try await journal.outcomeSnapshot(quote.identity.orderID, session: session)
                let (_, snapshot) = try await (write, read)
                let same = snapshot.relatedAttempts.first { $0.identity.orderID == quote.identity.orderID }!
                try RecoveryJournalChecks.require(snapshot.record == same, "Record and related attempts belong to one actor snapshot")
            }
        }
        // Production-equivalent freshness enabled, refresh while Product fetch waits.
        do {
            let (journal, coordinator, _, catalog, session) = try await setup(root.appendingPathComponent("refresh-catalog"), results: [.success])
            let gate = CheckGate(); await catalog.suspendPrepare(gate)
            let preparing = Task { try await coordinator.prepare(kind: "voice_listing", subjectID: UUID()) }
            await gate.waitForEntry()
            _ = try await journal.replaceSession(ownerID: session.ownerID, environment: session.environment, bearer: "refresh-during-catalog")
            await gate.release()
            try await RecoveryJournalChecks.reject { _ = try await preparing.value }
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.isEmpty, "Stale catalog cannot create launch")
        }
        // Refresh after begin dispatch while the server reply is suspended.
        do {
            let (journal, coordinator, server, catalog, session) = try await setup(root.appendingPathComponent("refresh-begin"), results: [.success])
            let quote = try await coordinator.prepare(kind: "voice_listing", subjectID: UUID())
            let gate = CheckGate(); await server.suspendBegin(gate)
            let purchasing = Task { try await coordinator.purchase(quoteID: quote.quoteID) }
            await gate.waitForEntry()
            _ = try await journal.replaceSession(ownerID: session.ownerID, environment: session.environment, bearer: "refresh-during-begin")
            await gate.release()
            try await RecoveryJournalChecks.reject { _ = try await purchasing.value }
            try await RecoveryJournalChecks.require(catalog.purchaseTokens.isEmpty, "Stale begin reply cannot launch")
        }
        print("Coordinator cancel -> explicit new preview -> explicit confirmation -> winner mock chain passed; no real purchase.")
    }
}
