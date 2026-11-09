import Foundation
import StoreKit

// No bearer is persisted. Every auth event, including token refresh and logout,
// must be forwarded by the future authenticated host integration. The current
// Web UI does not call this bridge; compile hooks and feature gates remain off.
@available(iOS 15.0, *)
@MainActor
final class NativeRecoveryHost {
    static let shared = NativeRecoveryHost()
    private var journal: RecoveryJournal?
    private var store: StoreKitRecovery?
    private var transport: NativeHTTPTransport?
    private var coordinator: NativePurchaseCoordinator?
    private var session: OwnerSession?
    private var authSequence: UInt64 = 0
    private(set) var failedClosed = false
    func startAtApplicationLaunch() {
        guard RecoveryIntegration.hostEnabled, journal == nil else { return }
        do {
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let journal = RecoveryJournal(directory: root.appendingPathComponent("koe-native-v3-attempts"),
                legacyURL: root.appendingPathComponent("koe-purchase-attempt.json"), requireSessionFreshness: true)
            self.journal = journal
            let transport = NativeHTTPTransport(journal: journal, client: NativeURLSessionClient())
            self.transport = transport
            coordinator = NativePurchaseCoordinator(journal: journal, transport: transport, catalog: StoreKitProductCatalog())
            let store = StoreKitRecovery(journal: journal)
            self.store = store
            store.startAtApplicationLaunch() // Local evidence only; no implicit authentication/network.
        } catch { failedClosed = true }
    }
    private func nativeEnvironment() async throws -> String {
        if #available(iOS 16.0, *) {
            let result = try await AppTransaction.shared
            guard case .verified(let transaction) = result, transaction.bundleID == Bundle.main.bundleIdentifier else { throw RecoveryError.invalid }
            if transaction.environment == .sandbox { return "Sandbox" }
            if transaction.environment == .production { return "Production" }
            throw RecoveryError.invalid
        }
        switch Bundle.main.appStoreReceiptURL?.lastPathComponent {
        case "sandboxReceipt": return "Sandbox"
        case "receipt": return "Production"
        default: throw RecoveryError.invalid
        }
    }
    func sessionChanged(owner: UUID, environment: String?, bearer: String) async throws -> String {
        guard RecoveryIntegration.hostEnabled, let journal else { throw RecoveryError.disabled }
        authSequence += 1
        let sequence = authSequence
        session = nil // Hide old owner immediately, before crossing to the journal actor.
        await journal.clearSession(sequence: sequence * 2)
        await coordinator?.invalidateQuotes()
        let verifiedEnvironment = try await nativeEnvironment()
        guard sequence == authSequence, environment == nil || environment == verifiedEnvironment else { throw RecoveryError.invalid }
        let candidate = try await journal.replaceSession(ownerID: owner, environment: verifiedEnvironment, bearer: bearer, sequence: sequence * 2 + 1)
        guard sequence == authSequence else { throw RecoveryError.conflict }
        session = candidate
        return verifiedEnvironment
    }
    func logout() async {
        authSequence += 1; let sequence = authSequence
        session = nil
        await journal?.clearSession(sequence: sequence * 2)
        await coordinator?.invalidateQuotes()
    }
    func recover() async throws -> [NativeOutcomeView] {
        guard RecoveryIntegration.hostEnabled, RecoveryIntegration.recoveryEnabled,
              let session, let journal, let store, let transport, let coordinator else { throw RecoveryError.disabled }
        let sequence = authSequence
        try await journal.checkSession(session)
        guard try await journal.legacyBytes() == nil else { throw RecoveryError.legacyHold }
        let remote = try await transport.listAll(session: session)
        let known = try await journal.all()
        for item in remote {
            let identity = try item.identity(owner: session.ownerID)
            guard identity.environment == session.environment,
                  known.contains(where: { $0.identity == identity }) else { throw RecoveryError.conflict }
            try await journal.applyServerState(identity, state: item.state, session: session)
        }
        let records = try await journal.all()
        var unresolved = false
        for record in records where record.identity.ownerID == session.ownerID && record.identity.environment == session.environment {
            guard sequence == authSequence else { throw RecoveryError.conflict }
            do {
                if record.cancellationWasObserved && record.cancellationReportPending {
                    try await journal.retryCancellationReport(record.identity.orderID, session: session, transport: transport)
                } else if record.state == .pendingApproval {
                    try await transport.reportPending(record.identity, session: session)
                }
            } catch {
                try await journal.checkSession(session)
                unresolved = true // Continue independent records; never clear the failed one.
            }
        }
        for await result in Transaction.unfinished {
            guard sequence == authSequence else { throw RecoveryError.conflict }
            if case .verified(let transaction) = result, let token = transaction.appAccountToken,
               let original = try? await journal.read(token), original.identity.ownerID != session.ownerID {
                continue // Known other owner's proof is preserved, never finished or exposed here.
            }
            do { try await store.reconcileAndFinish(result, session: session, transport: transport) }
            catch {
                try await journal.checkSession(session)
                unresolved = true // Foreign/unknown first item must not starve later owned receipts.
            }
        }
        try await journal.checkSession(session)
        guard sequence == authSequence, !unresolved else { throw RecoveryError.conflict }
        let outcomes = try await coordinator.summaries(session: session)
        guard sequence == authSequence else { throw RecoveryError.conflict }
        return outcomes // Complete metadata only; no partial/empty fallback.
    }
    var mode: [String: Any] { ["protocol": 3, "newAdmissionEnabled": RecoveryIntegration.newAdmissionEnabled,
                               "recoveryEnabled": RecoveryIntegration.recoveryEnabled] }
    func prepare(kind: String, subjectID: UUID, boostPlan: String?) async throws -> NativeQuoteView {
        guard RecoveryIntegration.hostEnabled, RecoveryIntegration.newAdmissionEnabled,
              session != nil, let coordinator else { throw RecoveryError.disabled }
        let sequence = authSequence
        let quote = try await coordinator.prepare(kind: kind, subjectID: subjectID, boostPlan: boostPlan)
        guard sequence == authSequence else { throw RecoveryError.conflict }
        return quote
    }
    func prepareRetry(previousOrderID: UUID) async throws -> NativeQuoteView {
        guard RecoveryIntegration.hostEnabled, RecoveryIntegration.newAdmissionEnabled,
              session != nil, let coordinator else { throw RecoveryError.disabled }
        let sequence = authSequence
        let quote = try await coordinator.prepareRetry(previousOrderID: previousOrderID)
        guard sequence == authSequence else { throw RecoveryError.conflict }
        return quote
    }
    func purchase(quoteID: UUID) async throws -> NativeOutcomeView {
        guard RecoveryIntegration.hostEnabled, RecoveryIntegration.newAdmissionEnabled,
              session != nil, let coordinator else { throw RecoveryError.disabled }
        let sequence = authSequence
        let result = try await coordinator.purchase(quoteID: quoteID)
        guard sequence == authSequence else { throw RecoveryError.conflict }
        return result
    }
}
