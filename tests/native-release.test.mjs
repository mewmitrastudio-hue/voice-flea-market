import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
test('reject stale or modified native release and prepare current release idempotently',()=>{
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koe-native-'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')+'/';
for(const d of ['www','ios/App/App/public','ios/App/App.xcodeproj','node_modules/@capacitor/core/dist'])fs.mkdirSync(path.join(dir,d),{recursive:true});
const bytes=fs.readFileSync(root+'index.html'),native=fs.readFileSync(root+'BoostPlugin.swift');
for(const p of ['index.html','www/index.html','ios/App/App/public/index.html'])fs.writeFileSync(path.join(dir,p),bytes);
fs.writeFileSync(path.join(dir,'BoostPlugin.swift'),native);
fs.writeFileSync(path.join(dir,'release-manifest.json'),JSON.stringify({web_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),boost_native_sha256:crypto.createHash('sha256').update(native).digest('hex'),minimum_build_number:10}));
fs.writeFileSync(path.join(dir,'ios/App/App/SceneDelegate.swift'),'import Capacitor\nclass SceneDelegate { func create(){let controller=CAPBridgeViewController()} }\n');
fs.writeFileSync(path.join(dir,'ios/App/App/capacitor.config.json'),JSON.stringify({appId:'com.ayuhide.koenofurima'}));
fs.writeFileSync(path.join(dir,'ios/App/App.xcodeproj/project.pbxproj'),'CURRENT_PROJECT_VERSION = 9;\nCURRENT_PROJECT_VERSION = 9;');
fs.writeFileSync(path.join(dir,'ios/App/App/Info.plist'),'<dict>\n</dict>\n</plist>');
fs.writeFileSync(path.join(dir,'node_modules/@capacitor/core/dist/index.js'),'// core fixture');
const script=root+'scripts/prepare-native-release.mjs';
function run(n){return cp.spawnSync(process.execPath,[script],{cwd:dir,env:{...process.env,CI_BUILD_NUMBER:n},encoding:'utf8'})}
assert.notEqual(run('9').status,0);assert.equal(run('10').status,0);assert.equal(run('10').status,0);
const scene=fs.readFileSync(path.join(dir,'ios/App/App/SceneDelegate.swift'),'utf8');assert.equal((scene.match(/public class KoeBoostPlugin/g)||[]).length,1);assert.ok(scene.includes('KoeBridgeViewController()'));
assert.equal(fs.readFileSync(path.join(dir,'ios/App/App/public/capacitor-core.js'),'utf8'),'// core fixture');
fs.appendFileSync(path.join(dir,'BoostPlugin.swift'),'changed');assert.notEqual(run('10').status,0);
fs.rmSync(dir,{recursive:true,force:true});

});
test('reviewed web/native hashes and inline JavaScript are valid',()=>{
 const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
 const root=new URL('../',import.meta.url), manifest=JSON.parse(fs.readFileSync(new URL('release-manifest.json',root),'utf8'));
 for(const [name,key] of [['index.html','web_sha256'],['BoostPlugin.swift','boost_native_sha256']])assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(name,root))).digest('hex'),manifest[key]);
 const html=fs.readFileSync(new URL('index.html',root),'utf8');
 assert.equal(html.match(/<meta name="voice-flea-release" content="([^"]+)"/)[1],manifest.release,'HTML and manifest release labels differ');
 assert.ok(Number.isSafeInteger(manifest.minimum_build_number)&&manifest.minimum_build_number>0,'Invalid minimum build number');
 assert.equal(manifest.boost_sales_enabled,false,'Boost sales require a separate reviewed launch');
 for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc\s*=/.test(m[1])&&!/type=["']application\/ld\+json/.test(m[1]))new vm.Script(m[2]);
});
