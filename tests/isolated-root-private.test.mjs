import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseIsolatedRootInput,prepareIsolatedRoot,parseIsolatedRootRaw,IsolatedRootUnsupported} from '../host/isolated-root-private.mjs';

// Synthetic contract cases, not an emitted Buddy frame or provider evidence.
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=n=>String(n).repeat(64);
const encode=v=>Buffer.from(JSON.stringify(v)+'\n');
const snapshot=()=>({device:id(2),epoch:id(3),
 mode:{kind:'isolated-backup',backup:id(4),binding_sha256:sha(1)},
 token:{actor:id(1),sha256:sha(2)}});
const inspect=()=>({report_version:1,operation:'inspect',status:'ok',incomplete:false,
 activation_performed:false,data:{current_snapshot:snapshot(),receipt:null,receipt_status:null}});
const original=()=>prepareIsolatedRoot(encode(inspect()),id(5));
const report=()=>({report_version:1,operation:'provision-isolated-backup',status:'ok',incomplete:false,
 activation_performed:false,data:{current_snapshot:snapshot(),receipt:null,receipt_status:null,
 isolated_root:{operation:id(5),device:id(2),backup:id(4),epoch:id(3),outcome:'root-verified',currency:'current'}}});
const mutate=(value,fn)=>{const copy=structuredClone(value);fn(copy);return copy;};

