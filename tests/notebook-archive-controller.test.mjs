import {test} from 'node:test';import assert from 'node:assert/strict';
import {NotebookArchiveController,archiveAttemptMessage} from '../src/notebook-archive.ts';
import {conversationFixture} from './fixtures/conversation-inventory.mjs';import {addManagementFixture} from './fixtures/conversation-management.mjs';import {addRestoreFixture,defer} from './fixtures/ordinary-restore.mjs';import {addNotebookFixture,tablet,archivePath} from './fixtures/notebook-archive.mjs';
const pause=async()=>true;
function open(){const f=addNotebookFixture(addRestoreFixture(addManagementFixture(conversationFixture())));let dom='';const c=new NotebookArchiveController(()=>{},()=>{dom='';});return {...f,c,adapter:{notebookArchive:q=>f.selected.request(q)},input(value=archivePath){dom=value;c.setDraft(value);},dom:()=>dom};}
async function ready(f){f.input();await f.c.prepare(f.adapter,tablet,pause);assert.equal(f.c.state.view.state,'ready');}
test('protected draft/DOM clears before await; policy preview has no producer call or count',async()=>{const f=open(),gate=defer();f.input('/home/root/backups/opaque\r\n ');const pending=f.c.prepare(f.adapter,tablet,()=>gate.promise);assert.equal(f.dom(),'');assert.equal(f.c.state.draft,'');assert.equal(f.calls.length,0);gate.resolve(true);await pending;assert.equal(f.c.state.view.summary,null);assert.equal(f.calls.length,0);await f.c.confirm(f.adapter,tablet,pause);assert.equal(f.calls[0].body.path,'/home/root/backups/opaque\r\n ');assert.equal(f.c.state.retained[0].original_outcome,'unknown');f.c.dispose();});
test('lost export remains unknown after successful check and forged consistent upgrade is rejected',async()=>{const f=open();await ready(f);await f.c.confirm(f.adapter,tablet,pause);const original=structuredClone(f.c.state.retained[0]);await f.c.check(f.adapter,tablet,original,pause);assert.equal(f.c.state.view.check_outcome,'archive-observed');assert.equal(f.c.state.retained[0].original_outcome,'unknown');assert.match(archiveAttemptMessage(f.c.state.view.original_outcome),/unconfirmed/);await f.c.check({notebookArchive:async q=>{const r=await f.adapter.notebookArchive(q);r.notebook_archive.original_outcome='exported';r.notebook_archive.retained.find(row=>row.reference===original.reference).original_outcome='exported';return r;}},tablet,original,pause);assert.equal(f.c.state.view,null);assert.equal(f.c.state.retained[0].original_outcome,'unknown');assert.equal(f.calls.filter(c=>c.selector==='export-notebook').length,1);f.c.dispose();});
test('queued stop and expiry cannot dispatch late producer work',async t=>{t.mock.timers.enable({apis:['setTimeout']});for(const stop of [true,false]){const f=open(),gate=defer();f.input();const pending=f.c.inspect(f.adapter,tablet,()=>gate.promise);if(stop)await f.c.stop(f.adapter);else t.mock.timers.tick(14001);await Promise.resolve();gate.resolve(true);await pending;assert.equal(f.calls.length,0);assert.equal(f.c.state.busy,false);f.c.dispose();}});
test('Busy speculative original retires; genuine row/history and nonrenewing expiry stay',async t=>{t.mock.timers.enable({apis:['setTimeout']});const f=open();await ready(f);await f.c.confirm(f.adapter,tablet,pause);const old=structuredClone(f.c.state.retained[0]);await ready(f);const owner=f.io.acquire('peer','held','read');await f.c.confirm(f.adapter,tablet,pause);assert.equal(f.c.state.view.state,'busy');assert.deepEqual(f.c.state.retained,[old]);f.io.release(owner);t.mock.timers.tick(1800001);assert.equal(f.c.state.retained[0].expired,true);f.c.dispose();});
test('ready Stop targets original creator and never exports; unknown input is not reconstructed',async()=>{const f=open();await ready(f);await f.c.stop(f.adapter);assert.equal(f.c.state.view.state,'invalidated');assert.equal(f.calls.length,0);assert.equal(f.c.state.draft,'');f.c.dispose();});
test('protected text edit refuses malformed/oversized values without truncating; CRLF display is normalized',()=>{const f=open();f.c.paste(0,0,'/a\r\nb');assert.equal(f.c.state.draft,'/a\r\nb');assert.equal(f.c.text(),'/a\nb');assert.equal(f.c.paste(0,0,'\ud800'),false);assert.equal(f.c.valid(),false);f.c.setDraft(archivePath);assert.equal(f.c.paste(0,0,'x'.repeat(4097)),false);assert.equal(f.c.state.draft,archivePath);f.c.dispose();});

test('stopped check preserves completed export and describes only the current read wait',async()=>{
 const f=open();f.notebookState.failExport=false;await ready(f);await f.c.confirm(f.adapter,tablet,pause);
 const row=structuredClone(f.c.state.retained[0]),gate=defer();f.notebookState.onRaw=async(r,q)=>{if(q.selector==='inspect-notebook')await gate.promise;return r;};
 const pending=f.c.check(f.adapter,tablet,row,pause);await Promise.resolve();await Promise.resolve();await f.c.stop(f.adapter);
 assert.match(f.c.state.status,/Earlier export results are unchanged/);assert.equal(f.c.state.retained[0].original_outcome,'exported');gate.resolve();await pending;assert.equal(f.c.state.retained[0].original_outcome,'exported');f.c.dispose();
});

for(const action of ['inspect','check'])test(`lost ${action} cancellation acknowledgement preserves export history and rejects late UI`,async()=>{
 const f=open();f.notebookState.failExport=false;await ready(f);await f.c.confirm(f.adapter,tablet,pause);
 const row=structuredClone(f.c.state.retained[0]),entered=defer(),gate=defer();
 f.notebookState.onRaw=async(r,q)=>{if(q.selector==='inspect-notebook'){entered.resolve();await gate.promise;}return r;};
 const adapter={notebookArchive:async q=>{if(q.action==='cancel')throw Error('Lost cancellation acknowledgement');return f.adapter.notebookArchive(q);}};
 f.input();const pending=action==='inspect'?f.c.inspect(adapter,tablet,pause):f.c.check(adapter,tablet,row,pause);
 try{
  await entered.promise;await f.c.stop(adapter);
  assert.match(f.c.state.status,/check may finish/);assert.match(f.c.state.status,/Earlier export results are unchanged/);
  assert.doesNotMatch(f.c.state.status,/export may/i);assert.equal(f.c.state.busy,false);assert.deepEqual(f.c.state.retained,[row]);
  const stopped=structuredClone(f.c.state);gate.resolve();await pending;
  assert.deepEqual(f.c.state,stopped);assert.equal(f.calls.filter(c=>c.selector==='export-notebook').length,1);
 }finally{gate.resolve();await pending;f.c.dispose();}
});
