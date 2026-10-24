import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const op='00000000-0000-4000-8000-000000000001',member='00000000-0000-4000-8000-000000000002';
test('edited mail drafts lose send authority and account changes discard old mail responses',async()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');const nodes=new Map(['noticeMailSubject','noticeMailBody','noticeMailTest','noticeMailSend','noticeDraftStatus','adminMailMsg'].map(x=>[x,{value:'',textContent:'',disabled:false,setAttribute(){}}]));
 const c={currentUser:{id:op},isVoiceFleaAdmin:()=>c.currentUser?.id===op,document:{getElementById:id=>nodes.get(id),querySelectorAll:()=>[]},info(){},Error,Number,String,esc:String};vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('let adminMailRevision='),html.indexOf('function closeAdminDashboard()'))+'\nthis.setDraft=x=>noticeMailDraft=x;this.getDraft=()=>noticeMailDraft;',c);
 nodes.get('noticeMailSubject').value='Saved';nodes.get('noticeMailBody').value='Body';c.setDraft({id:'draft',subject:'Saved',body:'Body',recipient_count:2,test_state:'accepted'});c.updateNoticeMailControls();assert.equal(nodes.get('noticeMailSend').disabled,false);nodes.get('noticeMailBody').value='Edited';c.invalidateMailDraft();assert.equal(nodes.get('noticeMailSend').disabled,true);assert.equal(c.getDraft(),null);
 let resolve;c.sb={functions:{invoke:()=>new Promise(r=>resolve=r)}};const pending=c.appMailRequest('overview');c.currentUser={id:member};resolve({data:{jobs:[]},error:null});await assert.rejects(pending,/アカウントが変わりました/);
});
