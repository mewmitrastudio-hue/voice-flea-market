import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('iOS review camera microphone and photo picker permissions remain configured', () => {
  const plist = fs.readFileSync('ios/App/App/Info.plist', 'utf8');
  const expected = [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription',
  ];
  for (const key of expected) {
    const match = plist.match(new RegExp('<key>' + key + '<\\/key>\\s*<string>([^<]+)<\\/string>'));
    assert.ok(match, key + ' must have a non-empty privacy usage description');
    assert.ok(match[1].trim().length >= 10, key + ' description should explain use');
  }
  const preparer = fs.readFileSync('scripts/prepare-native-release.mjs', 'utf8');
  assert.ok(preparer.includes("const plist='ios/App/App/Info.plist'"), 'release must use checked Info.plist');
  assert.ok(!preparer.includes('NSCameraUsageDescription'), 'release preparation must not overwrite usage description');
  const web = fs.readFileSync('index.html', 'utf8');
  assert.match(web, /id="sellAudio"[^>]*type="file"/, 'recording attachment entry must remain available');
});
