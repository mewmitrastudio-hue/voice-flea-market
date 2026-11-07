import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const source=readFileSync('BoostPlugin.swift','utf8');
const body=source.split('// KOEFURIMA_PURCHASE_JOURNAL_BEGIN')[1]?.split('// KOEFURIMA_PURCHASE_JOURNAL_END')[0];
if(!body)throw Error('Native journal implementation missing');
const dir=mkdtempSync(join(tmpdir(),'koe-journal-'));
try{
 const path=join(dir,'journal.swift');
 writeFileSync(path,'import Foundation\n'+body+String.raw`
let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: root) }
let url = root.appendingPathComponent("journal.json")
let journal = KoePurchaseJournal(url: url)
let project = "neotkrfsquysuatdruhg", otherProject = "aaaaaaaaaaaaaaaaaaaa", environment = "Sandbox"
let token = UUID()
func check(_ value: Bool) { assert(value) }
func failsPreserving(_ action: () throws -> Void) throws {
    let before = try? Data(contentsOf: url)
    do { try action(); fatalError("Expected failure") } catch { }
    check((try? Data(contentsOf: url)) == before)
}
check(try journal.read() == nil)
try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment)
let restarted = KoePurchaseJournal(url: url)
let saved = try restarted.read(backendProjectRef: project, environment: environment)
check(saved?.schemaVersion == 2 && saved?.backendProjectRef == project && saved?.storeKitEnvironment == environment)
check(saved?.token == token && saved?.transactionID == nil)
try failsPreserving { try restarted.begin(productID: "boost", token: UUID(), backendProjectRef: project, environment: environment) }
try failsPreserving { _ = try restarted.read(backendProjectRef: otherProject, environment: environment) }
try failsPreserving { _ = try restarted.read(backendProjectRef: project, environment: "Production") }
try failsPreserving { try restarted.clearCancelled(productID: "voice", token: UUID(), backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.clearCancelled(productID: "boost", token: token, backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.recordVerifiedGrant(productID: "voice", token: nil, transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try restarted.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: otherProject, environment: environment) }
try failsPreserving { try restarted.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try restarted.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment)
let afterGrantRestart = KoePurchaseJournal(url: url)
check(try afterGrantRestart.read()?.transactionID == "123")
try failsPreserving { try afterGrantRestart.recordVerifiedGrant(productID: "voice", token: token, transactionID: "456", backendProjectRef: project, environment: environment) }
try failsPreserving { try afterGrantRestart.clearCancelled(productID: "voice", token: token, backendProjectRef: project, environment: environment) }
try failsPreserving { try afterGrantRestart.clearFinished(productID: "voice", token: token, transactionID: "456", backendProjectRef: project, environment: environment) }
try afterGrantRestart.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment)
try afterGrantRestart.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment)
check(try journal.read() == nil)
try failsPreserving { try journal.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment)
try journal.clearCancelled(productID: "voice", token: token, backendProjectRef: project, environment: environment)
check(try journal.read() == nil)
let legacy = "{\"productID\":\"voice\",\"token\":\"\(token.uuidString)\"}"
try Data(legacy.utf8).write(to: url)
check(try journal.read()?.schemaVersion == nil)
try failsPreserving { _ = try journal.read(backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.clearCancelled(productID: "voice", token: token, backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.recordVerifiedGrant(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try failsPreserving { try journal.clearFinished(productID: "voice", token: token, transactionID: "123", backendProjectRef: project, environment: environment) }
try Data("corrupt".utf8).write(to: url)
try failsPreserving { _ = try journal.read() }
try failsPreserving { try journal.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment) }
let blocked = KoePurchaseJournal(url: url.appendingPathComponent("child"))
do { try blocked.begin(productID: "voice", token: token, backendProjectRef: project, environment: environment); fatalError("Expected write failure") } catch { }
print("Versioned purchase journal: exact provenance, legacy barrier, restart, exact grant, cancellation, corruption and write failure passed")
`);
 execFileSync('swift',[path],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
