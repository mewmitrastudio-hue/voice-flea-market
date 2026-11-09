import Foundation

struct NativeHTTPResponse { let status: Int; let url: URL; let body: Data; let contentType: String? }
protocol NativeHTTPClient { func send(_ request: URLRequest) async throws -> NativeHTTPResponse }
final class NativeNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@available(iOS 15.0, macOS 12.0, *)
struct NativeURLSessionClient: NativeHTTPClient {
    func send(_ request: URLRequest) async throws -> NativeHTTPResponse {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: NativeNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, let url = http.url else { throw RecoveryError.invalid }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 262144 else { throw RecoveryError.invalid }
            data.append(byte)
        }
        return NativeHTTPResponse(status: http.statusCode, url: url, body: data, contentType: http.value(forHTTPHeaderField: "Content-Type"))
    }
}
struct AdmissionAttempt: Decodable {
    let orderId: UUID; let intentId: UUID; let attemptNonce: UUID; let previousOrderId: UUID?
    let environment: String; let productId: String; let amountJpy: Int; let state: ServerAttemptState
    func identity(owner: UUID) throws -> AttemptIdentity {
        let identity = AttemptIdentity(orderID: orderId, nonce: attemptNonce, intentID: intentId, ownerID: owner,
            backendProjectRef: NativeHTTPTransport.project, environment: environment, productID: productId, amountJpy: amountJpy)
        try identity.validate(); return identity
    }
}
struct AdmissionReply: Decodable {
    let version: Int; let backendProjectRef: String; let ownerId: UUID; let action: String
    let attempt: AdmissionAttempt; let launchGranted: Bool
}
struct AttemptCursor: Codable, Equatable {
    let createdAt: String; let orderId: UUID
    func validate() throws {
        guard createdAt.range(of: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d{1,6})?(?:Z|\\+00:00)$", options: .regularExpression) != nil else { throw RecoveryError.invalid }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: createdAt) == nil {
            formatter.formatOptions = [.withInternetDateTime]
            guard formatter.date(from: createdAt) != nil else { throw RecoveryError.invalid }
        }
    }
}
struct AttemptPage: Decodable {
    let version: Int; let backendProjectRef: String; let ownerId: UUID
    let attempts: [AdmissionAttempt]; let nextCursor: AttemptCursor?; let launchGranted: Bool
}
// HTTP failures carry no response body/JWS/token into user-visible errors.
enum NativeTransportError: Error { case rejected(Int), invalidResponse }
struct NativeHTTPTransport: RecoveryLaunchTransport {
    static let project = "tyulybijubckitybgubc"
    static let origin = "https://tyulybijubckitybgubc.supabase.co"
    let journal: RecoveryJournal
    let client: NativeHTTPClient
    private let newAdmissionAllowed: Bool
    init(journal: RecoveryJournal, client: NativeHTTPClient, newAdmissionAllowed: Bool = RecoveryIntegration.newAdmissionEnabled) {
        self.journal = journal; self.client = client; self.newAdmissionAllowed = newAdmissionAllowed
    }
    // Test injection does not change the fixed origin or response validation.
    private func request(_ route: String, body: [String: Any], session: OwnerSession) async throws -> NativeHTTPResponse {
        try await journal.checkSession(session)
        guard session.backendProjectRef == Self.project,
              ["native-purchases", "voice-iap", "boost-iap"].contains(route) else { throw RecoveryError.invalid }
        let url = URL(string: Self.origin + "/functions/v1/" + route)!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("Bearer " + session.bearer, forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        guard request.httpBody!.count <= (route == "native-purchases" ? 8192 : 40000) else { throw RecoveryError.invalid }
        let response = try await client.send(request)
        // In-flight requests cannot be unsent on logout. Reject all stale replies,
        // before state mutation, permission return, or owner-specific presentation.
        try await journal.checkSession(session)
        guard response.url == url, response.body.count <= 262144,
              response.contentType?.range(of: "^application/json(?:\\s*;\\s*charset\\s*=\\s*(?:utf-8|\"utf-8\"))?\\s*$", options: [.regularExpression, .caseInsensitive]) != nil else { throw NativeTransportError.invalidResponse }
        return response
    }
    private func keys(_ object: Any?, _ expected: Set<String>) throws -> [String: Any] {
        guard let object = object as? [String: Any], Set(object.keys) == expected else { throw NativeTransportError.invalidResponse }
        return object
    }
    private func checkAttemptShape(_ value: Any?) throws {
        _ = try keys(value, ["orderId", "intentId", "attemptNonce", "previousOrderId", "environment", "productId", "amountJpy", "state"])
    }
    private func decode(_ data: Data, action: String, session: OwnerSession,
                        expected: AttemptIdentity? = nil, freshOrder: UUID? = nil, predecessor: UUID? = nil) throws -> AdmissionReply {
        let raw = try keys(JSONSerialization.jsonObject(with: data), ["version", "backendProjectRef", "ownerId", "action", "attempt", "launchGranted"])
        try checkAttemptShape(raw["attempt"])
        let value = try JSONDecoder().decode(AdmissionReply.self, from: data)
        let identity = try value.attempt.identity(owner: value.ownerId)
        guard value.version == 3, value.backendProjectRef == Self.project, value.ownerId == session.ownerID,
              value.action == action, identity.environment == session.environment,
              !value.launchGranted || (action == "begin" && value.attempt.state == .dispatchUnknown) else { throw NativeTransportError.invalidResponse }
        if let freshOrder {
            guard identity.orderID == freshOrder, value.attempt.previousOrderId == predecessor else { throw NativeTransportError.invalidResponse }
            if let expected {
                guard identity.orderID != expected.orderID, identity.nonce != expected.nonce,
                      identity.intentID == expected.intentID, identity.ownerID == expected.ownerID,
                      identity.productID == expected.productID, identity.amountJpy == expected.amountJpy,
                      identity.environment == expected.environment else { throw NativeTransportError.invalidResponse }
            }
        } else if let expected {
            guard identity == expected else { throw NativeTransportError.invalidResponse }
        }
        return value
    }
    private func action(_ action: String, identity: AttemptIdentity, session: OwnerSession,
                        freshOrder: UUID? = nil) async throws -> AdmissionReply {
        if ["begin", "prepareRetry"].contains(action) {
            guard newAdmissionAllowed else { throw RecoveryError.disabled }
        }
        try identity.validate()
        guard identity.ownerID == session.ownerID, identity.backendProjectRef == session.backendProjectRef,
              identity.environment == session.environment else { throw RecoveryError.invalid }
        var body: [String: Any] = ["version": 3, "action": action, "orderId": identity.orderID.uuidString.lowercased(), "attemptNonce": identity.nonce.uuidString.lowercased()]
        if let freshOrder { body["freshOrderId"] = freshOrder.uuidString.lowercased() }
        let response = try await request("native-purchases", body: body, session: session)
        guard response.status == 200 else { throw NativeTransportError.rejected(response.status) }
        let result = try decode(response.body, action: action, session: session, expected: identity,
                          freshOrder: freshOrder, predecessor: freshOrder == nil ? nil : identity.orderID)
        if freshOrder == nil {
            let saved = try await journal.read(identity.orderID)
            try await journal.checkSession(session)
            guard saved.identity == identity, result.attempt.previousOrderId == saved.predecessorID else { throw RecoveryError.invalid }
        }
        return result
    }
    func prepareInitial(_ saved: InitialPreparation, session: OwnerSession) async throws -> AdmissionAttempt {
        guard newAdmissionAllowed else { throw RecoveryError.disabled }
        try await journal.checkSession(session)
        guard try await journal.readInitial(saved.freshOrderID) == saved, saved.ownerID == session.ownerID,
              saved.environment == session.environment else { throw RecoveryError.invalid }
        var body: [String: Any] = ["version": 3, "action": "prepareInitial", "kind": saved.kind,
            "subjectId": saved.subjectID.uuidString.lowercased(), "freshOrderId": saved.freshOrderID.uuidString.lowercased(),
            "storeKitEnvironment": saved.environment]
        if let plan = saved.boostPlan { body["boostPlan"] = plan }
        let response = try await request("native-purchases", body: body, session: session)
        guard response.status == 200 else { throw NativeTransportError.rejected(response.status) }
        let result = try decode(response.body, action: "prepareInitial", session: session, freshOrder: saved.freshOrderID)
        guard !result.launchGranted, result.attempt.state == .prepared,
              saved.kind == "boost" ? result.attempt.productId == "com.ayuhide.koenofurima.boost." + (saved.boostPlan ?? "") : result.attempt.productId.contains(".voice.") else { throw RecoveryError.invalid }
        return result.attempt // Still a quote, never a StoreKit launch permit.
    }
    func begin(_ identity: AttemptIdentity, session: OwnerSession) async throws -> LaunchReply {
        let reply = try await action("begin", identity: identity, session: session)
        try await journal.applyServerState(identity, state: reply.attempt.state, session: session)
        return LaunchReply(identity: identity, launchGranted: reply.launchGranted)
    }
    func reportCancellation(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState {
        let reply = try await action("cancelReport", identity: identity, session: session)
        return reply.attempt.state // The journal persists actual state, never inferred cancellation.
    }
    func status(_ identity: AttemptIdentity, session: OwnerSession) async throws -> ServerAttemptState {
        let reply = try await action("status", identity: identity, session: session)
        try await journal.applyServerState(identity, state: reply.attempt.state, session: session)
        return reply.attempt.state
    }
    func reportPending(_ identity: AttemptIdentity, session: OwnerSession) async throws {
        let reply = try await action("pendingReport", identity: identity, session: session)
        try await journal.applyServerState(identity, state: reply.attempt.state, session: session)
    }
    func prepareRetry(_ predecessor: AttemptIdentity, request saved: RetryRequest, session: OwnerSession) async throws -> AdmissionAttempt {
        let original = try await journal.read(predecessor.orderID)
        try await journal.checkSession(session)
        guard original.identity == predecessor, original.retryRequest == saved,
              original.cancellationWasObserved, original.serverState == .clientReportedCancelled else { throw RecoveryError.invalid }
        let reply = try await action("prepareRetry", identity: predecessor, session: session, freshOrder: saved.freshOrderID)
        guard !reply.launchGranted, reply.attempt.state == .prepared else { throw NativeTransportError.invalidResponse }
        return reply.attempt // Caller installs only after checking current session again.
    }
    func verify(_ identity: AttemptIdentity, signed: String, session: OwnerSession) async throws -> DurableReceipt {
        try await journal.checkSession(session)
        let attempt = try await journal.read(identity.orderID)
        guard attempt.identity == identity, identity.ownerID == session.ownerID,
              identity.environment == session.environment,
              let receipt = attempt.receipts.first(where: { $0.signedEvidence.contains(signed) }) else { throw RecoveryError.invalid }
        let route = identity.productID.contains(".voice.") ? "voice-iap" : "boost-iap"
        let response = try await request(route, body: ["action": "verify", "signedTransaction": signed, "nativeProtocol": 3], session: session)
        guard response.status == 200 || response.status == 409 else { throw NativeTransportError.rejected(response.status) }
        let result = try DurableReceipt.decodeBackendResponse(response.body, expected: identity, transactionID: receipt.transactionID)
        if response.status == 409 {
            guard result.disposition != .winner, !result.finishAllowed, !result.fulfillmentGranted else { throw NativeTransportError.invalidResponse }
        }
        return result // 409 without DTO throws, leaving saved proof untouched.
    }
    func listAll(session: OwnerSession) async throws -> [AdmissionAttempt] {
        var cursor: AttemptCursor? = nil, seenCursors: [AttemptCursor] = [], results: [AdmissionAttempt] = []
        var seenOrders = Set<UUID>()
        for _ in 0..<100 {
            var body: [String: Any] = ["version": 3, "action": "listAttempts", "pageSize": 25]
            if let cursor { body["cursor"] = ["createdAt": cursor.createdAt, "orderId": cursor.orderId.uuidString.lowercased()] }
            let response = try await request("native-purchases", body: body, session: session)
            guard response.status == 200 else { throw NativeTransportError.rejected(response.status) }
            let raw = try keys(JSONSerialization.jsonObject(with: response.body), ["version", "backendProjectRef", "ownerId", "attempts", "nextCursor", "launchGranted"])
            guard let rows = raw["attempts"] as? [Any] else { throw NativeTransportError.invalidResponse }
            for row in rows { try checkAttemptShape(row) }
            if !(raw["nextCursor"] is NSNull) { _ = try keys(raw["nextCursor"], ["createdAt", "orderId"]) }
            let page = try JSONDecoder().decode(AttemptPage.self, from: response.body)
            guard page.version == 3, page.backendProjectRef == Self.project, page.ownerId == session.ownerID,
                  !page.launchGranted, page.attempts.count <= 25 else { throw NativeTransportError.invalidResponse }
            for attempt in page.attempts {
                _ = try attempt.identity(owner: page.ownerId)
                guard seenOrders.insert(attempt.orderId).inserted else { throw NativeTransportError.invalidResponse }
                results.append(attempt)
            }
            guard let next = page.nextCursor else { try await journal.checkSession(session); return results }
            try next.validate()
            guard !seenCursors.contains(next), !page.attempts.isEmpty else { throw NativeTransportError.invalidResponse }
            seenCursors.append(next); cursor = next
        }
        throw NativeTransportError.invalidResponse // Incomplete listing is never empty/success.
    }
}
