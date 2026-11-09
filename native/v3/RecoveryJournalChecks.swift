// Standalone executable checks for macOS Swift (not run in Linux without Swift).
// Run from the repository root: bash scripts/test-native-v3.sh (includes every test source).
import Foundation

actor MockTransport: RecoveryTransport {
    var disposition: ReceiptDisposition = .winner
    var allowFinish = true
    var reports = 0
    func configure(_ disposition: ReceiptDisposition, allow: Bool) { self.disposition = disposition; allowFinish = allow }
    func reportCancellation(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState { reports += 1; return .clientReportedCancelled }
    func verify(_ identity: AttemptIdentity, signed: String, session: OwnerSession) async throws -> DurableReceipt {
        DurableReceipt(identity: identity, transactionID: signed.components(separatedBy: ":")[0],
            disposition: disposition, durablyRecorded: true, finishAllowed: allowFinish,
            revoked: false, reviewRequired: disposition != .winner, fulfillmentGranted: disposition == .winner)
    }
}
@main struct RecoveryJournalChecks {
    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
    static func reject(_ operation: () async throws -> Void) async throws {
        do { try await operation() } catch { return }
        throw NSError(domain: "Expected rejection", code: 1)
    }
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("legacy.json")
        let dir = root.appendingPathComponent("attempts")
        let journal = RecoveryJournal(directory: dir, legacyURL: legacy, requireSessionFreshness: false)
        let owner = UUID(), intent = UUID()
        func identity(_ order: UUID = UUID(), _ purpose: UUID? = nil) -> AttemptIdentity {
            AttemptIdentity(orderID: order, nonce: UUID(), intentID: purpose ?? intent, ownerID: owner,
                backendProjectRef: "tyulybijubckitybgubc", environment: "Sandbox",
                productID: "com.ayuhide.koenofurima.voice.jpy300", amountJpy: 300)
        }
        let a = identity()
        let session = OwnerSession(ownerID: owner, backendProjectRef: a.backendProjectRef, environment: a.environment, bearer: "NEVER_PERSIST_THIS")
        let transport = MockTransport()
        try await journal.installPrepared(a)
        _ = try await journal.markBeginDispatched(a.orderID)
        try await reject { _ = try await journal.markBeginDispatched(a.orderID) }
        try await journal.recordStoreKitResult(a.orderID, result: .unknown)
        try await require(journal.read(a.orderID).state == .dispatchUnknown, "Unknown is not cancellation")
        try await reject { _ = try await journal.reserveExplicitRetry(a.orderID) }
        try await journal.recordStoreKitResult(a.orderID, result: .userCancelled)
        try await reject { _ = try await journal.reserveExplicitRetry(a.orderID) }
        try await journal.retryCancellationReport(a.orderID, session: session, transport: transport)
        let request = try await journal.reserveExplicitRetry(a.orderID)
        let replay = try await journal.reserveExplicitRetry(a.orderID)
        try require(request == replay, "Retry response loss reuses request")
        let b = identity(request.freshOrderID)
        try await journal.installPrepared(b, retryOf: a.orderID)
        try await reject { try await journal.installPrepared(identity(), retryOf: a.orderID) }
        func proof(_ tx: String, _ token: UUID, _ suffix: String = "one") -> VerifiedEvidence {
            VerifiedEvidence(token: token, transactionID: tx, productID: a.productID,
                environment: a.environment, amountJpy: a.amountJpy, signed: tx + ":" + suffix)
        }
        try await journal.retainVerified(proof("100", a.orderID))
        try await journal.retainVerified(proof("100", a.orderID))
        try await require(journal.read(a.orderID).receipts.count == 1, "Deduplicated receipt")
        try await require(journal.read(b.orderID).receipts.isEmpty, "Late old receipt must not overwrite new")
        let finish = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: transport)
        try require(finish != nil, "Exact durable winner allowed")
        try await journal.executeFinish(finish!) { _ in }
        try await journal.archive(a.orderID)
        try await journal.retainVerified(proof("101", a.orderID))
        await transport.configure(.excessPaymentReview, allow: true)
        let excess = try await journal.reconcile(a.orderID, transactionID: "101", session: session, transport: transport)
        try require(excess == nil, "Review never normal finish, even with erroneous allow flag")
        try await reject { try await journal.executeFinish(FinishPermit(id: UUID(), orderID: a.orderID, transactionID: "101", evidenceGeneration: 1)) { _ in } }
        try await reject { try await journal.retainVerified(proof("102", UUID())) }
        let foreign = OwnerSession(ownerID: UUID(), backendProjectRef: a.backendProjectRef, environment: a.environment, bearer: "other")
        try await reject { _ = try await journal.reconcile(a.orderID, transactionID: "100", session: foreign, transport: transport) }
        let restored = RecoveryJournal(directory: dir, legacyURL: legacy, requireSessionFreshness: false)
        try await require(restored.all().count == 2, "All attempts survive restart")
        let bytes = try Data(contentsOf: dir.appendingPathComponent(a.orderID.uuidString.lowercased() + ".json"))
        try require(!String(decoding: bytes, as: UTF8.self).contains(session.bearer), "No bearer persistence")
        let legacyBytes = Data("{\"productID\":\"old\",\"token\":\"\(UUID().uuidString)\"}".utf8)
        try legacyBytes.write(to: legacy)
        let decoded = try await restored.decodeLegacyForInspection()
        try require(decoded?.schemaVersion == nil, "Missing provenance never invented")
        try await reject { try await restored.installPrepared(identity(UUID(), UUID())) }
        try require(try Data(contentsOf: legacy) == legacyBytes, "Legacy remains byte identical")
        var wire: [String: Any] = ["version": 3, "backendProjectRef": a.backendProjectRef,
            "ownerId": a.ownerID.uuidString, "intentId": a.intentID.uuidString,
            "orderId": a.orderID.uuidString, "transactionId": "100", "productId": a.productID,
            "environment": a.environment, "amountJpy": a.amountJpy,
            "receiptClassification": "winner", "financiallyRecorded": true, "revoked": false,
            "reviewRequired": false, "fulfillmentGranted": true, "finishAllowed": true]
        func response(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: ["nativeReceipt": value]) }
        let dto = try DurableReceipt.decodeBackendResponse(response(wire), expected: a, transactionID: "100")
        try require(dto.finishAllowed, "Exact typed DTO accepted")
        wire.removeValue(forKey: "finishAllowed")
        try await reject { _ = try DurableReceipt.decodeBackendResponse(response(wire), expected: a, transactionID: "100") }
        wire["finishAllowed"] = true
        wire["receiptClassification"] = "excess_payment_review"
        try await reject { _ = try DurableReceipt.decodeBackendResponse(response(wire), expected: a, transactionID: "100") }
        try await InterleavingChecks.run(root: root.appendingPathComponent("interleavings"))
        try await NativeTransportChecks.run(root: root.appendingPathComponent("transport"))
        try await NativeCoordinatorChecks.run(root: root.appendingPathComponent("coordinator"))
        print("Native journal executable checks passed (no StoreKit/device coverage).")
    }
}
