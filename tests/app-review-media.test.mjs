import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('public sample selector is audio-only on iOS',()=>{
 const html=readFileSync('index.html','utf8');
 const field=html.match(/<input id="sellAudio"[^>]+>/);
 assert.ok(field,'listing audio picker missing');
 assert.match(field[0],/accept="audio\/\*/);
 assert.doesNotMatch(field[0],/\.mp4|video\/\*/);
 assert.match(html,/mime\.startsWith\('video\/'\)/,'video uploads must be rejected');
 assert.match(html,/ext==='mp4'&&!mime\.startsWith\('audio\/'\)/,'untyped MP4 video must be rejected');
});

test('delivery audio selector does not offer video camera capture',()=>{
 const html=readFileSync('index.html','utf8');
 const field=html.match(/<input id=\\"deliveryFile\\"[^>]+>/);
 assert.ok(field,'delivery audio picker missing');
 assert.doesNotMatch(field[0],/\.mp4|video\/\*/);
});

test('release manifest is newer than previously rejected build 53',()=>{
 const manifest=JSON.parse(readFileSync('release-manifest.json','utf8'));
 assert.ok(manifest.minimum_build_number>53);
});
