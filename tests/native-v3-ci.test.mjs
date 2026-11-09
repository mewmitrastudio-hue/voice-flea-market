import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
const workflow=fs.readFileSync(new URL('../.github/workflows/create-ios.yml',import.meta.url),'utf8');
const scriptPath=new URL('../scripts/test-native-v3.sh',import.meta.url);
const script=fs.readFileSync(scriptPath,'utf8');
test('unlinked native source triggers existing CI for both push and PR',()=>{
 assert.equal((workflow.match(/'native\/v3\/\*\*'/g)||[]).length,2);
 assert.match(workflow,/verify-native-v3:\n    runs-on: macos-latest/);
 const job=workflow.slice(workflow.indexOf('  verify-native-v3:'),workflow.indexOf('  build-ios:'));
 assert.doesNotMatch(job,/needs:|continue-on-error:/);
 assert.match(job,/set -euo pipefail/);
 assert.match(job,/if: always\(\)/);
});
test('macOS executable compilation and execution are distinct from iOS typecheck',()=>{
 assert.match(script,/run xcrun --sdk macosx swiftc/);
 assert.match(script,/run "\$work\/journal-checks"/);
 assert.match(script,/for sdk in iphoneos iphonesimulator/);
 assert.match(script,/-parse-as-library -typecheck/);
 assert.match(script,/target=arm64-apple-ios15.0/);
 assert.match(script,/target=arm64-apple-ios15.0-simulator/);
 assert.doesNotMatch(script,/-disable-availability-checking|CODE_SIGNING_ALLOWED=YES|continue-on-error/);
});
test('verification script has valid shell syntax',()=>{
 const result=cp.spawnSync('bash',['-n',scriptPath.pathname],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
test('non-macOS check fails explicitly, never silently skips native verification',()=>{
 if(process.platform==='darwin') return;
 const result=cp.spawnSync('bash',[scriptPath.pathname],{encoding:'utf8'});
 assert.notEqual(result.status,0); assert.match(result.stderr,/No checks were run/);
});
test('legacy compiler test exercises current safety APIs instead of removed cancellation release',()=>{
 const legacy=fs.readFileSync(new URL('../scripts/test-purchase-journal.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(legacy,/\.clearCancelled\(/);
 for(const api of ['recordFinishReturned','archiveAppliedFinishUncertain','retainSignedTransaction','recordVerifiedGrant']) assert.ok(legacy.includes('.'+api+'('));
 assert.match(legacy,/for _ in 0\.\.<3/);
 assert.match(legacy,/Cancellation keeps its hold; v3 cancellation recovery remains unlinked/);
 assert.match(workflow,/run: node scripts\/test-purchase-journal.mjs/);
});
