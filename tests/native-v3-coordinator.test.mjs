import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const coordinator=read('native/v3/NativePurchaseCoordinator.swift'),plugin=read('native/v3/NativeRecoveryPlugin.swift'),host=read('native/v3/NativeRecoveryHost.swift');
test('prepared live quote is session-bound and consumed once before any begin',()=>{
 assert.match(coordinator,/let generation: UUID/);
 assert.match(coordinator,/quotes.removeValue\(forKey: quoteID\)/);
 assert.match(coordinator,/session.generation == quote.generation/);
 const purchase=coordinator.slice(coordinator.indexOf('func purchase('),coordinator.indexOf('func outcome('));
 assert.ok(purchase.indexOf('quotes.removeValue')<purchase.indexOf('transport.begin'));
 assert.match(purchase,/journal.executeLaunch/);
 assert.equal((purchase.match(/transport.begin\(/g)||[]).length,1);
});
test('prepareRetry never launches and creates only a separate confirmation quote',()=>{
 const retry=coordinator.slice(coordinator.indexOf('func prepareRetry('),coordinator.indexOf('func purchase('));
 // First protocol declaration also appears; use actor method for scope.
 const body=retry.slice(retry.lastIndexOf('func prepareRetry('));
 assert.match(body,/reserveExplicitRetry/);
 assert.match(body,/return try await quote/);
 assert.doesNotMatch(body,/transport.begin\(|executeLaunch\(|\.launch\(/);
});
test('actual cancel is durable before report and unknown or pending cannot synthesize it',()=>{
 const callback=coordinator.slice(coordinator.indexOf('switch result'),coordinator.indexOf('func outcome'));
 assert.ok(callback.indexOf('recordStoreKitResult(identity.orderID, result: .userCancelled)')<callback.indexOf('retryCancellationReport'));
 assert.match(callback,/case .pending:/); assert.match(callback,/case .unknown:/);
 assert.match(callback,/No begin\/purchase retry/);
});
test('grant UI outcome needs durable winner plus canonical observed state',()=>{
 assert.match(coordinator,/transport.status\(identity, session: session\)/);
 assert.match(coordinator,/receipt\?\.disposition == .winner.*record.serverState == .transactionObserved/);
 assert.match(coordinator,/"serverState": serverState.map.*NSNull\(\)/);
 assert.match(coordinator,/"reviewRequired"/); assert.match(coordinator,/"fulfillmentGranted"/);
});
test('all agreed methods are wired under existing compile gate with no order override in purchase',()=>{
 for(const name of ['getMode','sessionChanged','logout','prepare','prepareRetry','purchase','recover'])assert.ok(plugin.includes('name: "'+name+'"'));
 const purchase=plugin.slice(plugin.indexOf('@objc func purchase'),plugin.indexOf('@objc func sessionChanged'));
 assert.match(purchase,/call.getString\("quoteId"\)/);
 assert.doesNotMatch(purchase,/call.getString\("orderId"\)|call.getInt/);
 assert.match(plugin,/"attempts": outcomes.map/);
 assert.match(host,/environment == nil \|\| environment == verifiedEnvironment/);
});
test('actual product is fetched and checked before isolated launch closure, not inside it',()=>{
 const catalog=read('native/v3/StoreKitProductCatalog.swift');
 assert.ok(catalog.indexOf('Product.products')<catalog.indexOf('return PreparedNativeProduct'));
 assert.match(catalog,/product.type == .consumable/);
 assert.match(catalog,/product.priceFormatStyle.currencyCode == "JPY"/);
 assert.equal((catalog.match(/Product.products/g)||[]).length,1);
 assert.match(catalog,/product.purchase\(options: \[.appAccountToken\(token\)\]\)/);
});
test('coordinator mock cancellation-to-retry-to-grant chain is compiled and invoked in Swift',()=>{
 const script=read('scripts/test-native-v3.sh'),checks=read('native/v3/NativeCoordinatorChecks.swift');
 assert.match(script,/coordinator_checks=native\/v3\/NativeCoordinatorChecks.swift/);
 assert.match(read('native/v3/RecoveryJournalChecks.swift'),/NativeCoordinatorChecks.run/);
 for(const text of ['Actual normal cancellation acknowledged','prepareRetry is preview only','Exactly one StoreKit invocation','Lost begin remains unknown','Old session quote has no execution authority','Late excess does not finish'])assert.ok(checks.includes(text));
});
test('recovery cannot return empty metadata while legacy or unknown server attempts remain',()=>{
 assert.match(host,/journal.legacyBytes\(\) == nil/);
 assert.match(host,/transport.listAll\(session: session\)/);
 assert.match(host,/known.contains\(where: \{ \$0.identity == identity \}\)/);
 assert.match(host,/return outcomes/);
 assert.match(coordinator,/journal.outcomeSnapshots\(session: session\)/);
 assert.match(read('native/v3/RecoveryJournal.swift'),/guard try legacyBytes\(\) == nil/);
});
test('unreconciled new proof suppresses stale winner UI fields',()=>{
 assert.match(coordinator,/reconciledEvidenceGeneration != \$0.signedEvidence.count/);
 assert.match(coordinator,/let fulfilled = !unresolvedEvidence/);
 assert.match(coordinator,/else if unresolvedEvidence \{ local = "receiptObserved" \}/);
 assert.match(coordinator,/receiptClassification: unresolvedEvidence \? nil/);
 assert.match(coordinator,/fulfillmentGranted: unresolvedEvidence \? false/);
});
test('single and list presentations consume one synchronous owner-session journal snapshot',()=>{
 const core=read('native/v3/RecoveryJournal.swift');
 const single=coordinator.slice(coordinator.indexOf('func outcome('),coordinator.indexOf('private static func present'));
 assert.equal((single.match(/await/g)||[]).length,1);
 assert.match(single,/journal.outcomeSnapshot/);
 const snapshot=core.slice(core.indexOf('func outcomeSnapshot('),core.indexOf('private func persist'));
 assert.doesNotMatch(snapshot,/await|async/);
 assert.match(snapshot,/try checkSession\(session\)/);
 assert.match(snapshot,/\$0.identity.ownerID == session.ownerID/);
 assert.match(coordinator,/let snapshots = try await journal.outcomeSnapshots/);
});
test('compiled coordinator fixtures explicitly use production freshness and cover suspended refresh/new-proof presentation',()=>{
 const checks=read('native/v3/NativeCoordinatorChecks.swift');
 assert.match(checks,/requireSessionFreshness: true/);
 for(const phrase of ['New proof never reuses old winner presentation','Record and related attempts belong to one actor snapshot','Stale catalog cannot create launch','Stale begin reply cannot launch'])assert.ok(checks.includes(phrase));
});
