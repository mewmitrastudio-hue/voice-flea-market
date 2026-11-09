import Foundation

actor ScriptHTTPClient: NativeHTTPClient {
    private var responses: [NativeHTTPResponse]
    private let gate: CheckGate?
    private(set) var requests: [URLRequest] = []
    init(_ responses: [NativeHTTPResponse], gate: CheckGate? = nil) { self.responses = responses; self.gate = gate }
    func send(_ request: URLRequest) async throws -> NativeHTTPResponse {
        requests.append(request)
        if let gate { await gate.pause() }
        guard !responses.isEmpty else { throw NativeTransportError.invalidResponse }
        return responses.removeFirst()
    }
}
struct NativeTransportChecks {
    static func response(_ body: [String: Any], status: Int = 200, route: String = "native-purchases") throws -> NativeHTTPResponse {
        NativeHTTPResponse(status: status, url: URL(string: NativeHTTPTransport.origin + "/functions/v1/" + route)!, body: try JSONSerialization.data(withJSONObject: body), contentType: "application/json; charset=utf-8")
    }
    static func attempt(_ a: AttemptIdentity, state: ServerAttemptState = .prepared) -> [String: Any] {
        ["orderId": a.orderID.uuidString, "intentId": a.intentID.uuidString, "attemptNonce": a.nonce.uuidString,
         "previousOrderId": NSNull(), "environment": a.environment, "productId": a.productID, "amountJpy": a.amountJpy, "state": state.rawValue]
    }
    static func envelope(_ a: AttemptIdentity, action: String, state: ServerAttemptState = .prepared, launch: Bool = false) -> [String: Any] {
        ["version": 3, "backendProjectRef": a.backendProjectRef, "ownerId": a.ownerID.uuidString,
         "action": action, "attempt": attempt(a, state: state), "launchGranted": launch]
    }
    static func setup(_ location: URL) async throws -> (RecoveryJournal, AttemptIdentity, OwnerSession) {
        let journal = RecoveryJournal(directory: location.appendingPathComponent("attempts"), legacyURL: location.appendingPathComponent("legacy.json"), requireSessionFreshness: true)
        let owner = UUID()
        let session = try await journal.replaceSession(ownerID: owner, environment: "Sandbox", bearer: "fixture-transient-token")
        let identity = AttemptIdentity(orderID: UUID(), nonce: UUID(), intentID: UUID(), ownerID: owner, backendProjectRef: NativeHTTPTransport.project, environment: "Sandbox", productID: "com.ayuhide.koenofurima.voice.jpy300", amountJpy: 300)
        try await journal.installPrepared(identity)
        return (journal, identity, session)
    }
    static func run(root: URL) async throws {
        // Exact requests and false/replayed begin never invoke the fake purchase.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("begin"))
            let client = ScriptHTTPClient([try response(envelope(a, action: "begin", state: .dispatchUnknown))])
            let transport = NativeHTTPTransport(journal: journal, client: client, newAdmissionAllowed: true)
            let claim = try await journal.markBeginDispatched(a.orderID)
            let reply = try await transport.begin(a, session: session)
            let calls = CheckCalls()
            try await RecoveryJournalChecks.reject { try await journal.executeLaunch(a, claim: claim, launchGranted: reply.launchGranted, session: session) { _ in await calls.hit() } }
            try await RecoveryJournalChecks.require(calls.count == 0, "No launch from replay")
            let request = await client.requests[0]
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            try RecoveryJournalChecks.require(Set(body.keys) == ["version", "action", "orderId", "attemptNonce"], "No identity/price authority injection")
            try RecoveryJournalChecks.require(request.url?.absoluteString == NativeHTTPTransport.origin + "/functions/v1/native-purchases", "Fixed original origin")
        }
        // Local admission-off blocks new requests without disabling read/report recovery.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("gates"))
            let client = ScriptHTTPClient([try response(envelope(a, action: "status"))])
            let transport = NativeHTTPTransport(journal: journal, client: client)
            try await RecoveryJournalChecks.reject { _ = try await transport.begin(a, session: session) }
            try await RecoveryJournalChecks.require(client.requests.isEmpty, "Disabled admission cannot send begin")
            _ = try await transport.status(a, session: session)
            try await RecoveryJournalChecks.require(client.requests.count == 1, "Recovery remains independent of admission gate")
        }
        // Initial preparation response loss/replay keeps the durable fresh UUID.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("initial"))
            let saved = try await journal.reserveInitial(kind: "voice_listing", subjectID: UUID(), session: session)
            let prepared = AttemptIdentity(orderID: saved.freshOrderID, nonce: UUID(), intentID: UUID(), ownerID: a.ownerID,
                backendProjectRef: a.backendProjectRef, environment: a.environment, productID: a.productID, amountJpy: a.amountJpy)
            let body = envelope(prepared, action: "prepareInitial")
            let client = ScriptHTTPClient([try response(body), try response(body)])
            let transport = NativeHTTPTransport(journal: journal, client: client, newAdmissionAllowed: true)
            _ = try await transport.prepareInitial(saved, session: session)
            _ = try await transport.prepareInitial(saved, session: session)
            let requests = await client.requests
            let ids = try requests.map { (try JSONSerialization.jsonObject(with: $0.httpBody!) as! [String: Any])["freshOrderId"] as! String }
            try RecoveryJournalChecks.require(ids.count == 2 && Set(ids).count == 1, "Preparation retry reuses saved UUID")
            try await RecoveryJournalChecks.require(journal.readInitial(saved.freshOrderID) == saved, "Response never erases durable initial operation")
        }
        // Retry transport sends only the saved fresh UUID, not a new token or action nonce.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("retry"))
            _ = try await journal.markBeginDispatched(a.orderID)
            try await journal.recordStoreKitResult(a.orderID, result: .userCancelled)
            try await journal.retryCancellationReport(a.orderID, session: session, transport: MockTransport())
            let saved = try await journal.reserveExplicitRetry(a.orderID)
            let child = AttemptIdentity(orderID: saved.freshOrderID, nonce: UUID(), intentID: a.intentID, ownerID: a.ownerID,
                backendProjectRef: a.backendProjectRef, environment: a.environment, productID: a.productID, amountJpy: a.amountJpy)
            var body = envelope(child, action: "prepareRetry")
            var childAttempt = attempt(child); childAttempt["previousOrderId"] = a.orderID.uuidString; body["attempt"] = childAttempt
            let client = ScriptHTTPClient([try response(body)])
            let transport = NativeHTTPTransport(journal: journal, client: client, newAdmissionAllowed: true)
            let result = try await transport.prepareRetry(a, request: saved, session: session)
            try RecoveryJournalChecks.require(result.orderId == saved.freshOrderID, "Retry response is bound to fresh UUID")
            let request = await client.requests[0]
            let payload = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            try RecoveryJournalChecks.require(payload["actionNonce"] == nil && payload["action"] as? String == "prepareRetry", "No extra proof/launch from retry")
        }
        // Missing/unknown fields, false ownership, redirects, HTTP errors fail closed.
        for variant in 0..<8 {
            let (journal, a, session) = try await setup(root.appendingPathComponent("invalid-\(variant)"))
            var body = envelope(a, action: "status")
            if variant == 0 { body.removeValue(forKey: "launchGranted") }
            if variant == 1 { body["launchGranted"] = "true" }
            if variant == 2 { body["ownerId"] = UUID().uuidString }
            if variant == 5 { var invalid = attempt(a); invalid["state"] = "approved"; body["attempt"] = invalid }
            var reply = try response(body, status: variant == 3 ? 503 : 200)
            if variant == 4 { reply = NativeHTTPResponse(status: 200, url: URL(string: "https://example.invalid/")!, body: reply.body, contentType: reply.contentType) }
            if variant == 6 || variant == 7 {
                reply = NativeHTTPResponse(status: 200, url: reply.url, body: reply.body, contentType: variant == 6 ? "text/html" : nil)
            }
            let transport = NativeHTTPTransport(journal: journal, client: ScriptHTTPClient([reply]))
            try await RecoveryJournalChecks.reject { _ = try await transport.status(a, session: session) }
        }
        // Real cancellation report may return observed/retired, never manufacture retry admission.
        for state in [ServerAttemptState.transactionObserved, .retired] {
            let (journal, a, session) = try await setup(root.appendingPathComponent("cancel-\(state.rawValue)"))
            _ = try await journal.markBeginDispatched(a.orderID)
            try await journal.recordStoreKitResult(a.orderID, result: .userCancelled)
            let transport = NativeHTTPTransport(journal: journal, client: ScriptHTTPClient([try response(envelope(a, action: "cancelReport", state: state))]))
            try await journal.retryCancellationReport(a.orderID, session: session, transport: transport)
            let value = try await journal.read(a.orderID)
            try RecoveryJournalChecks.require(value.serverState == state && !value.cancellationReportPending, "Persist actual server cancellation-report state")
            try await RecoveryJournalChecks.reject { _ = try await journal.reserveExplicitRetry(a.orderID) }
        }
        // Logout/refresh during HTTP cannot apply or return the stale response.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("session-race"))
            let gate = CheckGate()
            let transport = NativeHTTPTransport(journal: journal, client: ScriptHTTPClient([try response(envelope(a, action: "status"))], gate: gate))
            let pending = Task { try await transport.status(a, session: session) }
            await gate.waitForEntry()
            _ = try await journal.replaceSession(ownerID: a.ownerID, environment: "Sandbox", bearer: "refreshed-token")
            await gate.release()
            try await RecoveryJournalChecks.reject { _ = try await pending.value }
            try await RecoveryJournalChecks.require(journal.read(a.orderID).serverState == nil, "Stale reply cannot mutate state")
        }
        // Session-generation invalidation also holds at launch/finish execution boundaries.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("session-boundary"))
            let claim = try await journal.markBeginDispatched(a.orderID)
            await journal.clearSession(sequence: 10)
            try await RecoveryJournalChecks.reject { _ = try await journal.replaceSession(ownerID: a.ownerID, environment: "Sandbox", bearer: "old-auth-event", sequence: 2) }
            let calls = CheckCalls()
            try await RecoveryJournalChecks.reject { try await journal.executeLaunch(a, claim: claim, launchGranted: true, session: session) { _ in await calls.hit() } }
            let fresh = try await journal.replaceSession(ownerID: a.ownerID, environment: "Sandbox", bearer: "new-auth", sequence: 11)
            try await journal.retainVerified(InterleavingChecks.proof(a, "v1"))
            let permit = try await journal.reconcile(a.orderID, transactionID: "100", session: fresh, transport: MockTransport())!
            await journal.clearSession(sequence: 12)
            try await RecoveryJournalChecks.reject { try await journal.executeFinish(permit) { _ in await calls.hit() } }
            try await RecoveryJournalChecks.require(calls.count == 0, "Stale session has no execution authority")
        }
        // Missing later page and repeated cursors are unknown, never partial success.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("paging"))
            let page: [String: Any] = ["version": 3, "backendProjectRef": a.backendProjectRef, "ownerId": a.ownerID.uuidString,
                "attempts": [attempt(a)], "nextCursor": ["createdAt": "2026-11-09T00:00:00Z", "orderId": a.orderID.uuidString], "launchGranted": false]
            let transport = NativeHTTPTransport(journal: journal, client: ScriptHTTPClient([try response(page)]))
            try await RecoveryJournalChecks.reject { _ = try await transport.listAll(session: session) }
            try await RecoveryJournalChecks.require(journal.all().count == 1, "Incomplete listing never erases local attempts")
        }
        // 409 without normalized receipt keeps proof and never permits finish.
        do {
            let (journal, a, session) = try await setup(root.appendingPathComponent("review"))
            let proof = InterleavingChecks.proof(a, "review")
            try await journal.retainVerified(proof)
            let transport = NativeHTTPTransport(journal: journal, client: ScriptHTTPClient([try response(["code": "apple_refund_review_required"], status: 409, route: "voice-iap")]))
            try await RecoveryJournalChecks.reject { _ = try await journal.reconcile(a.orderID, transactionID: "100", session: session, transport: transport) }
            let receipt = try await journal.read(a.orderID).receipts[0]
            try RecoveryJournalChecks.require(receipt.signedEvidence == [proof.signed] && !receipt.finishAuthorized, "Review hold retains signed proof")
        }
        print("Native HTTP/session mock checks passed; no real HTTP or StoreKit call was made.")
    }
}