test('original Buddy command-harness frames reconcile current, historical and unqualified outcomes',()=>{
 const hashes={
  request:'3f136193bf8d82d5ecde0ff6b7cf9ca25da5c07c7bdaa6af65bfa2c9ecb1f9ee',
  unqualified:'8ae5e8aa1488c491dc3aab6a02cd8c99fa253011344b5603f74311717ff23869',
  current:'0f6fc93d371bd935bc84fb3cce017fd7dd3a70ee37a6a670c7b4f8d2239cac26',
  historical:'3c3a9749d87c0dc1268e330feaa2fa7eef2a420b27c19d22792a22ccf7780336'
 };
 const frames=Object.fromEntries(Object.entries(hashes).map(([name,hash])=>{
  const bytes=readFileSync(new URL('./fixtures/isolated-root-provisioning/'+name+'.json',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);
  return [name,bytes];
 }));
 assert.notEqual(frames.request.at(-1),10);
 const retained={input:JSON.parse(frames.request),snapshot:JSON.parse(frames.current).data.current_snapshot};
 const current=parseIsolatedRootRaw(frames.current,retained);
 assert.equal(current.result.outcome,'root-verified');
 assert.equal(current.result.currency,'current');
 assert.equal(current.current.kind,'isolated-backup');
 const historical=parseIsolatedRootRaw(frames.historical,retained);
 assert.equal(historical.result.outcome,'root-verified');
 assert.equal(historical.result.currency,'historical');
 assert.equal(historical.current.kind,'local-only');
 const unqualified=parseIsolatedRootRaw(frames.unqualified,retained);
 assert.equal(unqualified.result.outcome,'provider-binding-unqualified');
 assert.equal(unqualified.status,'unsupported');
 assert.equal(unqualified.incomplete,false);
});

test('prepare retains the exact conditional input and detached original isolated snapshot',()=>{
 const r=inspect(),o=prepareIsolatedRoot(encode(r),id(5));
 assert.deepEqual(o.input,{control_version:1,operation:id(5),expected:r.data.current_snapshot.token});
 assert.deepEqual(o.snapshot,r.data.current_snapshot);
 r.data.current_snapshot.mode.binding_sha256=sha(3);
 assert.equal(o.snapshot.mode.binding_sha256,sha(1));
 assert.deepEqual(parseIsolatedRootInput(o.input),o.input);
});

test('only an existing successfully inspected isolated choice can prepare a root',()=>{
 for(const fn of [
  v=>{v.status='unavailable';v.incomplete=true;v.data=null;},
  v=>{v.incomplete=true;},
  v=>{v.data.current_snapshot.mode={kind:'local-only'};},
  v=>{v.data.current_snapshot={...v.data.current_snapshot,device:null,epoch:null,mode:null};},
  v=>{v.data.current_snapshot.mode={kind:'shared-group',group:id(6),binding_sha256:sha(1),root_id:'private-root'};},
  v=>{v.activation_performed=true;},
  v=>{v.report_version=2;}
 ])assert.throws(()=>prepareIsolatedRoot(encode(mutate(inspect(),fn)),id(5)));
 assert.throws(()=>prepareIsolatedRoot(encode(inspect()),'00000000-0000-0000-0000-000000000000'));
});

test('private input refuses secrets, endpoint/path authority and changed schema',()=>{
 const input=original().input;
 for(const fn of [
  v=>{v.control_version=2;},v=>{v.operation='bad';},
  v=>{v.expected.sha256=sha(1).replace('1','A');},
  v=>{v.expected.actor='00000000-0000-0000-0000-000000000000';},
  v=>{v.expected.extra=true;},v=>{v.credentials={refresh_token:'synthetic-secret'};},
  v=>{v.root_id='different-root';},v=>{v.path='/tmp/credentials';},
  v=>{v.endpoint='https://example.invalid';},v=>{v.device=id(2);}
 ])assert.throws(()=>parseIsolatedRootInput(mutate(input,fn)));
});

test('current root verification returns only reduced state, never backup completion or runtime activation',()=>{
 const out=parseIsolatedRootRaw(encode(report()),original());
 assert.deepEqual(out,{status:'ok',incomplete:false,
  current:{kind:'isolated-backup',device:id(2),epoch:id(3),group:null,backup:id(4)},
  result:{device:id(2),backup:id(4),epoch:id(3),outcome:'root-verified',currency:'current'}});
 const text=JSON.stringify(out);
 for(const field of ['operation','token','actor','sha256','binding_sha256','root_id','credentials','backupReady','activation_performed'])
  assert.equal(text.includes('"'+field+'"'),false);
});

test('all explicit outcomes preserve producer status and uncertainty',()=>{
 for(const [outcome,status,incomplete] of [
  ['root-verified','ok',false],['outcome-unknown','unavailable',true],
  ['authorization-required','unavailable',true],['retry-later','unavailable',true],
  ['recovery-required','failed',true],['provider-binding-unqualified','unsupported',false]
 ]){
  const r=report();Object.assign(r,{status,incomplete});r.data.isolated_root.outcome=outcome;
  const out=parseIsolatedRootRaw(encode(r),original());
  assert.equal(out.result.outcome,outcome);assert.equal(out.status,status);assert.equal(out.incomplete,incomplete);
  assert.throws(()=>parseIsolatedRootRaw(encode({...r,incomplete:!incomplete}),original()));
  assert.throws(()=>parseIsolatedRootRaw(encode({...r,status:status==='ok'?'failed':'ok'}),original()));
 }
});

test('valid later epochs preserve historical results without accepting contradictory current evidence',()=>{
 for(const fn of [
  ()=>{},s=>{s.mode={kind:'local-only'};},
  s=>{s.mode={kind:'shared-group',group:id(6),binding_sha256:sha(3),root_id:'private-root'};},
  s=>{s.mode.backup=id(8);s.mode.binding_sha256=sha(3);}
 ]){
  const r=report();r.data.current_snapshot.epoch=id(8);r.data.current_snapshot.token.sha256=sha(3);
  fn(r.data.current_snapshot);
  assert.throws(()=>parseIsolatedRootRaw(encode(r),original()));
  r.data.isolated_root.currency='historical';
  assert.equal(parseIsolatedRootRaw(encode(r),original()).result.currency,'historical');
 }
 const r=report();r.data.isolated_root.currency='historical';
 assert.throws(()=>parseIsolatedRootRaw(encode(r),original()));
});

test('an original result requires immutable device, epoch/token agreement and backup grant continuity',()=>{
 for(const fn of [
  s=>{s.token.sha256=sha(3);},s=>{s.device=id(8);},s=>{s.mode.backup=id(8);},
  s=>{s.mode.binding_sha256=sha(3);},s=>{s.mode={kind:'local-only'};},
  s=>{s.device=null;s.epoch=null;s.mode=null;},s=>{s.epoch=id(8);},
  s=>{s.epoch=id(8);s.token.sha256=sha(3);s.mode.binding_sha256=sha(3);},
  s=>{s.epoch=id(8);s.token.sha256=sha(3);s.device=id(8);}
 ])for(const currency of ['current','historical']){
  const r=report();fn(r.data.current_snapshot);r.data.isolated_root.currency=currency;
  assert.throws(()=>parseIsolatedRootRaw(encode(r),original()));
 }
});

test('foreign operation, actor and original identifiers refuse, including historical output',()=>{
 for(const fn of [
  r=>{r.data.isolated_root.operation=id(6);},r=>{r.data.isolated_root.device=id(6);},
  r=>{r.data.isolated_root.backup=id(6);},r=>{r.data.isolated_root.epoch=id(6);},
  r=>{r.data.current_snapshot.token.actor=id(6);},
  r=>{r.data.isolated_root.currency='historical';r.data.isolated_root.backup=id(6);r.data.current_snapshot.epoch=id(7);}
 ])assert.throws(()=>parseIsolatedRootRaw(encode(mutate(report(),fn)),original()));
 for(const fn of [
  o=>{o.input.expected.actor=id(9);},o=>{o.input.expected.sha256=sha(3);},
  o=>{o.snapshot.mode={kind:'local-only'};},o=>{o.extra=true;}
 ])assert.throws(()=>parseIsolatedRootRaw(encode(report()),mutate(original(),fn)));
});

test('early refusals preserve absent custody and never manufacture a result',()=>{
 for(const status of ['invalid-input','unsupported','unavailable','busy','conflict','failed']){
  const r={...report(),status,incomplete:!['invalid-input','busy','conflict'].includes(status),data:null};
  assert.deepEqual(parseIsolatedRootRaw(encode(r),original()),
   {status,incomplete:r.incomplete,current:null,result:null});
  r.data={current_snapshot:snapshot(),receipt:null,receipt_status:null};
  assert.equal(parseIsolatedRootRaw(encode(r),original()).result,null);
 }
 assert.throws(()=>parseIsolatedRootRaw(encode({...report(),data:null}),original()));
 const r=report();delete r.data.isolated_root;
 assert.throws(()=>parseIsolatedRootRaw(encode(r),original()));
});

test('closed report/data/result schemas reject unknown authority, null result and fabricated receipts',()=>{
 for(const fn of [
  r=>{r.activation_performed=true;},r=>{r.operation='choose';},r=>{r.extra=true;},
  r=>{r.data.isolated_root=null;},r=>{r.data.receipt={operation:id(5)};},
  r=>{r.data.receipt_status='current';},r=>{r.data.control={outcome:'created'};},
  r=>{r.data.isolated_root.root_id='private-root';},r=>{r.data.isolated_root.outcome='backup-completed';},
  r=>{r.data.isolated_root.outcome=['root-verified'];},r=>{r.data.isolated_root.outcome={};},
  r=>{r.data.isolated_root.currency='fresh';},r=>{r.data.current_snapshot.mode.extra=true;}
 ])assert.throws(()=>parseIsolatedRootRaw(encode(mutate(report(),fn)),original()));
 const newer={...report(),report_version:2};
 assert.throws(()=>parseIsolatedRootRaw(encode(newer),original()),IsolatedRootUnsupported);
});

test('raw framing refuses duplicate members, malformed UTF-8, BOM, partial, multi-line and oversized output',()=>{
 const valid=encode(report());
 for(const raw of [
  valid.subarray(0,-1),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),valid]),
  Buffer.concat([valid,valid]),Buffer.from('{"report_version":1,"report_version":1}\n'),
  Buffer.from('{"a":"\xff"}\n','latin1'),Buffer.from('\n'),Buffer.alloc(16385,32)
 ])assert.throws(()=>parseIsolatedRootRaw(raw,original()));
 assert.throws(()=>parseIsolatedRootRaw(valid.toString(),original()));
 const prefix=valid.subarray(0,-1),atLimit=Buffer.concat([prefix,Buffer.alloc(16384-prefix.length-1,32),Buffer.from('\n')]);
 assert.equal(parseIsolatedRootRaw(atLimit,original()).result.outcome,'root-verified');
 assert.throws(()=>parseIsolatedRootRaw(Buffer.concat([Buffer.from(' '),atLimit]),original()));
});

test('raw decoding failures expose only a fixed redacted refusal, including preparation',()=>{
 for(const raw of [
  Buffer.from('{"private":"SYNTHETIC_SECRET_SENTINEL","bad":INVALID}\n'),
  Buffer.from('SYNTHETIC_SECRET_SENTINEL\n'),
  Buffer.from('{"private":"\xff"}\n','latin1')
 ])for(const consume of [()=>prepareIsolatedRoot(raw,id(5)),()=>parseIsolatedRootRaw(raw,original())]){
  assert.throws(consume,error=>{
   assert.equal(error.message,'Isolated backup preparation response refused');
   assert.equal(error.stack.includes('SYNTHETIC_SECRET_SENTINEL'),false);
   return true;
  });
 }
});
