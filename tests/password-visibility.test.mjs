import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('// PASSWORD_VISIBILITY_BEGIN'),html.indexOf('// PASSWORD_VISIBILITY_END'));
function fixture(){
 const events={window:{},document:{}},attrs={},selectionCalls=[];
 let field={type:'text',value:'synthetic-autofill',selectionStart:2,selectionEnd:5,selectionDirection:'forward',setSelectionRange(...s){selectionCalls.push(s);[this.selectionStart,this.selectionEnd,this.selectionDirection]=s;}},button={setAttribute:(k,v)=>attrs[k]=v};
 const control={contains:el=>el===field||el===button};
 const document={activeElement:field,getElementById:id=>({password:field,passwordVisibility:button,passwordControl:control})[id],addEventListener:(name,fn,capture)=>events.document[name]={fn,capture}};
 const c=vm.createContext({document,window:{addEventListener:(name,fn)=>events.window[name]=fn}});vm.runInContext(source,c);
 return {c,events,attrs,document,selectionCalls,get field(){return field;},get button(){return button;},replace(){field={...field,type:'text'};return field;},removeButton(){button=null}};
}
test('markup defaults masked and preserves password autofill semantics with an accessible non-submit eye button',()=>{
 const input=html.match(/<input\b[^>]*id="password"[^>]*>/)[0],button=html.match(/<button\b[^>]*id="passwordVisibility"[^>]*>/)[0];
 assert.match(input,/type="password"/);assert.match(input,/autocomplete="current-password"/);assert.match(input,/autocapitalize="none"/);assert.match(input,/spellcheck="false"/);assert.match(button,/type="button"/);assert.match(button,/aria-controls="password"/);assert.match(button,/aria-pressed="false"/);assert.match(button,/aria-label="パスワードを表示"/);assert.match(html,/画面共有・録画中はパスワードを表示しない/);assert.match(html,/\.password-control button:focus-visible/);
});
test('initialization masks restored text type; only explicit toggle reveals with matching accessible state',()=>{
 const f=fixture();assert.equal(f.field.type,'password');assert.equal(f.attrs['aria-pressed'],'false');f.c.togglePasswordVisibility();assert.equal(f.field.type,'text');assert.equal(f.attrs['aria-pressed'],'true');assert.equal(f.attrs['aria-label'],'パスワードを隠す');f.c.togglePasswordVisibility();assert.equal(f.field.type,'password');assert.equal(f.attrs['aria-label'],'パスワードを表示');
});
test('toggle preserves autofilled value, focused field and caret/selection without moving keyboard focus',()=>{
 const f=fixture(),value=f.field.value,active=f.document.activeElement;f.c.togglePasswordVisibility();assert.equal(f.field.value,value);assert.equal(f.document.activeElement,active);assert.deepEqual([f.field.selectionStart,f.field.selectionEnd,f.field.selectionDirection],[2,5,'forward']);assert(f.selectionCalls.length>=2);f.document.activeElement=f.button;const calls=f.selectionCalls.length;f.c.togglePasswordVisibility();assert.equal(f.document.activeElement,f.button);assert.equal(f.selectionCalls.length,calls);
});
test('pointer eye tap retains input focus only when input already focused; keyboard/button focus is not hijacked',()=>{
 const f=fixture();let prevented=0;f.c.keepPasswordFocus({preventDefault(){prevented++}});assert.equal(prevented,1);f.document.activeElement=f.button;f.c.keepPasswordFocus({preventDefault(){prevented++}});assert.equal(prevented,1);
});
test('leaving control masks; moving between field and eye does not unexpectedly reset explicit visibility',()=>{
 const f=fixture();f.c.togglePasswordVisibility();f.c.passwordFocusOut({relatedTarget:f.button});assert.equal(f.field.type,'text');f.c.passwordFocusOut({relatedTarget:{}});assert.equal(f.field.type,'password');f.c.togglePasswordVisibility();f.c.passwordFocusOut({relatedTarget:null});assert.equal(f.field.type,'password');
});
test('blur, hide, return and visibility change always reset display without reading or deleting field value',()=>{
 const f=fixture();for(const name of ['blur','pagehide','pageshow']){f.c.togglePasswordVisibility();f.events.window[name]();assert.equal(f.field.type,'password');assert.equal(f.attrs['aria-pressed'],'false');}f.c.togglePasswordVisibility();f.events.document.visibilitychange.fn();assert.equal(f.field.type,'password');assert.equal(f.field.value,'synthetic-autofill');
});
test('form submit capture masks before handling and does not submit or cancel a form itself',()=>{
 const f=fixture();f.c.togglePasswordVisibility();let prevented=false;f.events.document.submit.fn({target:{contains:el=>el===f.field},preventDefault(){prevented=true}});assert.equal(f.field.type,'password');assert.equal(f.events.document.submit.capture,true);assert.equal(prevented,false);
});
test('auth rerender, private reset, login and signup hide before any validation or async work',()=>{
 for(const signature of ['async function renderAuth(){','async function signIn(){','async function signUp(){']){const start=html.indexOf(signature);assert(start>=0);assert.match(html.slice(start+signature.length,start+signature.length+100),/^if\(typeof hidePasswordVisibility==='function'\)hidePasswordVisibility\(\);/);}
 const f=fixture();f.c.togglePasswordVisibility();
 const resetPrefix=html.slice(html.indexOf('function resetPrivateUI(){')+'function resetPrivateUI(){'.length,html.indexOf(' resetAppleFinancialReport();',html.indexOf('function resetPrivateUI(){')));
 vm.runInContext(resetPrefix,f.c);assert.equal(f.field.type,'password');
 f.replace();f.c.hidePasswordVisibility();assert.equal(f.field.type,'password');assert.equal(f.field.value,'synthetic-autofill');
});
test('login sends original credential only through unchanged SDK while masking before SDK call',async()=>{
 const f=fixture();f.c.togglePasswordVisibility();const calls=[];Object.assign(f.c,{email:{value:'synthetic@example.invalid',checkValidity:()=>true},password:f.field,sb:{auth:{signInWithPassword:async()=>{calls.push(f.field.type);return {error:{message:'synthetic-error'}}}}},info:()=>calls.push('error'),resetLoginZoom:()=>calls.push('zoom')});const code=html.slice(html.indexOf('async function signIn(){'),html.indexOf('// Account deletion must'));vm.runInContext(code,f.c);await f.c.signIn();assert.deepEqual(calls,['password','error']);assert.equal(f.field.value,'synthetic-autofill');
});
test('autofill change/focus handlers hide; missing button still permits safe masking and never reveal',()=>{
 const f=fixture();assert.match(html.match(/<input\b[^>]*id="password"[^>]*>/)[0],/onchange="hidePasswordVisibility\(\)"/);assert.match(html,/onfocus="hidePasswordVisibility\(\)"/);f.c.togglePasswordVisibility();f.removeButton();f.c.hidePasswordVisibility();assert.equal(f.field.type,'password');f.c.togglePasswordVisibility();assert.equal(f.field.type,'password');
});
test('visibility helper never reads credential value or logs, stores, transmits or installs observers on it',()=>{
 assert.doesNotMatch(source,/\.value\b|console\.|localStorage|sessionStorage|fetch\(|functions\.invoke|signInWithPassword|MutationObserver/);assert.doesNotMatch(source,/\.focus\(/);
});

test('logout masks immediately before pending, rejected, repeated or missing-SDK exits',async()=>{
 for(const mode of ['pending','rejected','already-pending','no-sdk']){
  const f=fixture();f.c.togglePasswordVisibility();let complete;
  const sdk={auth:{signOut:mode==='pending'?()=>new Promise(r=>complete=r):async()=>({error:{message:'synthetic-rejection'}})}};
  Object.assign(f.c,{signOutPending:mode==='already-pending',currentUser:null,console:{warn(){}},alert(){},sb:mode==='no-sdk'?null:sdk});
  vm.runInContext(html.slice(html.indexOf('async function signOut(){'),html.indexOf('const pendingTradeState=')),f.c);
  const run=f.c.signOut();assert.equal(f.field.type,'password');assert.equal(f.attrs['aria-pressed'],'false');
  if(complete)complete({error:{message:'synthetic-rejection'}});await run;assert.equal(f.field.type,'password');
 }
});
