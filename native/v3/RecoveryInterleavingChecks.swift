import Foundation

// Deterministic, executable Swift tests, not StoreKit or signature verification.
actor CheckGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var entered = false
    func pause() async {
        entered = true
        await withCheckedContinuation { continuation = $0 }
    }
    func waitForEntry() async { while !entered { await Task.yield() } }
    func release() { continuation?.resume(); continuation = nil }
}
actor CheckCalls {
    private(set) var count = 0
    func hit() { count += 1 }
}
actor GatedReceiptTransport: RecoveryTransport {
    let gate: CheckGate
    init(_ gate: CheckGate) { self.gate = gate }
    func reportCancellation(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState { return .clientReportedCancelled }
    func verify(_ identity: AttemptIdentity, signed: String, session: OwnerSession) async throws -> DurableReceipt {
        await gate.pause()
        return DurableReceipt(identity: identity, transactionID: "100", disposition: .winner,
            durablyRecorded: true, finishAllowed: true, revoked: false, reviewRequired: false, fulfillmentGranted: true)
    }
}
struct InterleavingChecks {
    static func check(_ value: Bool, _ message: String) throws { try RecoveryJournalChecks.require(value, message) }
    static func reject(_ action: () async throws -> Void) async throws { try await RecoveryJournalChecks.reject(action) }
    static func setup(_ root: URL) async throws -> (RecoveryJournal, AttemptIdentity, OwnerSession) {
        let identity = AttemptIdentity(orderID: UUID(), nonce: UUID(), intentID: UUID(), ownerID: UUID(),
            backendProjectRef: "tyulybijubckitybgubc", environment: "Sandbox",
            productID: "com.ayuhide.koenofurima.voice.jpy300", amountJpy: 300)
        let journal = RecoveryJournal(directory: root.appendingPathComponent("attempts"), legacyURL: root.appendingPathComponent("legacy.json"), requireSessionFreshness: false)
        try await journal.installPrepared(identity)
        return (journal, identity, OwnerSession(ownerID: identity.ownerID, backendProjectRef: identity.backendProjectRef, environment: identity.environment, bearer: "transient"))
    }
    static func proof(_ identity: AttemptIdentity, _ version: String) -> VerifiedEvidence {
        VerifiedEvidence(token: identity.orderID, transactionID: "100", productID: identity.productID,
            environment: identity.environment, amountJpy: identity.amountJpy, signed: "100:" + version)
    }
    static func run(root: URL) async throws {
        // 1. Verification returned, but its proof changed BEFORE execution boundary.
        do {
            let location = root.appendingPathComponent("stale-finish")
            let (journal, a, session) = try await setup(location)
            try await journal.retainVerified(proof(a, "v1"))
            let permit = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: MockTransport())!
            let calls = CheckCalls()
            let reopened = RecoveryJournal(directory: location.appendingPathComponent("attempts"), legacyURL: location.appendingPathComponent("legacy.json"), requireSessionFreshness: false)
            try await reject { try await reopened.executeFinish(permit) { _ in await calls.hit() } }
            try await journal.retainVerified(proof(a, "v2"))
            try await reject { try await journal.executeFinish(permit) { _ in await calls.hit() } }
            try await check(calls.count == 0, "Stale permit must not invoke finish")
            let record = try await journal.read(a.orderID)
            try check(record.receipts[0].signedEvidence.count == 2 && !record.receipts[0].finishReturned, "Keep new proof unresolved")
        }
        // 2. Evidence arrives DURING suspended server verification.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("verify-await"))
            try await journal.retainVerified(proof(a, "v1"))
            let gate = CheckGate()
            let controlled = GatedReceiptTransport(gate)
            let pending = Task { try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: controlled) }
            await gate.waitForEntry()
            try await journal.retainVerified(proof(a, "v2"))
            await gate.release()
            let result = try await pending.value
            try check(result == nil, "Proof changed while verify suspended")
        }
        // 3. Evidence AFTER durable execution start belongs to a new generation.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("finish-await"))
            try await journal.retainVerified(proof(a, "v1"))
            let permit = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: MockTransport())!
            let gate = CheckGate(), calls = CheckCalls()
            let finishing = Task { try await journal.executeFinish(permit) { _ in await calls.hit(); await gate.pause() } }
            await gate.waitForEntry()
            try await journal.retainVerified(proof(a, "v2"))
            try await reject { try await journal.executeFinish(permit) { _ in await calls.hit() } }
            try await reject { _ = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: MockTransport()) }
            await gate.release()
            try await finishing.value
            let record = try await journal.read(a.orderID)
            try await check(calls.count == 1, "Only one execution")
            try check(record.receipts[0].finishExecutions[0].state == .returned, "Record old generation completion")
            try check(!record.receipts[0].finishReturned && !record.archived, "Never attribute old finish to new proof")
            try await reject { try await journal.archive(a.orderID) }
        }
        // 4. Receipt before begin response suppresses launch; replay/restart fail.
        do {
            let location = root.appendingPathComponent("begin-await")
            let (journal, a, _) = try await setup(location)
            let claim = try await journal.markBeginDispatched(a.orderID)
            let gate = CheckGate(), calls = CheckCalls()
            let launching = Task {
                await gate.pause() // begin network response is suspended here
                try await journal.executeLaunch(a, claim: claim, launchGranted: true) { _ in await calls.hit() }
            }
            await gate.waitForEntry()
            try await journal.retainVerified(proof(a, "v1"))
            await gate.release()
            try await reject { try await launching.value }
            try await reject { try await journal.executeLaunch(a, claim: claim, launchGranted: true) { _ in await calls.hit() } }
            let reopened = RecoveryJournal(directory: location.appendingPathComponent("attempts"), legacyURL: location.appendingPathComponent("legacy.json"), requireSessionFreshness: false)
            try await reject { try await reopened.executeLaunch(a, claim: claim, launchGranted: true) { _ in await calls.hit() } }
            try await check(calls.count == 0, "Observed receipt prevents launch and replay")
        }
        // 5. Late predecessor receipt suppresses fresh B of the same intent.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("intent-race"))
            _ = try await journal.markBeginDispatched(a.orderID)
            try await journal.recordStoreKitResult(a.orderID, result: .userCancelled)
            try await journal.retryCancellationReport(a.orderID, session: session, transport: MockTransport())
            let request = try await journal.reserveExplicitRetry(a.orderID)
            let b = AttemptIdentity(orderID: request.freshOrderID, nonce: UUID(), intentID: a.intentID,
                ownerID: a.ownerID, backendProjectRef: a.backendProjectRef, environment: a.environment,
                productID: a.productID, amountJpy: a.amountJpy)
            try await journal.installPrepared(b, retryOf: a.orderID)
            let claim = try await journal.markBeginDispatched(b.orderID)
            try await journal.retainVerified(proof(a, "late"))
            let calls = CheckCalls()
            try await reject { try await journal.executeLaunch(b, claim: claim, launchGranted: true) { _ in await calls.hit() } }
            try await check(calls.count == 0, "Same-intent receipt suppresses new launch")
            try await check(journal.read(b.orderID).receipts.isEmpty, "Never misroute A proof into B")
        }
        // 6. Start reservation persists before callback; later evidence is retained.
        do {
            let location = root.appendingPathComponent("launch-started")
            let (journal, a, _) = try await setup(location)
            let claim = try await journal.markBeginDispatched(a.orderID)
            let gate = CheckGate(), calls = CheckCalls()
            let launching = Task { try await journal.executeLaunch(a, claim: claim, launchGranted: true) { _ in await calls.hit(); await gate.pause() } }
            await gate.waitForEntry()
            try await check(journal.read(a.orderID).launchExecutionID == claim, "Start is durable before callback")
            try await journal.retainVerified(proof(a, "after-start"))
            await gate.release()
            try await launching.value
            try await reject { try await journal.executeLaunch(a, claim: claim, launchGranted: true) { _ in await calls.hit() } }
            try await check(calls.count == 1, "No launch replay after start")
            let lostLocation = root.appendingPathComponent("lost-begin-response")
            let (lost, pending, _) = try await setup(lostLocation)
            let lostClaim = try await lost.markBeginDispatched(pending.orderID)
            let restarted = RecoveryJournal(directory: lostLocation.appendingPathComponent("attempts"), legacyURL: lostLocation.appendingPathComponent("legacy.json"), requireSessionFreshness: false)
            try await reject { try await restarted.executeLaunch(pending, claim: lostClaim, launchGranted: true) { _ in await calls.hit() } }
            try await check(calls.count == 1, "Restart rejects saved begin grant even without any receipt")
        }
        // 7. Deterministic write failure at start and after external completion.
        do {
            let location = root.appendingPathComponent("disk-failure")
            let writer = FailingCheckWriter()
            let a = AttemptIdentity(orderID: UUID(), nonce: UUID(), intentID: UUID(), ownerID: UUID(),
                backendProjectRef: "tyulybijubckitybgubc", environment: "Sandbox",
                productID: "com.ayuhide.koenofurima.voice.jpy300", amountJpy: 300)
            let journal = RecoveryJournal(directory: location.appendingPathComponent("attempts"),
                legacyURL: location.appendingPathComponent("legacy.json"), requireSessionFreshness: false, writer: writer.write)
            let session = OwnerSession(ownerID: a.ownerID, backendProjectRef: a.backendProjectRef, environment: a.environment, bearer: "memory-only")
            try await journal.installPrepared(a)
            let claim = try await journal.markBeginDispatched(a.orderID)
            let calls = CheckCalls()
            writer.failWrites(true)
            try await reject { try await journal.executeLaunch(a, claim: claim, launchGranted: true) { _ in await calls.hit() } }
            try await check(calls.count == 0, "Failed durable launch marker cannot invoke operation")
            writer.failWrites(false)
            try await journal.retainVerified(proof(a, "v1"))
            let permit = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: MockTransport())!
            writer.failWrites(true)
            try await reject { try await journal.executeFinish(permit) { _ in await calls.hit() } }
            try await check(calls.count == 0, "Failed durable finish marker cannot invoke operation")
            writer.failWrites(false)
            let next = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: MockTransport())!
            try await reject {
                try await journal.executeFinish(next) { _ in
                    await calls.hit()
                    writer.failWrites(true) // external operation returned; completion persistence fails
                }
            }
            writer.failWrites(false)
            let record = try await journal.read(a.orderID)
            try check(record.receipts[0].finishExecutions.last?.state == .started && !record.receipts[0].finishReturned,
                      "Failed completion write preserves uncertain started marker")
            try await reject { try await journal.executeFinish(next) { _ in await calls.hit() } }
            try await check(calls.count == 1, "Uncertain completion cannot replay its permit")
        }
        print("Seven deterministic native interleaving groups passed; no StoreKit/device verification implied.")
    }
}

final class FailingCheckWriter {
    private let lock = NSLock()
    private var fail = false
    func failWrites(_ value: Bool) { lock.lock(); fail = value; lock.unlock() }
    func write(_ data: Data, _ url: URL) throws {
        lock.lock(); let shouldFail = fail; lock.unlock()
        if shouldFail { throw NSError(domain: "Injected persistence failure", code: 1) }
        try data.write(to: url, options: .atomic)
    }
}
