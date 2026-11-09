import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
const files=['RecoveryJournal.swift','NativeHTTPTransport.swift','NativePurchaseCoordinator.swift','StoreKitRecovery.swift','StoreKitProductCatalog.swift','NativeRecoveryHost.swift','NativeRecoveryPlugin.swift'];
const verifier=new URL('../scripts/verify-native-v3-target.mjs',import.meta.url).pathname;
function fixture(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'koe-real-target-'));
 for(const f of ['ios/App/App.xcodeproj/project.pbxproj','ios/App/App/SceneDelegate.swift','BoostPlugin.swift','ios/App/App/AppDelegate.swift','ios/App/App/capacitor.config.json','ios/App/CapApp-SPM/Package.swift','ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift','package-lock.json','release-manifest.json',...files.map(n=>'native/v3/'+n)]){
  fs.mkdirSync(path.dirname(path.join(temp,f)),{recursive:true});fs.writeFileSync(path.join(temp,f),read(f));
 }
 return temp;
}
test('real App Sources inventory contains seven production files and no test fixtures',()=>{
 const result=cp.spawnSync(process.execPath,[verifier],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const inventory=JSON.parse(result.stdout);assert.equal(inventory.sourcesCount,9);assert.equal(inventory.productionSources.length,7);
 assert.equal(inventory.testSourcesIncluded,false);assert.equal(inventory.runtimeGates,false);
});
test('inventory rejects missing membership, duplicate entries, wrong source root and appended definitions',()=>{
 const cases=[
  (p)=>p.replace(/\s+[A-F0-9]{24} \/\* NativeHTTPTransport.swift in Sources \*\/,/,'\n'),
  (p)=>p.replace(/([A-F0-9]{24} \/\* NativeHTTPTransport.swift in Sources \*\/,)/,'$1\n$1'),
  (p)=>p.replace('path = ../../native/v3;','path = ../../other/v3;')
 ];
 for(const change of cases){const temp=fixture();try{
  const p=path.join(temp,'ios/App/App.xcodeproj/project.pbxproj');fs.writeFileSync(p,change(fs.readFileSync(p,'utf8')));
  assert.notEqual(cp.spawnSync(process.execPath,[verifier],{cwd:temp}).status,0);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}}
 const temp=fixture();try{
  fs.appendFileSync(path.join(temp,'ios/App/App/SceneDelegate.swift'),'\n// KOEFURIMA_NATIVE_V3_COMPILE_PROBE\nactor RecoveryJournal {}');
  assert.notEqual(cp.spawnSync(process.execPath,[verifier],{cwd:temp}).status,0);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('normal build compiles plugin definition but default-off hooks do not register it',()=>{
 assert.doesNotMatch(read('native/v3/NativeRecoveryPlugin.swift'),/#if KOEFURIMA_NATIVE_V3_HOST/);
 assert.match(read('BoostPlugin.swift'),/#if KOEFURIMA_NATIVE_V3_HOST\s+if RecoveryIntegration.hostEnabled/);
 assert.match(read('ios/App/App/AppDelegate.swift'),/#if KOEFURIMA_NATIVE_V3_HOST/);
 const workflow=read('.github/workflows/create-ios.yml');
 assert.ok(workflow.indexOf('Verify real App target')<workflow.indexOf('Build ${{ matrix.target }}'));
 assert.match(workflow,/SWIFT_ACTIVE_COMPILATION_CONDITIONS='\$\(inherited\) KOEFURIMA_NATIVE_V3_HOST'/);
 assert.doesNotMatch(read('scripts/prepare-native-v3-compile-probe.mjs'),/writeFile|appendFile/);
});
test('verification cannot mutate project, native source or runtime flags',()=>{
 const temp=fixture();try{
  const snapshots=new Map(['ios/App/App.xcodeproj/project.pbxproj','ios/App/App/SceneDelegate.swift',...files.map(n=>'native/v3/'+n)].map(p=>[p,fs.readFileSync(path.join(temp,p))]));
  for(let i=0;i<2;i++)assert.equal(cp.spawnSync(process.execPath,[verifier],{cwd:temp}).status,0);
  for(const [p,before] of snapshots)assert.ok(before.equals(fs.readFileSync(path.join(temp,p))),p);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('post-build input capture rejects missing compiler lists and hashes listed fixture sources',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'koe-input-capture-'));
 const script=new URL('../scripts/capture-native-build-inputs.mjs',import.meta.url).pathname;
 try{
  const derived=path.join(temp,'derived');fs.mkdirSync(path.join(derived,'Build'),{recursive:true});
  const output=path.join(temp,'evidence.json');
  assert.notEqual(cp.spawnSync(process.execPath,[script,derived,output],{cwd:temp}).status,0);
  const source=path.join(temp,'AppSource.swift');fs.writeFileSync(source,'let fixture = 1\n');
  const list=path.join(derived,'Build','App.SwiftFileList');fs.writeFileSync(list,source+'\n');
  assert.equal(cp.spawnSync(process.execPath,[script,derived,output],{cwd:temp}).status,0);
  const first=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(first.fileLists.length,1);assert.equal(first.fileLists[0].inputs[0].path,source);
  fs.writeFileSync(source,'let fixture = 2\n');
  assert.equal(cp.spawnSync(process.execPath,[script,derived,output],{cwd:temp}).status,0);
  const second=JSON.parse(fs.readFileSync(output,'utf8'));assert.notEqual(second.fileLists[0].inputs[0].sha256,first.fileLists[0].inputs[0].sha256);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
