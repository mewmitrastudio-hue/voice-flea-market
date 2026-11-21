import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

test('iPad camera capture and media selection usage descriptions are present', () => {
  const plist = fs.readFileSync('ios/App/App/Info.plist', 'utf8');
  for (const name of ['NSCameraUsageDescription','NSMicrophoneUsageDescription','NSPhotoLibraryUsageDescription']) {
    const match = plist.match(new RegExp('<key>' + name + '<\\/key>\\s*<string>([^<]+)<\\/string>'));
    assert.ok(match, 'Missing ' + name);
    assert.ok(match[1].trim().length > 10, 'Blank/short purpose for ' + name);
  }
  assert.match(plist, /<key>SKIncludeConsumableInAppPurchaseHistory<\/key>\s*<true\s*\/>/);
});

test('Info.plist remains syntactically valid XML', () => {
  const result=spawnSync('python3',['-c', 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])','ios/App/App/Info.plist'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
