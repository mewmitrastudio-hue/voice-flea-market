import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function syncHomeViewport(home){');
const source=html.slice(start,html.indexOf('(function setupHomeViewport()',start));
const context=vm.createContext({});
vm.runInContext(source,context);
function home(height,content){
  const classes=new Set(['on']);
  return {clientHeight:height,scrollHeight:content,scrollTop:27,classes,classList:{contains:k=>classes.has(k),toggle(k,on){on?classes.add(k):classes.delete(k)}}};
}
test('a home that fits stays fixed and starts at its top',()=>{
  const h=home(450,450);h.classes.add('home-scroll-required');context.syncHomeViewport(h);
  assert.equal(h.classes.has('home-scroll-required'),false);assert.equal(h.scrollTop,0);
});
test('enlarged content remains reachable instead of being clipped',()=>{
  const h=home(450,700);context.syncHomeViewport(h);
  assert.equal(h.classes.has('home-scroll-required'),true);assert.equal(h.scrollTop,27);
});
test('after a viewport grows the home returns to the fixed arrangement',()=>{
  const h=home(350,500);context.syncHomeViewport(h);assert.equal(h.classes.has('home-scroll-required'),true);
  h.clientHeight=600;h.scrollHeight=600;context.syncHomeViewport(h);
  assert.equal(h.classes.has('home-scroll-required'),false);assert.equal(h.scrollTop,0);
});
test('a hidden home is not reset while another screen is active',()=>{
  const h=home(450,450);h.classes.delete('on');h.classes.add('home-scroll-required');context.syncHomeViewport(h);
  assert.equal(h.classes.has('home-scroll-required'),true);assert.equal(h.scrollTop,27);
});
