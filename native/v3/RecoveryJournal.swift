import Foundation

// Local-only foundation. Not linked into the app or the release preparation script.
// No endpoint names are assumed. Never make this true before integration/device QA.
enum RecoveryIntegration {
    static let hostEnabled = false
    static let newAdmissionEnabled = false
    static let recoveryEnabled = false
}
enum RecoveryError: Error { case invalid, conflict, disabled, legacyHold, busy }
enum LaunchState: String, Codable { case prepared, dispatchUnknown, pendingApproval, clientReportedCancelled, transactionObserved }
enum ReceiptDisposition: String, Codable {
    case winner
    case excessPaymentReview = "excess_payment_review"
    case refundedUnfulfilled = "refunded_unfulfilled"
    case refundReview = "refund_review_unfulfilled"
}

struct AttemptIdentity: Codable, Equatable {
    let orderID: UUID // Apple appAccountToken, permanently bound to this attempt
    let nonce: UUID
    let intentID: UUID
    let ownerID: UUID
    let backendProjectRef: String
    let environment: String
    let productID: String
    let amountJpy: Int
    func validate() throws {
        let boostAmounts = ["com.ayuhide.koenofurima.boost.silver": 300,
                            "com.ayuhide.koenofurima.boost.gold": 800,
                            "com.ayuhide.koenofurima.boost.platinum": 1500]
        let frozenAmount = boostAmounts[productID] ?? Int(productID.components(separatedBy: ".jpy").last ?? "")
        guard frozenAmount == amountJpy, backendProjectRef == "tyulybijubckitybgubc",
              ["Sandbox", "Production"].contains(environment), amountJpy > 0,
              productID.range(of: "^com\\.ayuhide\\.koenofurima\\.(voice\\.jpy[1-9][0-9]{0,7}|boost\\.(silver|gold|platinum))$", options: .regularExpression) != nil else { throw RecoveryError.invalid }
    }
}
enum FinishExecutionState: String, Codable { case started, returned, outcomeUnknown }
struct FinishExecution: Codable, Equatable {
    let id: UUID
    let evidenceGeneration: Int
    var state: FinishExecutionState
}
// Deliberately not Codable: a saved/replayed result is never execution authority.
struct FinishPermit: Equatable {
    let id: UUID
    let orderID: UUID
    let transactionID: String
    let evidenceGeneration: Int
    var sessionGeneration: UUID? = nil
}
struct ReceiptRecord: Codable, Equatable {
    let transactionID: String
    // Different signed versions of one transaction must not overwrite old proof.
    var signedEvidence: [String]
    var disposition: ReceiptDisposition?
    var finishReturned: Bool = false
    var finishAuthorized: Bool = false
    var reconciledEvidenceGeneration: Int? = nil
    var finishExecutions: [FinishExecution] = []
    var revoked: Bool = false
    var reviewRequired: Bool = false
    var fulfillmentGranted: Bool = false
}
struct InitialPreparation: Codable, Equatable {
    let freshOrderID: UUID
    let ownerID: UUID
    let environment: String
    let kind: String
    let subjectID: UUID
    let boostPlan: String?
}
struct RetryRequest: Codable, Equatable {
    let freshOrderID: UUID
    let actionNonce: UUID
}
struct AttemptRecord: Codable, Equatable {
    let schemaVersion: Int
    let identity: AttemptIdentity
    let predecessorID: UUID?
    var state: LaunchState
    var cancellationReportPending: Bool
    var cancellationWasObserved: Bool
    var receipts: [ReceiptRecord]
    var archived: Bool
    var retryRequest: RetryRequest? = nil
    var launchExecutionID: UUID? = nil
    var serverState: ServerAttemptState? = nil
}
// One actor-linearized read for presentation. Values contain no credentials.
struct NativeOutcomeSnapshot {
    let record: AttemptRecord
    let relatedAttempts: [AttemptRecord]
}
// In-memory authentication is supplied by the host for each operation. It is
// intentionally absent from Codable models and never held by the journal.
enum ServerAttemptState: String, Codable {
    case prepared, retired
    case dispatchUnknown = "dispatch_unknown"
    case pendingApproval = "pending_approval"
    case clientReportedCancelled = "client_reported_cancelled"
    case transactionObserved = "transaction_observed"
}
struct OwnerSession {
    let ownerID: UUID
    let backendProjectRef: String
    let environment: String
    let bearer: String
    let generation: UUID?
    init(ownerID: UUID, backendProjectRef: String, environment: String, bearer: String, generation: UUID? = nil) {
        self.ownerID = ownerID; self.backendProjectRef = backendProjectRef
        self.environment = environment; self.bearer = bearer; self.generation = generation
    }
}
struct DurableReceipt {
    let identity: AttemptIdentity
    let transactionID: String
    let disposition: ReceiptDisposition
    let durablyRecorded: Bool
    let finishAllowed: Bool
    let revoked: Bool
    let reviewRequired: Bool
    let fulfillmentGranted: Bool
}
protocol RecoveryTransport {
    // Implementations MUST use the fixed original backend with redirects rejected,
    // verify authenticated owner and exact immutable fields, and map the final
    // common nativeReceipt contract. Never trust a JS-supplied classification.
    func reportCancellation(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState
    func verify(_ identity: AttemptIdentity, signed: String, session: OwnerSession) async throws -> DurableReceipt
}

// Build44/v2 fields remain optional exactly where historical records lacked them.
// Decoding is diagnostic, not adoption, permission to finish, or financial proof.
struct LegacyAttemptReadOnly: Decodable {
    let productID: String
    let token: UUID
    let schemaVersion: Int?
    let backendProjectRef: String?
    let storeKitEnvironment: String?
    let transactionID: String?
    let attemptNonce: UUID?
    let finishReturned: Bool?
    let signedTransaction: String?
    let ownerID: String?
    let amountJpy: Int?
}

actor RecoveryJournal {
    private let directory: URL
    private let legacyURL: URL
    private let writer: (Data, URL) throws -> Void
    // Serializes network operations too: Swift actors are reentrant at await.
    private var operations = Set<UUID>()
    private var finishPermits: [UUID: FinishPermit] = [:]
    private var beginClaims: [UUID: UUID] = [:]
    private let requireSessionFreshness: Bool
    private var activeSession: OwnerSession? = nil
    private var sessionSequence: UInt64 = 0
    init(directory: URL, legacyURL: URL, requireSessionFreshness: Bool = true,
         writer: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        self.directory = directory; self.legacyURL = legacyURL; self.writer = writer
        self.requireSessionFreshness = requireSessionFreshness
    }
    func replaceSession(ownerID: UUID, environment: String, bearer: String, sequence: UInt64? = nil) throws -> OwnerSession {
        guard ["Sandbox", "Production"].contains(environment), !bearer.isEmpty else { throw RecoveryError.invalid }
        let next = sequence ?? (sessionSequence + 1)
        guard next > sessionSequence else { throw RecoveryError.conflict }
        sessionSequence = next
        let session = OwnerSession(ownerID: ownerID, backendProjectRef: "tyulybijubckitybgubc",
                                   environment: environment, bearer: bearer, generation: UUID())
        activeSession = session
        beginClaims.removeAll(); finishPermits.removeAll()
        return session
    }
    func clearSession(sequence: UInt64? = nil) {
        let next = sequence ?? (sessionSequence + 1)
        guard next > sessionSequence else { return }
        sessionSequence = next
        activeSession = nil; beginClaims.removeAll(); finishPermits.removeAll()
    }
    func currentSession() throws -> OwnerSession {
        guard let session = activeSession else { throw RecoveryError.invalid }
        return session
    }
    func checkSession(_ session: OwnerSession) throws {
        guard session.generation != nil, activeSession?.generation == session.generation,
              activeSession?.ownerID == session.ownerID, activeSession?.bearer == session.bearer,
              activeSession?.environment == session.environment else { throw RecoveryError.invalid }
    }
    func reserveInitial(kind: String, subjectID: UUID, boostPlan: String? = nil, session: OwnerSession) throws -> InitialPreparation {
        try checkSession(session)
        guard try legacyBytes() == nil, ["voice_listing", "voice_job", "boost"].contains(kind),
              kind == "boost" ? ["silver", "gold", "platinum"].contains(boostPlan ?? "") : boostPlan == nil else { throw RecoveryError.invalid }
        let preparations = directory.appendingPathComponent("preparations")
        if FileManager.default.fileExists(atPath: preparations.path) {
            let matches = try FileManager.default.contentsOfDirectory(at: preparations, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }.map { try JSONDecoder().decode(InitialPreparation.self, from: Data(contentsOf: $0)) }
                .filter { $0.ownerID == session.ownerID && $0.environment == session.environment && $0.kind == kind && $0.subjectID == subjectID && $0.boostPlan == boostPlan }
            guard matches.count <= 1 else { throw RecoveryError.conflict }
            if let existing = matches.first { return existing }
        }
        let value = InitialPreparation(freshOrderID: UUID(), ownerID: session.ownerID, environment: session.environment,
                                       kind: kind, subjectID: subjectID, boostPlan: boostPlan)
        let root = directory.appendingPathComponent("preparations")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try writer(JSONEncoder().encode(value), root.appendingPathComponent(value.freshOrderID.uuidString.lowercased() + ".json"))
        guard try readInitial(value.freshOrderID) == value else { throw RecoveryError.invalid }
        return value
    }
    func readInitial(_ order: UUID) throws -> InitialPreparation {
        let path = directory.appendingPathComponent("preparations").appendingPathComponent(order.uuidString.lowercased() + ".json")
        let value = try JSONDecoder().decode(InitialPreparation.self, from: Data(contentsOf: path))
        guard value.freshOrderID == order else { throw RecoveryError.invalid }
        return value
    }
    func applyServerState(_ identity: AttemptIdentity, state: ServerAttemptState, session: OwnerSession) throws {
        try validate(session, identity: identity)
        var value = try read(identity.orderID)
        guard value.identity == identity else { throw RecoveryError.invalid }
        value.serverState = state
        try persist(value) // Server state is not signed financial evidence.
    }
    private func path(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString.lowercased() + ".json") }
    func read(_ id: UUID) throws -> AttemptRecord {
        let value = try JSONDecoder().decode(AttemptRecord.self, from: Data(contentsOf: path(id)))
        guard value.schemaVersion == 3, value.identity.orderID == id else { throw RecoveryError.invalid }
        try value.identity.validate()
        return value
    }
    func all() throws -> [AttemptRecord] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.map {
                guard let id = UUID(uuidString: $0.deletingPathExtension().lastPathComponent) else { throw RecoveryError.invalid }
                return try read(id)
            }
    }
    func outcomeSnapshot(_ id: UUID, session: OwnerSession) throws -> NativeOutcomeSnapshot {
        try checkSession(session)
        let records = try all().filter { $0.identity.ownerID == session.ownerID }
        guard let record = records.first(where: { $0.identity.orderID == id }),
              record.identity.environment == session.environment else { throw RecoveryError.invalid }
        return NativeOutcomeSnapshot(record: record, relatedAttempts: records)
    }
    func outcomeSnapshots(session: OwnerSession) throws -> [NativeOutcomeSnapshot] {
        try checkSession(session)
        guard try legacyBytes() == nil else { throw RecoveryError.legacyHold }
        let records = try all().filter { $0.identity.ownerID == session.ownerID }
        return records.filter { $0.identity.environment == session.environment }.map {
            NativeOutcomeSnapshot(record: $0, relatedAttempts: records)
        }
    }
    private func persist(_ value: AttemptRecord) throws {
        try value.identity.validate()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try writer(JSONEncoder().encode(value), path(value.identity.orderID))
        guard try read(value.identity.orderID) == value else { throw RecoveryError.invalid }
    }
    // Even undecodable/unknown build44 data remains in place. Read-only snapshot
    // for diagnostics; never infer missing provenance, delete, or reuse its token.
    func legacyBytes() throws -> Data? {
        guard FileManager.default.fileExists(atPath: legacyURL.path) else { return nil }
        return try Data(contentsOf: legacyURL)
    }
    func decodeLegacyForInspection() throws -> LegacyAttemptReadOnly? {
        guard let bytes = try legacyBytes() else { return nil }
        // Decode failures propagate while preserving the original file unchanged.
        return try JSONDecoder().decode(LegacyAttemptReadOnly.self, from: bytes)
    }
    func installPrepared(_ identity: AttemptIdentity, retryOf: UUID? = nil) throws {
        if requireSessionFreshness { try validate(currentSession(), identity: identity) }
        try identity.validate()
        guard try legacyBytes() == nil else { throw RecoveryError.legacyHold }
        let existing = try all()
        if let saved = existing.first(where: { $0.identity.orderID == identity.orderID }) {
            guard saved.identity == identity, saved.predecessorID == retryOf, saved.state == .prepared,
                  saved.receipts.isEmpty, saved.launchExecutionID == nil else { throw RecoveryError.conflict }
            return // Exact preparation-response replay, never a dispatch replay.
        }
        guard !existing.contains(where: { $0.identity.orderID == identity.orderID || $0.identity.nonce == identity.nonce }) else { throw RecoveryError.conflict }
        if let predecessor = retryOf {
            guard !existing.contains(where: { $0.predecessorID == predecessor }) else { throw RecoveryError.conflict }
            let old = try read(predecessor)
            guard old.retryRequest?.freshOrderID == identity.orderID, old.cancellationWasObserved, old.state == .clientReportedCancelled,
                  !old.cancellationReportPending, old.identity.intentID == identity.intentID,
                  old.identity.ownerID == identity.ownerID, old.identity.backendProjectRef == identity.backendProjectRef,
                  old.identity.environment == identity.environment, old.identity.productID == identity.productID,
                  old.identity.amountJpy == identity.amountJpy else { throw RecoveryError.conflict }
        } else {
            guard !existing.contains(where: { $0.identity.intentID == identity.intentID }) else { throw RecoveryError.conflict }
        }
        // Only a server-authorized prepared reply may call this in future host wiring.
        try persist(AttemptRecord(schemaVersion: 3, identity: identity, predecessorID: retryOf, state: .prepared,
            cancellationReportPending: false, cancellationWasObserved: false, receipts: [], archived: false))
    }
    // Called only for a fresh explicit retry action. A lost response reuses this
    // request ID, never generates a second Apple order/token or calls purchase.
    func reserveExplicitRetry(_ predecessor: UUID) throws -> RetryRequest {
        var old = try read(predecessor)
        if requireSessionFreshness { try validate(currentSession(), identity: old.identity) }
        guard old.cancellationWasObserved, !old.cancellationReportPending,
              old.state == .clientReportedCancelled, old.serverState == .clientReportedCancelled else { throw RecoveryError.conflict }
        let children = try all().filter { $0.predecessorID == predecessor }
        if let pending = old.retryRequest {
            guard children.allSatisfy({ $0.identity.orderID == pending.freshOrderID && $0.state == .prepared
                && $0.launchExecutionID == nil && $0.receipts.isEmpty }) else { throw RecoveryError.conflict }
            return pending
        }
        guard children.isEmpty else { throw RecoveryError.conflict }
        let request = RetryRequest(freshOrderID: UUID(), actionNonce: UUID())
        old.retryRequest = request
        try persist(old)
        return request
    }
    // Call BEFORE requesting begin. Only this live actor retains the claim;
    // restart, replay and lost response cannot manufacture another invocation.
    func markBeginDispatched(_ id: UUID) throws -> UUID {
        var value = try read(id)
        if requireSessionFreshness { try validate(currentSession(), identity: value.identity) }
        guard value.state == .prepared, value.launchExecutionID == nil else { throw RecoveryError.conflict }
        value.state = .dispatchUnknown
        try persist(value)
        let claim = UUID()
        beginClaims[id] = claim
        return claim
    }
    func executeLaunch<T>(_ identity: AttemptIdentity, claim: UUID, launchGranted: Bool, session: OwnerSession? = nil,
                          operation: (isolated RecoveryJournal) async throws -> T) async throws -> T {
        var value = try read(identity.orderID)
        if requireSessionFreshness {
            guard let session else { throw RecoveryError.invalid }
            try validate(session, identity: identity)
        }
        guard launchGranted, beginClaims[identity.orderID] == claim,
              value.identity == identity, value.state == .dispatchUnknown,
              value.serverState == nil || value.serverState == .prepared || value.serverState == .dispatchUnknown,
              value.launchExecutionID == nil,
              !(try all()).contains(where: { $0.identity.intentID == identity.intentID && !$0.receipts.isEmpty })
              else { throw RecoveryError.conflict }
        // The isolated closure enters on this actor, without an executor hop.
        // This durable reservation is the local invocation boundary. No actor
        // suspension occurs between validation and reservation. New evidence
        // AFTER it is late evidence, not authority to replay/cancel the call.
        value.launchExecutionID = claim
        try persist(value)
        beginClaims.removeValue(forKey: identity.orderID)
        return try await operation(self)
        // Thrown/cancelled/never-returning operation leaves dispatch unknown.
    }
    // Only the immediate StoreKit return path invokes this, never an exception,
    // timeout, missing transaction, server status, or user pressing a web button.
    func recordStoreKitResult(_ id: UUID, result: StoreKitOutcome) throws {
        var value = try read(id)
        guard value.state == .dispatchUnknown || value.state == .transactionObserved else { throw RecoveryError.conflict }
        switch result {
        case .userCancelled:
            value.cancellationWasObserved = true
            value.cancellationReportPending = true
            if value.state != .transactionObserved { value.state = .clientReportedCancelled }
        case .pending:
            if value.state != .transactionObserved { value.state = .pendingApproval }
        case .unknown: break
        }
        try persist(value)
    }
    private func validate(_ session: OwnerSession, identity: AttemptIdentity) throws {
        if requireSessionFreshness { try checkSession(session) }
        guard session.ownerID == identity.ownerID, session.backendProjectRef == identity.backendProjectRef,
              session.environment == identity.environment, !session.bearer.isEmpty else { throw RecoveryError.invalid }
    }
    func retryCancellationReport(_ id: UUID, session: OwnerSession, transport: RecoveryTransport) async throws {
        let value = try read(id)
        try validate(session, identity: value.identity)
        guard value.cancellationWasObserved, value.cancellationReportPending else { throw RecoveryError.conflict }
        guard operations.insert(id).inserted else { throw RecoveryError.busy }
        defer { operations.remove(id) }
        let actualState = try await transport.reportCancellation(value.identity, session: session)
        try validate(session, identity: value.identity)
        guard [ServerAttemptState.clientReportedCancelled, .transactionObserved, .retired].contains(actualState) else { throw RecoveryError.invalid }
        // Reload: receipt arrival during await must not be overwritten by old state.
        var latest = try read(id)
        latest.cancellationReportPending = false
        latest.serverState = actualState
        try persist(latest)
    }
    // Input must come exclusively from StoreKit .verified. Persisted JWS is only
    // retained evidence; the server must reverify it, including latest refund state.
    func retainVerified(_ evidence: VerifiedEvidence) throws {
        var value = try read(evidence.token)
        guard value.identity.productID == evidence.productID,
              value.identity.environment == evidence.environment,
              value.identity.amountJpy == evidence.amountJpy,
              evidence.transactionID.range(of: "^[0-9]{1,40}$", options: .regularExpression) != nil,
              !evidence.signed.isEmpty, evidence.signed.utf8.count <= 30000 else { throw RecoveryError.invalid }
        if let index = value.receipts.firstIndex(where: { $0.transactionID == evidence.transactionID }) {
            if !value.receipts[index].signedEvidence.contains(evidence.signed) { value.receipts[index].signedEvidence.append(evidence.signed)
                value.receipts[index].finishAuthorized = false
                value.receipts[index].finishReturned = false }
        } else {
            value.receipts.append(ReceiptRecord(transactionID: evidence.transactionID, signedEvidence: [evidence.signed]))
        }
        value.state = .transactionObserved
        value.archived = false
        // A late receipt belongs to its original attempt, even after archival.
        try persist(value)
    }
    func reconcile(_ id: UUID, transactionID: String, session: OwnerSession, transport: RecoveryTransport) async throws -> FinishPermit? {
        let value = try read(id)
        try validate(session, identity: value.identity)
        guard let receipt = value.receipts.first(where: { $0.transactionID == transactionID }),
              let signed = receipt.signedEvidence.last else { throw RecoveryError.invalid }
        guard operations.insert(id).inserted else { throw RecoveryError.busy }
        defer { operations.remove(id) }
        let result = try await transport.verify(value.identity, signed: signed, session: session)
        try validate(session, identity: value.identity)
        guard result.durablyRecorded, result.identity == value.identity,
              result.transactionID == transactionID else { throw RecoveryError.invalid }
        var latest = try read(id)
        guard let index = latest.receipts.firstIndex(where: { $0.transactionID == transactionID }) else { throw RecoveryError.invalid }
        // Revocation/review is sticky locally; never stale-positive back to winner.
        let prior = latest.receipts[index].disposition
        if prior == nil || prior == .winner || result.disposition != .winner {
            latest.receipts[index].disposition = result.disposition
        }
        latest.receipts[index].revoked = latest.receipts[index].revoked || result.revoked
        latest.receipts[index].reviewRequired = result.reviewRequired || latest.receipts[index].disposition == .excessPaymentReview || latest.receipts[index].disposition == .refundReview
        latest.receipts[index].fulfillmentGranted = result.fulfillmentGranted && !latest.receipts[index].revoked
            && latest.receipts[index].disposition == .winner && !latest.receipts[index].reviewRequired
        latest.receipts[index].finishAuthorized = result.finishAllowed && !result.reviewRequired && result.disposition == .winner
            && latest.receipts[index].disposition == .winner && latest.receipts[index].signedEvidence.last == signed
        // Record only the exact evidence generation this response reconciled.
        if latest.receipts[index].signedEvidence.last == signed {
            latest.receipts[index].reconciledEvidenceGeneration = latest.receipts[index].signedEvidence.count
        }
        try persist(latest)
        guard latest.receipts[index].finishAuthorized else { return nil }
        var permit = FinishPermit(id: UUID(), orderID: id, transactionID: transactionID,
                                  evidenceGeneration: latest.receipts[index].signedEvidence.count)
        permit.sessionGeneration = session.generation
        finishPermits = finishPermits.filter { $0.value.orderID != id || $0.value.transactionID != transactionID }
        finishPermits[permit.id] = permit
        return permit
    }
    func executeFinish(_ permit: FinishPermit, operation: (isolated RecoveryJournal) async throws -> Void) async throws {
        var value = try read(permit.orderID)
        if requireSessionFreshness {
            guard let session = activeSession, session.generation == permit.sessionGeneration else { throw RecoveryError.invalid }
            try validate(session, identity: value.identity)
        }
        guard finishPermits[permit.id] == permit,
              let index = value.receipts.firstIndex(where: { $0.transactionID == permit.transactionID }),
              value.receipts[index].signedEvidence.count == permit.evidenceGeneration,
              value.receipts[index].finishAuthorized,
              value.receipts[index].disposition == .winner,
              !value.receipts[index].finishExecutions.contains(where: { $0.evidenceGeneration == permit.evidenceGeneration || $0.state != .returned })
              else { throw RecoveryError.conflict }
        guard operations.insert(permit.orderID).inserted else { throw RecoveryError.busy }
        defer { operations.remove(permit.orderID) }
        // Atomically consume the generation-bound permit and persist execution
        // START before yielding to the external operation. A subsequent receipt
        // cannot undo an already-started external effect; it must remain queued.
        finishPermits.removeValue(forKey: permit.id)
        value.receipts[index].finishAuthorized = false
        value.receipts[index].finishExecutions.append(FinishExecution(id: permit.id,
            evidenceGeneration: permit.evidenceGeneration, state: .started))
        try persist(value) // Failure means operation is never invoked.
        do { try await operation(self) }
        catch {
            try recordFinishOutcome(permit, state: .outcomeUnknown)
            throw error
        }
        // Failure persisting completion leaves durable .started (uncertain),
        // never a replayable permission. No inference from a missing transaction.
        try recordFinishOutcome(permit, state: .returned)
    }
    private func recordFinishOutcome(_ permit: FinishPermit, state: FinishExecutionState) throws {
        var latest = try read(permit.orderID)
        guard let index = latest.receipts.firstIndex(where: { $0.transactionID == permit.transactionID }),
              let execution = latest.receipts[index].finishExecutions.firstIndex(where: { $0.id == permit.id })
              else { throw RecoveryError.invalid }
        latest.receipts[index].finishExecutions[execution].state = state
        latest.receipts[index].finishReturned = state == .returned
            && latest.receipts[index].signedEvidence.count == permit.evidenceGeneration
            && latest.receipts[index].reconciledEvidenceGeneration == permit.evidenceGeneration
        try persist(latest)
    }
    func archive(_ id: UUID) throws {
        var value = try read(id)
        guard !value.receipts.isEmpty, value.receipts.allSatisfy({ $0.disposition != nil
            && $0.reconciledEvidenceGeneration == $0.signedEvidence.count
            && !$0.finishExecutions.contains(where: { $0.state != .returned }) }) else { throw RecoveryError.conflict }
        value.archived = true
        try persist(value) // No deletion and no shared current-attempt pointer.
    }
}
enum StoreKitOutcome { case userCancelled, pending, unknown }
struct VerifiedEvidence {
    let token: UUID
    let transactionID: String
    let productID: String
    let environment: String
    let amountJpy: Int
    let signed: String
}

