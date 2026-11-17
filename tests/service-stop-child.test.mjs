import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {WiredObserver} from '../host/observer.mjs';import {emptyServiceStopRaw} from '../host/service-stop-private.mjs';import {tablet,identity} from './fixtures/service-stop.mjs';

test('supervised Stop child receives only the Windows TEMP addition', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-stop-env-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const parentEnv = { TEMP: folder, TMP: folder, MANAGER_UNRELATED_CANARY: 'fixture' };
  const originalEnv = Object.keys(parentEnv).map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, parentEnv);

  const config = path.join(folder, 'fixture-config');
  const script = path.join(folder, 'service_stop_transport.py');
  const request = { ...identity, selector: 'review', budget_ms: 30000, expected: null };
  const response = {
    contract_version: 1,
    status: 'observed',
    observation: tablet,
    service_stop_raw: emptyServiceStopRaw(request.selector),
  };
  for (const platform of ['win32', 'linux']) {
    await writeFile(script, `
      const { env } = process;
      if (env.TEMP === ${platform === 'win32' ? JSON.stringify(folder) : 'undefined'}
          && env.TMP === undefined && env.MANAGER_UNRELATED_CANARY === undefined
          && env.LANG === 'C.UTF-8' && env.MANAGER_WIRED_CONFIG === ${JSON.stringify(config)}) {
        process.stdout.write(${JSON.stringify(JSON.stringify(response))});
      } else {
        process.exitCode = 1;
      }
    `);
    const observer = new WiredObserver({
      config, python: process.execPath, script: path.join(folder, 'wired_observer.py'), platform,
    });
    assert.deepEqual(await observer.run('service-stop', request), response, platform);
  }
});
test('actual supervised Stop child enforces256KiB framing, identity, deadline and fixed closed request',async t=>{const folder=await mkdtemp(path.join(os.tmpdir(),'manager-stop-child-'));t.after(()=>rm(folder,{recursive:true,force:true}));const record=path.join(folder,'requests'),script=path.join(folder,'service_stop_transport.py');for(const mode of ['exact','over','duplicate','identity','exit','timeout']){await writeFile(script,`const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(record)},body+'\\n');const mode=${JSON.stringify(mode)};if(mode==='timeout'){setInterval(()=>{},1000);return;}if(mode==='exit'){process.stderr.write('PRIVATE_CANARY');process.stdout.write('PRIVATE_CANARY');process.exitCode=3;return;}const sample=${JSON.stringify(tablet)};if(mode==='identity')sample.boot_id='99999999-9999-4999-8999-999999999999';let output=JSON.stringify({contract_version:1,status:'observed',observation:sample,service_stop_raw:${JSON.stringify(emptyServiceStopRaw('review'))}});if(mode==='duplicate')output=output.replace('"contract_version":1','"contract_version":1,"contract_version":1');if(mode==='exact'||mode==='over')output+=' '.repeat((mode==='exact'?262144:262145)-Buffer.byteLength(output));process.stdout.write(output);});`);const o=new WiredObserver({config:path.join(folder,'synthetic'),python:process.execPath,script:path.join(folder,'wired_observer.py'),timeoutMs:mode==='timeout'?500:13000});o.lastObservation=structuredClone(tablet);const v=await o.run('service-stop',{...identity,selector:'review',budget_ms:12000,expected:null});assert.equal(v.status==='observed',mode==='exact',mode);assert.equal(JSON.stringify(v).includes('PRIVATE_CANARY'),false);}for(const line of (await readFile(record,'utf8')).trim().split('\n')){const q=JSON.parse(line);assert.deepEqual(Object.keys(q).sort(),['boot_id','budget_ms','connection_id','expected','selector']);assert.equal(q.expected,null);assert.equal(q.selector,'review');}});


test('Stop admits its longer budget without increasing sibling operation limits', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'manager-stop-budget-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const marker = path.join(folder, 'launched');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');`;
  await writeFile(path.join(folder, 'service_stop_transport.py'), code);
  await writeFile(path.join(folder, 'source_cache_inventory_transport.py'), code);
  const observer = new WiredObserver({
    config: path.join(folder, 'fixture-config'), python: process.execPath,
    script: path.join(folder, 'wired_observer.py'),
  });
  const request = { ...identity, selector: 'review', budget_ms: 30001, expected: null };
  assert.equal((await observer.run('service-stop', request)).status, 'observation-unavailable');
  assert.equal((await observer.run('source-cache-inventory', { ...identity, budget_ms: 12001 })).status, 'observation-unavailable');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
