// Source-contract checks only. These do NOT compile or execute Swift/StoreKit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const core = fs.readFileSync(new URL('../native/v3/RecoveryJournal.swift', import.meta.url), 'utf8');
const sk = fs.readFileSync(new URL('../native/v3/StoreKitRecovery.swift', import.meta.url), 'utf8');
test('v3 is isolated and hard gated off', () => {
 assert.match(core, /newAdmissionEnabled = false/);
 const app = fs.readFileSync(new URL('../ios/App/App/AppDelegate.swift', import.meta.url), 'utf8');
 assert.doesNotMatch(app, /StoreKitRecovery/);
 assert.match(sk, /guard RecoveryIntegration.newAdmissionEnabled else/);
});
test('per-token actor persistence verifies writes without deletion', () => {
 assert.match(core, /actor RecoveryJournal/); assert.match(core, /id.uuidString.lowercased\(\) \+ ".json"/);
 assert.match(core, /options: .atomic/); assert.match(core, /read\(value.identity.orderID\) == value/);
 assert.doesNotMatch(core, /removeItem|UserDefaults/);
});
test('legacy bytes are retained and block unsafe adoption', () => {
 assert.match(core, /func legacyBytes\(\) throws -> Data\?/);
 assert.match(core, /legacyBytes\(\) == nil else \{ throw RecoveryError.legacyHold/);
});
test('immutable provenance includes original backend owner amount and intent', () => {
 for (const name of ['orderID','nonce','intentID','ownerID','backendProjectRef','environment','productID','amountJpy']) assert.match(core, new RegExp(`let ${name}:`));
 assert.match(core, /backendProjectRef == "tyulybijubckitybgubc"/);
});
test('credentials are outside Codable records', () => {
 const persisted = core.slice(0,core.indexOf('struct OwnerSession'));
 assert.doesNotMatch(persisted, /let bearer:|var bearer:|accessToken:/);
 assert.match(core,/struct OwnerSession \{/);
});
test('cancellation report retry has no purchase or begin call', () => {
 const report = core.slice(core.indexOf('func retryCancellationReport'), core.indexOf('// Input must'));
 assert.match(report, /cancellationWasObserved, value.cancellationReportPending/);
 assert.match(report, /transport.reportCancellation/); assert.doesNotMatch(report, /\.purchase\(|\.begin\(/);
 assert.match(report, /var latest = try read\(id\)/);
});
test('unknown and pending never become cancellation', () => {
 assert.match(core, /case .pending:\s+if value.state != .transactionObserved \{ value.state = .pendingApproval \}/);
 assert.match(core, /case .unknown: break/);
 assert.match(sk, /case .userCancelled: try await journal.recordStoreKitResult/);
});
test('explicit retry is durable fresh token with replay reuse and single child', () => {
 assert.match(core,/RetryRequest\(freshOrderID: UUID\(\), actionNonce: UUID\(\)\)/);
 assert.match(core,/if let pending = old.retryRequest \{/);
 assert.match(core,/return pending/);
 assert.match(core,/old.retryRequest\?\.freshOrderID == identity.orderID/);
 assert.match(core,/\$0.predecessorID == predecessor/);
});
test('listener routes updates and unfinished through same dispatcher', () => {
 assert.match(sk,/Transaction.updates/); assert.match(sk,/Transaction.unfinished/);
 assert.equal((sk.match(/await self\?\.receive\(result\)/g)||[]).length,2);
 assert.match(sk,/case .success\(let verification\): await receive\(verification\)/);
});
test('verified signed iOS15 provenance is checked before evidence routing', () => {
 assert.match(sk,/guard case .verified\(let transaction\) = result/);
 for (const field of ['environment','transactionId','productId','bundleId','appAccountToken','currency','price']) assert.ok(sk.includes(`payload["${field}"]`));
 assert.match(core,/var value = try read\(evidence.token\)/);
});
test('dispatch persistence precedes begin and StoreKit only accepts live permit', () => {
 assert.ok(sk.indexOf('journal.markBeginDispatched') < sk.indexOf('transport.begin'));
 assert.ok(sk.indexOf('reply.launchGranted') < sk.indexOf('product.purchase('));
 assert.equal((sk.match(/product.purchase\(/g)||[]).length,1);
});
test('finish needs exact durable server result and explicit winner permission', () => {
 assert.match(core,/result.durablyRecorded, result.identity == value.identity/);
 assert.match(core,/result.transactionID == transactionID/);
 assert.match(core,/result.finishAllowed && !result.reviewRequired/);
 assert.match(core,/result.disposition == .winner/);
 assert.match(sk,/guard let permit = try await journal.reconcile/);
 assert.ok(sk.indexOf('journal.reconcile') < sk.indexOf('transaction.finish()'));
});
test('late signed evidence invalidates stale finish authority and preserves all transactions', () => {
 assert.match(core,/signedEvidence.append\(evidence.signed\)\s+value.receipts\[index\].finishAuthorized = false/);
 assert.match(core,/value.receipts.append\(ReceiptRecord/);
 assert.match(core,/signedEvidence.last == signed/);
 assert.match(core,/operations.insert\(id\).inserted/);
});
test('normalized v3 DTO requires explicit typed fields and exact immutable binding', () => {
 assert.match(core,/let version: Int/);
 for (const name of ['financiallyRecorded','revoked','reviewRequired','fulfillmentGranted','finishAllowed']) assert.match(core,new RegExp(`let ${name}: Bool`));
 assert.match(core,/receipt.version == 3/);
 assert.match(core,/receipt.intentId == expected.intentID/);
 assert.match(core,/receipt.amountJpy == expected.amountJpy/);
 assert.match(core,/guard !receipt.finishAllowed, !receipt.fulfillmentGranted/);
 assert.match(core,/guard !receipt.revoked \|\| !receipt.fulfillmentGranted/);
});
test('finish consumes an in-memory generation permit at the isolated execution boundary',()=>{
 const execute=core.slice(core.indexOf('func executeFinish'),core.indexOf('private func recordFinishOutcome'));
 assert.match(core,/struct FinishPermit: Equatable/);
 assert.doesNotMatch(core,/struct FinishPermit: Codable/);
 assert.match(execute,/finishPermits\[permit.id\] == permit/);
 assert.match(execute,/signedEvidence.count == permit.evidenceGeneration/);
 assert.match(execute,/operation: \(isolated RecoveryJournal\)/);
 assert.ok(execute.indexOf('try persist(value)')<execute.indexOf('try await operation(self)'));
 assert.match(sk,/journal.executeFinish\(permit\)/);
 assert.doesNotMatch(sk,/journal.markFinishReturned/);
});
test('finish completion remains tied to its generation and unresolved execution blocks replay',()=>{
 assert.match(core,/\$0.evidenceGeneration == permit.evidenceGeneration \|\| \$0.state != .returned/);
 assert.match(core,/finishExecutions\[execution\].state = state/);
 assert.match(core,/signedEvidence.count == permit.evidenceGeneration\s+&& latest.receipts\[index\].reconciledEvidenceGeneration == permit.evidenceGeneration/);
 assert.match(core,/recordFinishOutcome\(permit, state: .outcomeUnknown\)/);
 assert.match(core,/value.archived = false/);
});
test('launch consumes live claim only after same-intent evidence and state revalidation',()=>{
 const launch=core.slice(core.indexOf('func executeLaunch'),core.indexOf('// Only the immediate'));
 assert.match(launch,/beginClaims\[identity.orderID\] == claim/);
 assert.match(launch,/value.state == .dispatchUnknown/);
 assert.match(launch,/\$0.identity.intentID == identity.intentID && !\$0.receipts.isEmpty/);
 assert.match(launch,/operation: \(isolated RecoveryJournal\)/);
 assert.ok(launch.indexOf('try persist(value)')<launch.indexOf('try await operation(self)'));
 assert.match(launch,/beginClaims.removeValue/);
 assert.match(sk,/journal.executeLaunch/);
});
test('compiled interleaving suite is included in the real macOS compiler command',()=>{
 const script=fs.readFileSync(new URL('../scripts/test-native-v3.sh',import.meta.url),'utf8');
 const harness=fs.readFileSync(new URL('../native/v3/RecoveryJournalChecks.swift',import.meta.url),'utf8');
 const races=fs.readFileSync(new URL('../native/v3/RecoveryInterleavingChecks.swift',import.meta.url),'utf8');
 assert.match(script,/interleavings=native\/v3\/RecoveryInterleavingChecks.swift/);
 assert.match(script,/"\$core" "\$checks" "\$interleavings" "\$transport" "\$transport_checks" "\$coordinator" "\$coordinator_checks" -o/);
 assert.match(harness,/try await InterleavingChecks.run/);
 for(const phrase of ['Stale permit must not invoke finish','Proof changed while verify suspended','Never attribute old finish to new proof','Observed receipt prevents launch and replay','Same-intent receipt suppresses new launch','No launch replay after start','Failed completion write preserves uncertain started marker']) assert.ok(races.includes(phrase));
});