// Concrete receipt DTO is now specified by native-purchase-receipt.mjs. This
// decoder validates content, not transport trust: call only on a fresh response
// from the fixed authenticated original backend. Never on UI or persisted data.
private struct NativeReceiptEnvelope: Decodable { let nativeReceipt: NativeReceiptWire }
private struct NativeReceiptWire: Decodable {
    let version: Int
    let backendProjectRef: String
    let ownerId: UUID
    let intentId: UUID
    let orderId: UUID
    let transactionId: String
    let productId: String
    let environment: String
    let amountJpy: Int
    let receiptClassification: ReceiptDisposition
    let financiallyRecorded: Bool
    let revoked: Bool
    let reviewRequired: Bool
    let fulfillmentGranted: Bool
    let finishAllowed: Bool
}
extension DurableReceipt {
    static func decodeBackendResponse(_ data: Data, expected: AttemptIdentity, transactionID: String) throws -> DurableReceipt {
        try expected.validate()
        let receipt = try JSONDecoder().decode(NativeReceiptEnvelope.self, from: data).nativeReceipt
        guard receipt.version == 3, receipt.backendProjectRef == expected.backendProjectRef,
              receipt.ownerId == expected.ownerID, receipt.intentId == expected.intentID,
              receipt.orderId == expected.orderID, receipt.transactionId == transactionID,
              receipt.productId == expected.productID, receipt.environment == expected.environment,
              receipt.amountJpy == expected.amountJpy, receipt.financiallyRecorded,
              transactionID.range(of: "^[0-9]{1,40}$", options: .regularExpression) != nil else { throw RecoveryError.invalid }
        if receipt.receiptClassification != .winner || receipt.reviewRequired {
            guard !receipt.finishAllowed, !receipt.fulfillmentGranted else { throw RecoveryError.invalid }
        }
        guard !receipt.revoked || !receipt.fulfillmentGranted else { throw RecoveryError.invalid }
        return DurableReceipt(identity: expected, transactionID: transactionID,
            disposition: receipt.receiptClassification, durablyRecorded: receipt.financiallyRecorded,
            finishAllowed: receipt.finishAllowed, revoked: receipt.revoked,
            reviewRequired: receipt.reviewRequired, fulfillmentGranted: receipt.fulfillmentGranted)
    }
}

struct LaunchReply {
    let identity: AttemptIdentity
    let launchGranted: Bool
}
protocol RecoveryLaunchTransport: RecoveryTransport {
    func begin(_ identity: AttemptIdentity, session: OwnerSession) async throws -> LaunchReply
}

