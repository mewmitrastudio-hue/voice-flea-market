import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('public sample selector is audio-only on iOS',()=>{
 const html=readFileSync('index.html','utf8');
 const field=html.match(/<input id="sellAudio"[^>]+>/);
 assert.ok(field,'listing audio picker missing');
 assert.match(field[0],/accept="audio\/\*/);
 assert.doesNotMatch(field[0],/\.mp4|video\/\*/);

});

test('delivery audio selector does not offer video camera capture',()=>{
 const html=readFileSync('index.html','utf8');
 const field=html.match(/<input id="deliveryFile"[^>]+>/);
 assert.ok(field,'delivery audio picker missing');
 assert.doesNotMatch(field[0],/\.mp4|video\/\*/);
});

test('release manifest is newer than rejected build 54',()=>{
 const manifest=JSON.parse(readFileSync('release-manifest.json','utf8'));
 assert.ok(manifest.minimum_build_number>54);
});

test('sample and delivery share audio checks and reject video or ambiguous uploads',()=>{
 const html=readFileSync('index.html','utf8');
 const source=html.slice(html.indexOf('function audioUploadMetadata('),html.indexOf('async function createListing('));
 const context=vm.createContext({});
 vm.runInContext(source,context);
 const metadata=context.audioUploadMetadata;
 assert.equal(metadata({name:'sample.mp4',type:'audio/mp4'}).contentType,'audio/mp4');
 assert.equal(metadata({name:'sample.m4a',type:''}).contentType,'audio/mp4');
 assert.equal(metadata({name:'voice.wav',type:'application/octet-stream'}).contentType,'audio/wav');
 for(const file of [
  {name:'movie.mp4',type:'video/mp4'},
  {name:'movie.mp4',type:''},
  {name:'picture.wav',type:'image/png'},
  {name:'movie.webm',type:''}
 ])assert.equal(metadata(file),null);
 for(const entry of ['createListing','uploadDelivery']){
  const start=html.indexOf('async function '+entry+'(');
  assert.match(html.slice(start,html.indexOf('\n}',start)),/audioUploadMetadata\(/);
 }
});
