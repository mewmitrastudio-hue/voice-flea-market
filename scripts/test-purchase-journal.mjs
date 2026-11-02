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
let token = UUID()
func assertNoThrow(_ value: Bool) { assert(value) }
func expectFailure(_ action: () throws -> Void) {
    do { try action(); fatalError("Expected failure") } catch { }
}
assertNoThrow(try journal.read() == nil)
try journal.begin(productID: "voice", token: token)
let restarted = KoePurchaseJournal(url: url)
assertNoThrow(try restarted.read() == KoePurchaseAttempt(productID: "voice", token: token))
expectFailure { try restarted.begin(productID: "boost", token: UUID()) }
try restarted.clear(productID: "voice", token: UUID())
assertNoThrow(try restarted.read() != nil)
try restarted.clear(productID: "boost", token: token)
assertNoThrow(try restarted.read() != nil)
try restarted.clear(productID: "voice", token: nil)
assertNoThrow(try restarted.read() != nil)
try restarted.clear(productID: "voice", token: token)
assertNoThrow(try restarted.read() == nil)
try restarted.clear(productID: "voice", token: token)
try restarted.begin(productID: "boost", token: token)
try Data("corrupt".utf8).write(to: url)
expectFailure { _ = try restarted.read() }
expectFailure { try restarted.begin(productID: "voice", token: token) }
expectFailure { try restarted.clear(productID: "voice", token: token) }
let blocked = KoePurchaseJournal(url: url.appendingPathComponent("child"))
expectFailure { try blocked.begin(productID: "voice", token: token) }
print("Purchase journal: restart, duplicate prevention, exact ownership, cancellation, corruption and write failure passed")
`);
 execFileSync('swift',[path],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
