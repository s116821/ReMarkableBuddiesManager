import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {restorePathHash} from '../host/ordinary-restore-private.mjs';
import {WiredObserver} from '../host/observer.mjs';import {OrdinaryRestoreHost} from '../host/ordinary-restore.mjs';import {tablet,identity,source} from './fixtures/ordinary-restore.mjs';
const vectors=JSON.parse(await readFile(new URL('./fixtures/ordinary-restore-reference-vectors.json',import.meta.url),'utf8')),wire=vectors.raw_cases.find(x=>x.id==='prepared-valid-target-media-differs-from-source').stdout_utf8;

test('supervised child loss cannot authorize private destination deletion', {timeout: 15000}, async t => {
 const prepared = JSON.parse(wire);
 const root = source;
 prepared.data.intent.source_path_sha256 = restorePathHash('source', root + '/data');
 prepared.data.preview.source.configuration_included = false;
 prepared.data.preview.target.configuration_included = false;
 prepared.data.intent.staged_configuration_sha256 = null;
 const encode = report => Buffer.from(report).toString('base64');
 const preparedBytes = encode(JSON.stringify(prepared) + '\n');
 const malformedBytes = encode('{"report_version":1}\n');
 for (const selector of ['prepare', 'apply']) {
  for (const mode of ['exit', 'timeout', 'malformed', 'unavailable', 'unsupported']) {
   await t.test(selector + '-' + mode, async t => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-restore-reader-'));
    t.after(() => rm(folder, {recursive: true, force: true}));
    const record = path.join(folder, 'selectors');
    await writeFile(path.join(folder, 'ordinary_restore_transport.py'), `
      const fs = require('node:fs');
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', bytes => { input += bytes; });
      process.stdin.on('end', () => {
        const {selector} = JSON.parse(input);
        fs.appendFileSync(${JSON.stringify(record)}, selector + '\\n');
        const failure = selector === ${JSON.stringify(selector)} ? ${JSON.stringify(mode)} : null;
        if (failure === 'exit') { process.exitCode = 3; return; }
        if (failure === 'timeout') { setInterval(() => {}, 1000); return; }
        const unreported = failure === 'unavailable' || failure === 'unsupported';
        const stdout_base64 = unreported ? null : failure === 'malformed' ? ${JSON.stringify(malformedBytes)} : ${JSON.stringify(preparedBytes)};
        process.stdout.write(JSON.stringify({contract_version: 1, status: 'observed', observation: ${JSON.stringify(tablet)},
          ordinary_restore_raw: {status: unreported ? failure : 'reported', stdout_base64}}));
      });
    `);
    const observer = new WiredObserver({config: path.join(folder, 'synthetic'), python: process.execPath,
     script: path.join(folder, 'wired_observer.py'), timeoutMs: 1500});
    observer.lastObservation = structuredClone(tablet);
    const host = new OrdinaryRestoreHost({observer, uuid: () => vectors.context.operation});
    let releases = 0;
    const result = await host.prepareHandoff(identity, async consume => {
     await consume({signal: new AbortController().signal, timeoutMs: 12000, files: [],
      inspection: {markerSha256: 'a'.repeat(64), completeMedia: prepared.data.preview.source.complete_media},
      components: {data: {sha256: prepared.data.intent.archive_sha256}}});
     return {status: 'handed-off', cleanupPending: false};
    }, async () => ({root, assertOwned: async () => true, async release() { releases++; return true; }}));
    if (selector === 'prepare') {
     assert.equal(result.status, 'unavailable');
     assert.equal(result.preview, null);
     assert.equal(result.cleanupPending, true);
    } else {
     assert.equal(result.status, 'ready');
     const {reference} = result.preview.ordinary_restore;
     const reply = await host.request({action: 'confirm', ...identity, reference, invocation: randomUUID()});
     assert.equal(reply.ordinary_restore.state, 'unknown');
     assert.equal(reply.ordinary_restore.retained[0].reference, reference);
    }
    const disposal = host.dispose();
    assert.equal(host.dispose(), disposal);
    assert.equal(await disposal, true);
    assert.equal(releases, 0);
    assert.equal((await readFile(record, 'utf8')).trim(), selector === 'prepare' ? 'prepare' : 'prepare\napply');
   });
  }
 }
});

