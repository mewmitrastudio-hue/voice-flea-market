import {verifyRecordingConfig} from './verify-recording-config.mjs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(readFileSync('release-manifest.json','utf8'));
const source = readFileSync('index.html');
verifyRecordingConfig(source,readFileSync('BoostPlugin.swift'),manifest);
for (const path of ['www/index.html', 'ios/App/App/public/index.html']) {
  assert.ok(source.equals(readFileSync(path)), `${path} differs from the WEB source`);
}
const config = JSON.parse(readFileSync('ios/App/App/capacitor.config.json', 'utf8'));
assert.equal(config.appId, 'com.ayuhide.koenofurima');
assert.ok(!config.server?.url, 'Release must bundle the web source');
console.log(`iOS bundle matches WEB: ${createHash('sha256').update(source).digest('hex')}`);

assert.match(readFileSync('ios/App/App/Info.plist','utf8'),/<key>SKIncludeConsumableInAppPurchaseHistory<\/key>\s*<true\s*\/>/);
