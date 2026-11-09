// Read-only source inventory. This is not an Xcode parser or a Swift compiler.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const expected=['RecoveryJournal.swift','NativeHTTPTransport.swift','NativePurchaseCoordinator.swift','StoreKitRecovery.swift','StoreKitProductCatalog.swift','NativeRecoveryHost.swift','NativeRecoveryPlugin.swift'];
const project=fs.readFileSync('ios/App/App.xcodeproj/project.pbxproj','utf8');
const block=id=>{
 const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const result=project.match(new RegExp('\\b'+escaped+'(?: /\\*[^\\n]*?\\*/)? = \\{([\\s\\S]*?)\\n\\t\\t\\};'));
 assert.ok(result,'Missing project object '+id);return result[1];
};
const target=block('504EC3031FED79650016851F');
assert.match(target,/isa = PBXNativeTarget;/);assert.match(target,/504EC3001FED79650016851F \/\* Sources \*\//);
const sources=block('504EC3001FED79650016851F').match(/files = \(([\s\S]*?)\);/)[1];
const sourceIDs=[...sources.matchAll(/\b([A-F0-9]{24}) \/\*/g)].map(m=>m[1]);
assert.equal(new Set(sourceIDs).size,sourceIDs.length,'Duplicate Sources member');
const compiled=[];
for(const id of sourceIDs){
 const build=project.match(new RegExp(id+' /\\*[^\\n]*?\\*/ = \\{isa = PBXBuildFile; fileRef = ([A-F0-9]{24}) /\\* ([^*]+) \\*/; \\};'));
 assert.ok(build,'Unresolved source build entry '+id);compiled.push({buildID:id,referenceID:build[1],name:build[2].trim()});
}
assert.equal(compiled.length,expected.length+2,'Unexpected compiled source membership');
assert.ok(compiled.every(item=>!/(Checks|Tests)\.swift$/.test(item.name)),'Test source leaked into App');
const groupMatch=project.match(/([A-F0-9]{24}) \/\* NativeV3 \*\/ = \{/);assert.ok(groupMatch,'Missing NativeV3 group');
const group=block(groupMatch[1]);
assert.match(group,/path = \.\.\/\.\.\/native\/v3;/);assert.match(group,/sourceTree = SOURCE_ROOT;/);
assert.equal(path.resolve('ios/App','../../native/v3'),path.resolve('native/v3'));
assert.ok(block('504EC2FB1FED79650016851F').includes(groupMatch[1]),'Group missing from main tree');
for(const name of expected){
 const members=compiled.filter(item=>item.name===name);assert.equal(members.length,1,name+' must compile exactly once');
 const item=members[0];assert.ok(group.includes(item.referenceID),name+' missing from NativeV3 group');
 const escaped=name.replaceAll('.','\\.');
 assert.match(project,new RegExp(item.referenceID+' /\\* '+escaped+' \\*/ = \\{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = '+escaped+'; sourceTree = "<group>"; \\};'));
 assert.ok(fs.statSync('native/v3/'+name).isFile());
}
const core=fs.readFileSync('native/v3/RecoveryJournal.swift','utf8');
for(const gate of ['hostEnabled','newAdmissionEnabled','recoveryEnabled'])assert.match(core,new RegExp(`static let ${gate} = false`));
const plugin=fs.readFileSync('native/v3/NativeRecoveryPlugin.swift','utf8');assert.doesNotMatch(plugin,/#if KOEFURIMA_NATIVE_V3_HOST/,'Plugin type must compile in normal App build');
const scene=fs.readFileSync('ios/App/App/SceneDelegate.swift','utf8');
assert.doesNotMatch(scene,/KOEFURIMA_NATIVE_V3_COMPILE_PROBE|actor RecoveryJournal\b/,'Do not append already-linked v3 types');
assert.equal((scene.match(/public class KoeBoostPlugin/g)||[]).length,1,'Legacy bridge must remain single definition');
const bridge=fs.readFileSync('BoostPlugin.swift','utf8');
assert.match(bridge,/#if KOEFURIMA_NATIVE_V3_HOST\s+if RecoveryIntegration.hostEnabled \{\s+bridge\?\.registerPluginInstance\(KoeRecoveryPlugin\(\)\)/);
const config=JSON.parse(fs.readFileSync('ios/App/App/capacitor.config.json','utf8'));
assert.ok(Array.isArray(config.packageClassList) && !config.packageClassList.includes('KoeRecoveryPlugin'),'Runtime-off plugin must not auto-register');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const directInputs=['ios/App/App/AppDelegate.swift','ios/App/App/SceneDelegate.swift',...expected.map(name=>'native/v3/'+name)];
const controls=['ios/App/App.xcodeproj/project.pbxproj','BoostPlugin.swift','release-manifest.json','ios/App/App/capacitor.config.json','ios/App/CapApp-SPM/Package.swift','ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift','package-lock.json'];
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
const checkedOutCommit=revision.status===0?revision.stdout.trim():null;
console.log(JSON.stringify({checkedOutCommit,workflowRunID:process.env.GITHUB_RUN_ID??null,workflowRunAttempt:process.env.GITHUB_RUN_ATTEMPT??null,requestedBuildMode:process.env.NATIVE_TARGET_BUILD_MODE??'local-static-inventory',directAppSwiftInputs:Object.fromEntries(directInputs.map(p=>[p,sha(p)])),buildControlInputs:Object.fromEntries(controls.map(p=>[p,sha(p)])),legacyManifestScope:'boost_native_sha256 binds BoostPlugin.swift only; not this entire inventory',resolvedDependencyAndGeneratedInputs:'capture after an actual Xcode build using capture-native-build-inputs.mjs',target:'App',productionSources:expected.map(name=>'native/v3/'+name),sourcesCount:compiled.length,testSourcesIncluded:false,runtimeGates:false,sourceInventoryOnly:true},null,2));
