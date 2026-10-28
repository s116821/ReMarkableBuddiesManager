import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SelectedArchiveHost } from '../host/selected-archive.mjs';
import { MaintenanceIO } from '../host/maintenance-io.mjs';
const v = JSON.parse(readFileSync(new URL('./fixtures/selected-archive-reference-vectors.json', import.meta.url)));
const observation = v.public_cases.find(c => c.id === 'inspected-valid').result.observation;
const uuid = n => `00000001-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
const report = (selector, summary = v.context.summary) => ({ report_version: 1, operation: selector, status: 'ok', incomplete: !summary.complete_media, activation_performed: false, data: { inspection: summary } });
function fixture(options = {}) {
  let seq = 1, ref = 1, now = 0, next = null, cancellations = 0, hooks = 0;
  const calls = [], io = new MaintenanceIO();
  const observer = { lastObservation: structuredClone(observation), cancel() { cancellations++; }, async run(action, q) {
    assert.equal(action, 'selected-archive'); const body = JSON.parse(Buffer.from(q.input_base64, 'base64')); calls.push({ selector: q.selector, body });
    const value = next; next = null; const raw = typeof value === 'function' ? await value(q) : value ?? report(q.selector);
    return { contract_version: 1, status: 'observed', observation: structuredClone(observer.lastObservation), archive_raw: { status: 'reported', stdout_base64: Buffer.from(JSON.stringify(raw) + '\n').toString('base64') } };
  } };
  const host = new SelectedArchiveHost({ observer, io, beforeIO() { hooks++; }, now: () => now, reference: () => (ref++).toString(16).padStart(64, '0'), ...options });
  const q = (action, rest = {}) => ({ action, connection_id: observation.connection_id, boot_id: observation.boot_id, invocation: uuid(seq++), ...rest });
  return { host, observer, io, calls, q, next(value) { next = value; }, time(value) { now = value; }, stats: () => ({ cancellations, hooks }) };
}
async function preview(f, path = v.context.path) { return (await f.host.request(f.q('prepare-export', { path }))).selected_archive; }
test('policy preview performs no producer I/O; exact private path, once-only export and original-only check', async () => {
  const f = fixture(), path = '/original\r\n ';
  const ready = await preview(f, path); assert.equal(ready.summary, null); assert.equal(f.calls.length, 0);
  const request = f.q('confirm-export', { reference: ready.reference });
  const result = (await f.host.request(request)).selected_archive; assert.equal(result.state, 'exported');
  assert.deepEqual(f.calls, [{ selector: 'export-selected', body: { path } }]);
  assert.equal((await f.host.request(f.q('confirm-export', { reference: ready.reference }))).selected_archive.state, 'unavailable');
  const check = (await f.host.request(f.q('check-export', { reference: ready.reference }))).selected_archive;
  assert.equal(check.state, 'archive-observed'); assert.equal(check.original_outcome, 'exported'); assert.deepEqual(f.calls[1], { selector: 'inspect', body: { path } });
  assert.equal(JSON.stringify(result).includes('original'), true); assert.equal(JSON.stringify(result).includes(path), false);
});
test('lost export output remains unknown after valid custody check, no re-export or history upgrade', async () => {
  const f = fixture(), r = await preview(f);
  f.next(() => { throw Error('lost acknowledgement'); });
  assert.equal((await f.host.request(f.q('confirm-export', { reference: r.reference }))).selected_archive.original_outcome, 'unknown');
  const check = await f.host.request(f.q('check-export', { reference: r.reference }));
  assert.equal(check.selected_archive.check_outcome, 'archive-observed'); assert.equal(check.selected_archive.original_outcome, 'unknown');
  assert.equal(f.calls.filter(c => c.selector === 'export-selected').length, 1);
});
test('known refusal and failed possibly published report remain distinct', async () => {
  for (const status of ['invalid-input', 'unavailable', 'unsupported', 'busy', 'failed']) {
    const f = fixture(), r = await preview(f); f.next({ report_version: 1, operation: 'export-selected', status, incomplete: ['unavailable', 'failed'].includes(status), activation_performed: false, data: null });
    const result = (await f.host.request(f.q('confirm-export', { reference: r.reference }))).selected_archive;
    assert.equal(result.original_outcome, status === 'failed' ? 'unknown' : 'not-dispatched'); assert.equal(result.retained.length, 1);
  }
});
test('direct format3 inspection has no original rows, failed and malformed output never empty success', async () => {
  const f = fixture(); f.next(report('inspect', { ...v.context.summary, format: 3, selected_scopes: 0, selection_receipts: 0, configuration_included: true }));
  const r = (await f.host.request(f.q('inspect', { path: '/archives/feedback' }))).selected_archive;
  assert.equal(r.state, 'inspected'); assert.equal(r.summary.format, 3); assert.equal(r.retained.length, 0);
  f.next({ report_version: 999 }); assert.equal((await f.host.request(f.q('inspect', { path: '/archives/malformed' }))).selected_archive.state, 'unavailable');
});
test('partial media is explicit for export and check; failed check does not prove rollback', async () => {
  const f = fixture(), r = await preview(f); f.next(report('export-selected', { ...v.context.summary, complete_media: false }));
  assert.equal((await f.host.request(f.q('confirm-export', { reference: r.reference }))).selected_archive.state, 'partial-media');
  f.next({ report_version: 1, operation: 'inspect', status: 'unsupported', incomplete: false, activation_performed: false, data: null });
  const checked = (await f.host.request(f.q('check-export', { reference: r.reference }))).selected_archive;
  assert.equal(checked.state, 'unresolved'); assert.equal(checked.original_outcome, 'partial-media');
});
test('ready expiry, nonrenewing original expiry, expired safe row with room, and eight distinct rows full', async () => {
  const f = fixture(); let r = await preview(f); f.time(120000);
  assert.equal((await f.host.request(f.q('confirm-export', { reference: r.reference }))).selected_archive.state, 'unavailable');
  for (let i = 0; i < 8; i++) { r = await preview(f, `/backup/${i}`); await f.host.request(f.q('confirm-export', { reference: r.reference })); if (i === 0) { f.time(120000 + 1800000); const check = (await f.host.request(f.q('check-export', { reference: r.reference }))).selected_archive; assert.equal(check.state, 'unavailable'); assert.equal(check.retained[0].expired, true); } }
  const retained = (await f.host.request({ action: 'retained' })).selected_archive.retained;
  assert.equal(retained.length, 8); assert.equal(new Set(retained.map(r => r.reference)).size, 8);
  const calls = f.calls.length; assert.equal((await preview(f)).state, 'capacity'); assert.equal(f.calls.length, calls);
});
test('Busy precedes hooks and cancellation; other owner preserved', async () => {
  const f = fixture(), owner = f.io.acquire('peer', 'p', 'action');
  const r = await preview(f); assert.equal(r.state, 'busy'); assert.equal(f.stats().hooks, 0); assert.equal(f.stats().cancellations, 0); assert.equal(f.io.owns(owner), true);
});
test('prearrival exact-invocation cancel fences dispatch without touching new invocation', async () => {
  const f = fixture(), q = f.q('inspect', { path: '/backup/a' });
  await assert.rejects(f.host.request({ ...q, action: 'cancel', path: undefined, reference: null })); // Unknown keys refuse even when undefined.
  const { path, ...identity } = q; void path;
  await f.host.request({ ...identity, action: 'cancel', reference: null });
  assert.equal((await f.host.request(q)).selected_archive.state, 'invalidated'); assert.equal(f.calls.length, 0);
  assert.equal((await f.host.request(f.q('inspect', { path: '/backup/b' }))).selected_archive.state, 'inspected');
});
test('active canceled export stays unknown and stale cancel cannot release successor', async () => {
  const f = fixture(), r = await preview(f); let finish;
  const original = f.q('confirm-export', { reference: r.reference });
  f.next(() => new Promise(resolve => { finish = resolve; })); const pending = f.host.request(original);
  await Promise.resolve(); assert.equal(typeof finish, 'function');
  const canceled = await f.host.request({ ...original, action: 'cancel' }); assert.equal(canceled.selected_archive.original_outcome, 'unknown');
  const owner = f.io.acquire('successor', 'new', 'read'); await f.host.request({ ...original, action: 'cancel' }); assert.equal(f.io.owns(owner), true);
  finish(report('export-selected')); assert.equal((await pending).selected_archive.original_outcome, 'unknown'); f.io.release(owner);
});
test('bounded invocation ledger never renews original or invokes a thirty-third action', async () => {
  const f = fixture(), r = await preview(f); await f.host.request(f.q('confirm-export', { reference: r.reference }));
  for (let i = 0; i < 30; i++) await f.host.request(f.q('check-export', { reference: r.reference }));
  const calls = f.calls.length; assert.equal((await f.host.request(f.q('check-export', { reference: r.reference }))).selected_archive.state, 'unavailable'); assert.equal(f.calls.length, calls);
});
test('private original input corruption refuses before dispatch and never reconstructs from a path', async () => {
  for (const retained of [false,true]) {
    const f=fixture(),from=Buffer.from,packets=[];let r;
    Buffer.from=function(value,...args){const b=from.call(this,value,...args);if(typeof value==='string'&&value.startsWith('{"path":'))packets.push(b);return b;};
    try{r=await preview(f);}finally{Buffer.from=from;}
    if(retained){f.next(()=>{throw Error('lost');});await f.host.request(f.q('confirm-export',{reference:r.reference}));}
    assert.equal(packets.length,1);packets[0][12]^=1;const before=f.calls.length;
    const result=(await f.host.request(f.q(retained?'check-export':'confirm-export',{reference:r.reference}))).selected_archive;
    assert.equal(result.state,'unavailable');assert.equal(f.calls.length,before);if(retained)assert.equal(result.original_outcome,'unknown');f.host.invalidate();
  }
});
test('reference-scoped prearrival cancel cannot fence a different reference using the same invocation',async()=>{
 const f=fixture(),a=await preview(f),old=f.q('cancel',{reference:a.reference});await f.host.request(old);
 const b=await preview(f,'/backup/other');const result=await f.host.request({...old,action:'confirm-export',reference:b.reference});
 assert.equal(result.selected_archive.state,'exported');assert.equal(f.calls.length,1);
});
test('absolute host timeout retains unknown original and a late success cannot settle or release a successor',async()=>{
 const f=fixture({budgetMs:5}),r=await preview(f);let finish;f.next(()=>new Promise(resolve=>{finish=resolve;}));
 const result=await f.host.request(f.q('confirm-export',{reference:r.reference}));assert.equal(result.selected_archive.original_outcome,'unknown');assert.equal(f.stats().cancellations,1);
 const token=f.io.acquire('next','owner','read');finish(report('export-selected'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.io.owns(token),true);
 assert.equal((await f.host.request({action:'retained'})).selected_archive.retained[0].original_outcome,'unknown');f.io.release(token);
});

test('repeated prearrival cancellation does not renew its absolute fence deadline',async()=>{
 const f=fixture(),q=f.q('inspect',{path:'/backup/fenced'}),cancel={action:'cancel',connection_id:q.connection_id,boot_id:q.boot_id,invocation:q.invocation,reference:null};
 await f.host.request(cancel);f.time(13000);await f.host.request({...cancel});f.time(14000);
 assert.equal((await f.host.request(q)).selected_archive.state,'inspected');assert.equal(f.calls.length,1);
});

test('known-reference prearrival cancellation remains fenced in original ledger after session-fence expiry',async()=>{
 const f=fixture(),r=await preview(f);await f.host.request(f.q('confirm-export',{reference:r.reference}));
 const future=f.q('check-export',{reference:r.reference});await f.host.request({...future,action:'cancel'});f.time(15000);
 const calls=f.calls.length;const result=(await f.host.request(future)).selected_archive;assert.equal(result.state,'unavailable');assert.equal(f.calls.length,calls);assert.equal(result.retained[0].original_outcome,'exported');
});
