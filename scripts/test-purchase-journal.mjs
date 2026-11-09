// Execute the shipped v2 journal itself, not a rewritten JavaScript model.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const source=readFileSync('BoostPlugin.swift','utf8');
const body=source.split('// KOEFURIMA_PURCHASE_JOURNAL_BEGIN')[1]?.split('// KOEFURIMA_PURCHASE_JOURNAL_END')[0];
if(!body)throw Error('Native journal implementation missing');
// Historical test called a removed cancellation-release API. Its absence is a
// safety invariant: v2 userCancelled/unknown/pending must retain the same hold.
assert.doesNotMatch(body,/func\s+clearCancelled\b/);
const dir=mkdtempSync(join(tmpdir(),'koe-journal-'));
try{
 const path=join(dir,'journal.swift');
 writeFileSync(path,'import Foundation\n'+body+String.raw`
let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: root) }
let url = root.appendingPathComponent("journal.json")
let journal = KoePurchaseJournal(url: url)
let project = "tyulybijubckitybgubc", otherProject = "neotkrfsquysuatdruhg", environment = "Sandbox"
let token = UUID(), nonce = UUID(), owner = UUID().uuidString
var assertions = 0
func check(_ value: Bool) { assertions += 1; if !value { fatalError("Journal assertion failed") } }
func failsPreserving(_ action: () throws -> Void) throws {
    let before = try? Data(contentsOf: url)
    var rejected = false
    do { try action() } catch { rejected = true }
    check(rejected)
    check((try? Data(contentsOf: url)) == before)
}
check(try journal.read() == nil)
try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment,
                  ownerID: owner, amountJpy: 300, attemptNonce: nonce)
let restarted = KoePurchaseJournal(url: url)
let saved = try restarted.read(backendProjectRef: project, environment: environment)
check(saved?.schemaVersion == 2 && saved?.backendProjectRef == project && saved?.storeKitEnvironment == environment)
check(saved?.token == token && saved?.transactionID == nil)
check(saved?.ownerID == owner && saved?.amountJpy == 300 && saved?.attemptNonce == nonce)
// No transaction/empty history/cancel UI report supplies financial grant proof.
// Reopen the actual journal repeatedly: no timer or missing receipt clears it.
for _ in 0..<3 {
    let reopened = KoePurchaseJournal(url: url)
    check(try reopened.read() == saved)
    try failsPreserving { try reopened.begin(productID: "voice", token: UUID(), backendProjectRef: project, environment: environment) }
    try failsPreserving { try reopened.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
    try failsPreserving { try reopened.recordFinishReturned(backendProjectRef: project, environment: environment) }
    try failsPreserving { try reopened.archiveAppliedFinishUncertain(backendProjectRef: project, environment: environment) }
}
try failsPreserving { try restarted.begin(productID: "boost", token: UUID(), backendProjectRef: project, environment: environment) }
try failsPreserving { _ = try restarted.read(backendProjectRef: otherProject, environment: environment) }
try failsPreserving { _ = try restarted.read(backendProjectRef: project, environment: "Production") }
try failsPreserving { try restarted.retainSignedTransaction(productID: "voice", token: UUID(), signed: "proof", backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.retainSignedTransaction(productID: "boost", token: token, signed: "proof", backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.retainSignedTransaction(productID: "voice", token: token, signed: "", backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.retainSignedTransaction(productID: "voice", token: token, signed: String(repeating: "a", count: 30001), backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.recordVerifiedGrant(productID: "voice", token: nil, transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: otherProject, environment: environment) }
try failsPreserving { try restarted.recordVerifiedGrant(productID: "voice", token: token, transactionID: "invalid", backendProjectRef: project, environment: environment) }
try journal.retainSignedTransaction(productID: "voice", token: token, signed: "fixture-proof-not-real-jws", backendProjectRef: project, environment: environment)
// Signed bytes alone remain insufficient for finish-returned or archive.
try failsPreserving { try journal.recordFinishReturned(backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.archiveAppliedFinishUncertain(backendProjectRef: project, environment: environment) }
try journal.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment)
let afterGrantRestart = KoePurchaseJournal(url: url)
check(try afterGrantRestart.read()?.transactionID == "123")
check(try afterGrantRestart.read()?.signedTransaction == "fixture-proof-not-real-jws")
check(try afterGrantRestart.read()?.ownerID == owner && afterGrantRestart.read()?.attemptNonce == nonce)
try failsPreserving { try afterGrantRestart.recordVerifiedGrant(productID: "voice", token: token, transactionID: "456", backendProjectRef: project, environment: environment) }
try failsPreserving { try afterGrantRestart.clearFinished(productID: "voice", token: UUID(), transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try afterGrantRestart.clearFinished(productID: "boost", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try afterGrantRestart.clearFinished(productID: "voice", token: token, transactionID: "456", backendProjectRef: project, environment: environment) }
try afterGrantRestart.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment)
try afterGrantRestart.recordFinishReturned(backendProjectRef: project, environment: environment)
check(try KoePurchaseJournal(url: url).read()?.finishReturned == true)
try afterGrantRestart.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment)
check(try journal.read() == nil)
try failsPreserving { try journal.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
// Financially applied but no Apple finish acknowledgement: retain an archive,
// not a manufactured cancellation or finish-returned flag.
let archiveToken = UUID()
try journal.begin(productID: "voice", token: archiveToken, backendProjectRef: project, environment: environment)
try journal.retainSignedTransaction(productID: "voice", token: archiveToken, signed: "archive-proof", backendProjectRef: project, environment: environment)
try journal.recordVerifiedGrant(productID: "voice", token: archiveToken, transactionID: "789", backendProjectRef: project, environment: environment)
try journal.archiveAppliedFinishUncertain(backendProjectRef: project, environment: environment)
check(try journal.read() == nil)
let archiveURL = root.appendingPathComponent("applied-finish-uncertain-" + archiveToken.uuidString + ".json")
let archived = try JSONDecoder().decode(KoePurchaseAttempt.self, from: Data(contentsOf: archiveURL))
check(archived.token == archiveToken && archived.transactionID == "789" && archived.signedTransaction == "archive-proof")
check(archived.finishReturned != true)
let legacy = "{\"productID\":\"voice\",\"token\":\"\(token.uuidString)\"}"
try Data(legacy.utf8).write(to: url)
check(try journal.read()?.schemaVersion == nil)
try failsPreserving { _ = try journal.read(backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.archiveAppliedFinishUncertain(backendProjectRef: project, environment: environment) }
try Data("corrupt".utf8).write(to: url)
try failsPreserving { _ = try journal.read() }
try failsPreserving { try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment) }
let blocked = KoePurchaseJournal(url: url.appendingPathComponent("child"))
var writeRejected = false
do { try blocked.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment) } catch { writeRejected = true }
check(writeRejected)
print("Shipped v2 journal: \(assertions) assertions passed. Cancellation keeps its hold; v3 cancellation recovery remains unlinked.")
`);
 execFileSync('swift',[path],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
