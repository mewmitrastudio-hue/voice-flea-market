// Run ONLY after an actual successful Xcode build. Hash the compiler's emitted
// SwiftFileLists and every listed source, including dependency/generated Swift.
// This is not a fingerprint of SDK binaries or all Objective-C header inputs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const [derived,output]=process.argv.slice(2);assert.ok(derived&&output,'Usage: capture-native-build-inputs.mjs <derivedData> <output.json>');
const root=path.resolve(derived,'Build');assert.ok(fs.statSync(root).isDirectory());
const lists=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const p=path.join(dir,entry.name);
 if(entry.isSymbolicLink())continue;
 if(entry.isDirectory())walk(p);
 else if(entry.name.endsWith('.SwiftFileList'))lists.push(p);
}}
walk(root);
assert.ok(lists.some(p=>path.basename(p)==='App.SwiftFileList'),'No actual App compiler SwiftFileList found; cannot attest inputs');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fileLists=lists.sort().map(list=>{
 const inputs=fs.readFileSync(list,'utf8').split(/\r?\n/).filter(line=>line.trim()).map(line=>{
  const raw=line.trim();const p=raw.startsWith('"')?JSON.parse(raw):raw;
  assert.equal(typeof p,'string');assert.ok(path.isAbsolute(p),'Expected actual absolute compiler input path');
  assert.ok(fs.statSync(p).isFile(),'Missing compiler source '+p);
  return {path:p,sha256:sha(p)};
 });
 assert.ok(inputs.length,'Empty compiler file list');
 return {path:list,sha256:sha(list),inputs};
});
const git=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
const value={checkedOutCommit:git.status===0?git.stdout.trim():null,workflowRunID:process.env.GITHUB_RUN_ID??null,workflowRunAttempt:process.env.GITHUB_RUN_ATTEMPT??null,derivedDataPath:path.resolve(derived),source:'actual emitted SwiftFileLists after build',scope:'Swift sources only; not SDK binaries or all C/Objective-C headers',fileLists};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(value,null,2)+'\n');
console.log('Captured '+lists.length+' actual Swift compiler file lists.');