test('actual supervised restore child exact24576/over/duplicate/identity/exit/timeout with private stdin only',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'manager-conversation-child-'));t.after(()=>rm(folder,{recursive:true,force:true}));const record=path.join(folder,'requests'),script=path.join(folder,'ordinary_restore_transport.py');
 for(const mode of ['exact','over','duplicate','identity','exit','timeout']){
  await writeFile(script,`const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(record)},body+'\\n');const mode=${JSON.stringify(mode)};if(mode==='timeout'){setInterval(()=>{},1000);return;}if(mode==='exit'){process.stderr.write('PRIVATE_CHILD');process.stdout.write('PRIVATE_CHILD');process.exitCode=3;return;}const sample=${JSON.stringify(tablet)};if(mode==='identity')sample.boot_id='99999999-9999-4999-8999-999999999999';let output=JSON.stringify({contract_version:1,status:'observed',observation:sample,ordinary_restore_raw:{status:'reported',stdout_base64:${JSON.stringify(Buffer.from(wire).toString('base64'))}}});if(mode==='duplicate')output=output.replace('"contract_version":1','"contract_version":1,"contract_version":1');if(mode==='exact'||mode==='over')output+=' '.repeat((mode==='exact'?24576:24577)-Buffer.byteLength(output));process.stdout.write(output);});`);
  const observer=new WiredObserver({config:path.join(folder,'synthetic'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:mode==='timeout'?1500:13000});observer.lastObservation=structuredClone(tablet);const h=new OrdinaryRestoreHost({observer,uuid:()=>vectors.context.operation}),v=await h.request({action:'prepare',...identity,source,invocation:randomUUID()});assert.equal(v.ordinary_restore.state,mode==='exact'?'ready':'unavailable',mode);assert.equal(JSON.stringify(v).includes('PRIVATE_CHILD'),false);h.invalidate();
 }
 for(const line of (await readFile(record,'utf8')).trim().split('\n')){const q=JSON.parse(line);assert.deepEqual(Object.keys(q).sort(),['boot_id','budget_ms','connection_id','input_base64','selector']);assert.equal(q.selector,'prepare');assert.ok(q.budget_ms>=1&&q.budget_ms<=12000);assert.deepEqual(JSON.parse(Buffer.from(q.input_base64,'base64')),{restore_version:1,operation:vectors.context.operation,source});}
});


test('supervised stage joins a backpressured writer before the latest observer successor can spawn', {timeout: 9000}, async t => {
 const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-wired-stage-join-'));
 t.after(() => rm(folder, {recursive: true, force: true}));
 const trace = path.join(folder, 'successors');
 await writeFile(path.join(folder, 'isolated_stage_transport.py'),
  "process.stdout.write('RE' + 'ADY\\n'); process.stdin.pause(); setInterval(() => {}, 1000);");
 await writeFile(path.join(folder, 'wired_observer.py'),
  'require("node:fs").appendFileSync(' + JSON.stringify(trace) + ', "observe\\n");' +
  'process.stdout.write(' + JSON.stringify(JSON.stringify({contract_version: 1, status: 'observed', observation: tablet})) + ');');
 const observer = new WiredObserver({config: path.join(folder, 'fixture'), python: process.execPath,
  script: path.join(folder, 'wired_observer.py')});
 const issuing = Promise.withResolvers(), stopped = Promise.withResolvers(), drain = Promise.withResolvers();
 t.after(() => { drain.resolve(); observer.cancel(); });
 const controller = new AbortController(), deadline = performance.now() + 5000;
 let accepted = 0, writing = true;
 const transfer = observer.runIsolatedStage({selector: 'receive-isolated-stage', ...identity}, {
  signal: controller.signal, current: () => true, remainingMs: () => deadline - performance.now(),
 }, async (write, signal) => {
  const block = Buffer.alloc(65536);
  issuing.resolve();
  try {
   for (let i = 0; i < 64; i++) {
    await write(block);
    accepted++;
   }
   writing = false;
  } finally {
   stopped.resolve(signal.aborted);
   await drain.promise;
  }
 });
 await issuing.promise;
 const original = observer.active;
 const observeUntil = performance.now() + 1000;
 while (!original.stdin.writableLength && performance.now() < observeUntil) {
  await new Promise(resolve => setTimeout(resolve, 5));
 }
 assert.ok(original.stdin.writableLength > 0 && writing && accepted < 64);
 const stale = observer.run('observe');
 const latest = observer.run('observe');
 assert.equal(await stopped.promise, true);
 assert.equal(observer.active, original);
 await assert.rejects(readFile(trace), {code: 'ENOENT'});
 drain.resolve();
 assert.deepEqual(await transfer, {dispatch: 'possible', stdout: null, wrote: false});
 assert.equal((await stale).status, 'cancelled');
 assert.equal((await latest).status, 'observed');
 assert.equal(await readFile(trace, 'utf8'), 'observe\n');
 assert.equal(observer.active, null);
});

test('supervised stage classifies a withheld child and oversized response without exposing diagnostics', {timeout: 8000}, async t => {
 const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-wired-stage-fault-'));
 t.after(() => rm(folder, {recursive: true, force: true}));
 const script = path.join(folder, 'wired_observer.py');
 const helper = path.join(folder, 'isolated_stage_transport.py');
 for (const mode of ['timeout', 'oversized', 'nonzero']) {
  await t.test(mode, async () => {
   const behavior = mode === 'timeout' ? 'setInterval(() => {}, 1000);' :
    mode === 'oversized' ? "process.stdout.write('x'.repeat(24577));" : "process.stderr.write('PRIVATE'); process.exitCode = 9;";
   await writeFile(helper, "process.stdout.write('READY\\n'); process.stdin.resume(); process.stdin.on('end', () => {" + behavior + '});');
   const observer = new WiredObserver({config: path.join(folder, 'fixture'), python: process.execPath, script});
   const deadline = performance.now() + (mode === 'timeout' ? 1000 : 3000);
   const outcome = await observer.runIsolatedStage({selector: 'check-isolated-stage', ...identity, input_base64: 'e30='}, {
    signal: new AbortController().signal, current: () => true, remainingMs: () => deadline - performance.now(),
   });
   assert.deepEqual(outcome, {dispatch: 'possible', stdout: null, wrote: false});
   assert.equal(observer.active, null);
  });
 }
});
