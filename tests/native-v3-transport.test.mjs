// Source contracts, not Swift execution. The real mock HTTP tests are in CI's Swift executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const transport=read('native/v3/NativeHTTPTransport.swift'),core=read('native/v3/RecoveryJournal.swift'),host=read('native/v3/NativeRecoveryHost.swift');
test('fixed original HTTPS transport refuses redirects and bounds request/response without persistence',()=>{
 assert.match(transport,/https:\/\/tyulybijubckitybgubc.supabase.co/);
 assert.match(transport,/completionHandler\(nil\)/);
 assert.match(transport,/URLSessionConfiguration.ephemeral/);
 assert.match(transport,/data.count < 262144/);
 assert.match(transport,/response.url == url/);
 assert.match(transport,/response.contentType\?\.range/);
 assert.match(transport,/8192 : 40000/);
 assert.doesNotMatch(transport,/UserDefaults|print\(|debugPrint\(/);
});
test('transport checks current session before and after every HTTP await',()=>{
 const request=transport.slice(transport.indexOf('private func request'),transport.indexOf('private func keys'));
 assert.equal((request.match(/journal.checkSession\(session\)/g)||[]).length,2);
 assert.ok(request.indexOf('journal.checkSession')<request.indexOf('client.send'));
 assert.ok(request.lastIndexOf('journal.checkSession')>request.indexOf('client.send'));
});
test('session epochs invalidate execution authority and out-of-order auth events cannot restore old owner',()=>{
 assert.match(core,/next > sessionSequence/);
 assert.match(core,/activeSession\?\.generation == session.generation/);
 assert.match(core,/beginClaims.removeAll\(\); finishPermits.removeAll\(\)/);
 assert.match(core,/session.generation == permit.sessionGeneration/);
 assert.match(host,/requireSessionFreshness: true/);
 assert.match(host,/sequence == authSequence/);
 assert.match(host,/sequence: sequence \* 2 \+ 1/);
 assert.match(host,/Foreign\/unknown first item must not starve/);
 assert.match(host,/!unresolved else/);
});
test('cancel report persists actual observed or retired status and cannot create retry admission',()=>{
 assert.match(core,/latest.serverState = actualState/);
 assert.match(core,/old.serverState == .clientReportedCancelled/);
 assert.match(transport,/return reply.attempt.state/);
 assert.doesNotMatch(transport,/finishAck/);
});
test('new admission and recovery gates are separate and all remain false',()=>{
 for(const gate of ['hostEnabled','newAdmissionEnabled','recoveryEnabled'])assert.match(core,new RegExp(`static let ${gate} = false`));
 const store=read('native/v3/StoreKitRecovery.swift');
 assert.match(store,/guard RecoveryIntegration.newAdmissionEnabled else/);
 assert.match(store,/guard RecoveryIntegration.recoveryEnabled else/);
 assert.match(host,/RecoveryIntegration.hostEnabled, RecoveryIntegration.recoveryEnabled/);
});
test('all finalized actions are represented with typed canonical replies',()=>{
 for(const action of ['prepareInitial','begin','prepareRetry','status','listAttempts','cancelReport','pendingReport'])assert.ok(transport.includes('"'+action+'"'));
 assert.match(transport,/Set\(object.keys\) == expected/);
 assert.match(transport,/let launchGranted: Bool/);
 assert.match(transport,/result.attempt.previousOrderId == saved.predecessorID/);
 assert.match(transport,/identity.intentID == expected.intentID/);
});
test('partial pagination and receipt holds never erase records or grant finish',()=>{
 assert.match(transport,/Incomplete listing is never empty\/success/);
 assert.match(transport,/seenOrders.insert/);
 assert.match(transport,/seenCursors.contains/);
 assert.match(transport,/response.status == 409/);
 assert.match(transport,/!result.finishAllowed, !result.fulfillmentGranted/);
 assert.doesNotMatch(transport,/removeItem/);
});
test('compile-gated app hooks preserve legacy route and explicit probe compiles new definitions',()=>{
 assert.match(read('ios/App/App/AppDelegate.swift'),/#if KOEFURIMA_NATIVE_V3_HOST\s+NativeRecoveryHost.shared.startAtApplicationLaunch/);
 const bridge=read('BoostPlugin.swift');
 assert.match(bridge,/#if KOEFURIMA_NATIVE_V3_HOST\s+if RecoveryIntegration.hostEnabled/);
 assert.match(bridge,/if RecoveryIntegration.newAdmissionEnabled/);
 const workflow=read('.github/workflows/create-ios.yml');
 assert.match(workflow,/verify-native-v3-target.mjs/);
 assert.match(workflow,/SWIFT_ACTIVE_COMPILATION_CONDITIONS='\$\(inherited\) KOEFURIMA_NATIVE_V3_HOST'/);
 const script=read('scripts/test-native-v3.sh');
 assert.match(script,/"\$core" "\$transport" "\$coordinator" "\$storekit" "\$catalog" "\$host"/);
});
test('real Swift mock transport checks are compiled and invoked, not just source matched',()=>{
 assert.match(read('scripts/test-native-v3.sh'),/transport_checks=native\/v3\/NativeTransportChecks.swift/);
 assert.match(read('native/v3/RecoveryJournalChecks.swift'),/try await NativeTransportChecks.run/);
 assert.match(read('native/v3/NativeTransportChecks.swift'),/Logout\/refresh during HTTP/);
});
test('initial fresh order is durable before preparation and session environment comes from native proof',()=>{
 assert.match(core,/func reserveInitial/);
 assert.match(core,/readInitial\(value.freshOrderID\) == value/);
 assert.match(transport,/journal.readInitial\(saved.freshOrderID\) == saved/);
 assert.match(host,/case .verified\(let transaction\)/);
 assert.match(host,/environment == verifiedEnvironment/);
 assert.match(host,/case "sandboxReceipt"/);
});
test('real-target inventory is read-only and never flips runtime gates',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path'); const {execFileSync}=await import('node:child_process');
 const tmp=mkdtempSync(join(tmpdir(),'koe-v3-probe-'));
 try{
  mkdirSync(join(tmp,'ios/App/App'),{recursive:true});mkdirSync(join(tmp,'ios/App/App.xcodeproj'),{recursive:true});mkdirSync(join(tmp,'native/v3'),{recursive:true});
  writeFileSync(join(tmp,'ios/App/App.xcodeproj/project.pbxproj'),read('ios/App/App.xcodeproj/project.pbxproj'));
  writeFileSync(join(tmp,'BoostPlugin.swift'),read('BoostPlugin.swift'));
  for(const p of ['ios/App/App/AppDelegate.swift','ios/App/App/capacitor.config.json','ios/App/CapApp-SPM/Package.swift','ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift','package-lock.json','release-manifest.json']){mkdirSync(join(tmp,p,'..'),{recursive:true});writeFileSync(join(tmp,p),read(p));}
  writeFileSync(join(tmp,'ios/App/App/SceneDelegate.swift'),read('ios/App/App/SceneDelegate.swift'));
  for(const file of ['RecoveryJournal.swift','NativeHTTPTransport.swift','NativePurchaseCoordinator.swift','StoreKitRecovery.swift','StoreKitProductCatalog.swift','NativeRecoveryHost.swift','NativeRecoveryPlugin.swift'])writeFileSync(join(tmp,'native/v3',file),read('native/v3/'+file));
  const script=new URL('../scripts/prepare-native-v3-compile-probe.mjs',import.meta.url).pathname;
  execFileSync(process.execPath,[script],{cwd:tmp});const first=fs.readFileSync(join(tmp,'ios/App/App/SceneDelegate.swift'),'utf8');
  execFileSync(process.execPath,[script],{cwd:tmp});assert.equal(fs.readFileSync(join(tmp,'ios/App/App/SceneDelegate.swift'),'utf8'),first);
  assert.equal((first.match(/\/\/ KOEFURIMA_NATIVE_V3_COMPILE_PROBE/g)||[]).length,0);
  for(const gate of ['hostEnabled','newAdmissionEnabled','recoveryEnabled'])assert.ok(fs.readFileSync(join(tmp,'native/v3/RecoveryJournal.swift'),'utf8').includes(`static let ${gate} = false`));
 }finally{rmSync(tmp,{recursive:true,force:true});}
});
