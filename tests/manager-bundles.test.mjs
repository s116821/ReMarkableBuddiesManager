import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { MANAGER_PACKAGE_NAMES, quarantineManagerRelease } from '../host/quarantine.mjs';

const REPO = 's116821/ReMarkableBuddiesManager'; const API = `https://api.github.com/repos/${REPO}`;
const TAG = 'v0.3.1'; const SHA = 'c'.repeat(40); const ANNOTATION = 'd'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const probe = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
assert.equal(probe.status, 0, 'qualified fixture Python is available');
const PYTHON = probe.stdout.trim();
const FIXTURE = fileURLToPath(new URL('./fixtures/manager-bundle-input.py', import.meta.url));

async function setup(t, mode = 'valid', mutate = () => {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'manager-bundles-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const generated = join(parent, 'input'); const directory = join(parent, 'quarantine');
  const built = spawnSync(PYTHON, ['-I', '-S', '-B', FIXTURE, generated, TAG, SHA, mode], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const data = Object.fromEntries(await Promise.all([...MANAGER_PACKAGE_NAMES, 'provenance.json'].map(async name => [name, await readFile(join(generated, name))])));
  const manifest = JSON.parse(data['provenance.json']); const record = { ...manifest, provenance_sha256: hash(data['provenance.json']) };
  const assets = Object.entries(data).map(([name, bytes], i) => ({ id: i + 1, name, size: bytes.length, state: 'uploaded', digest: 'sha256:' + hash(bytes), url: `${API}/releases/assets/${i + 1}`, browser_download_url: `https://github.com/${REPO}/releases/download/${TAG}/${name}` }));
  const release = { id: 456, tag_name: TAG, draft: false, prerelease: false, published_at: '2026-10-13T00:00:00Z', html_url: `https://github.com/${REPO}/releases/tag/${TAG}`, assets, body: `<!-- manager-complete:${JSON.stringify(record)} -->` };
  const state = { data, release, assets, record, directory, parent, generated, requests: [] };
  mutate(state);
  const server = createServer((req, res) => {
    state.requests.push(req.url);
    if (req.url === `/git/ref/tags/${TAG}`) res.end(JSON.stringify({ ref: `refs/tags/${TAG}`, object: { type: 'tag', sha: ANNOTATION } }));
    else if (req.url === `/git/tags/${ANNOTATION}`) res.end(JSON.stringify({ sha: ANNOTATION, tag: TAG, object: { type: 'commit', sha: SHA } }));
    else if (req.url === `/releases/tags/${TAG}`) res.end(JSON.stringify(release));
    else {
      const asset = assets.find(a => req.url === `/releases/assets/${a.id}`);
      if (!asset) { res.writeHead(404); res.end(); } else res.end(data[asset.name]);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const fetcher = (url, options) => {
    assert.ok(url.startsWith(API + '/')); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    return fetch(`http://127.0.0.1:${server.address().port}` + url.slice(API.length), options);
  };
  return { ...state, run: extra => quarantineManagerRelease({ tag: TAG, directory, python: PYTHON, fetcher, ...extra }) };
}

test('actual Manager ZIP bytes and embedded identity verify without extraction or update eligibility', async t => {
  const h = await setup(t); const result = await h.run();
  let diagnostic = '';
  if (!result.ok) {
    // Test-only source-line classification: no paths, payloads or raw diagnostics.
    const program = "import runpy,sys,json\nn=runpy.run_path(sys.argv[1]);g=n['verify'].__globals__\ndef refusal(): raise RuntimeError('refusal-line-'+str(sys._getframe(1).f_lineno))\ng['refuse']=refusal\ntry: n['verify'](*sys.argv[2:]);print('direct-helper-passed')\nexcept Exception as e: print(json.dumps({'type':type(e).__name__,'guard':str(e) if str(e).startswith('refusal-line-') else 'unclassified'}))";
    const helper = fileURLToPath(new URL('../scripts/verify-manager-bundle.py', import.meta.url));
    const debug = spawnSync(PYTHON, ['-I', '-S', '-B', '-c', program, helper, h.directory, TAG, SHA], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8' }, timeout: 30000 });
    diagnostic = debug.stdout.slice(0, 256);
  }
  assert.equal(result.ok, true, JSON.stringify(result) + diagnostic); assert.equal(result.receipt.repository, REPO);
  assert.equal(result.receipt.embeddedIdentityVerified, true); assert.equal(result.receipt.updateEligible, false);
  assert.equal(result.receipt.archivesExtracted, false); assert.equal(result.receipt.signatureVerified, false);
  assert.equal(result.receipt.apkInstallEligible, false);
  for (const [name, bytes] of Object.entries(h.data)) assert.deepEqual(await readFile(join(h.directory, name)), bytes);
  assert.deepEqual((await readdir(h.directory)).sort(), [...Object.keys(h.data), 'quarantine-receipt.json'].sort());
  assert.equal(h.requests.length, 10);
});

for (const mode of ['wrong-version', 'wrong-source', 'official-number', 'unknown-field', 'duplicate-json', 'oversized-json', 'missing-build-info', 'central-bomb', 'entry-count-bomb', 'zip64-locator', 'path-traversal', 'duplicate-entry', 'symlink-entry', 'expanded-bomb', 'encrypted', 'bad-compression', 'truncated-archive', 'crc-tamper', 'eocd-comment']) {
  test(`authenticated actual ZIP ${mode} refuses completion`, async t => {
    const h = await setup(t, mode); const result = await h.run();
    assert.equal(result.ok, false); assert.equal(result.code, 'verifier-refused');
    await assert.rejects(readFile(join(h.directory, 'quarantine-receipt.json')), { code: 'ENOENT' });
    assert.ok(!JSON.stringify(result).includes(h.parent));
  });
}

test('Manager cannot consume Buddy release repository or completion marker', async t => {
  for (const change of [s => { s.release.html_url = `https://github.com/s116821/ReMarkableBuddies/releases/tag/${TAG}`; }, s => { s.release.body = s.release.body.replace('manager-complete', 'reader-buddy-complete'); }]) {
    const h = await setup(t, 'valid', change); assert.equal((await h.run()).ok, false);
    await assert.rejects(readdir(h.directory), { code: 'ENOENT' });
  }
});

test('interpreter prerequisite refuses before network or file creation', async t => {
  const h = await setup(t);
  for (const python of [undefined, 'python', '']) assert.equal((await h.run({ python })).code, 'verifier-unconfigured');
  assert.equal(h.requests.length, 0); await assert.rejects(readdir(h.directory), { code: 'ENOENT' });
});

test('closed asset lists cannot be changed by callers', () => {
  assert.throws(() => MANAGER_PACKAGE_NAMES.push('unexpected.zip'), TypeError);
});

for (const kind of ['timeout', 'cancelled', 'oversized', 'wrong-result', 'stderr-warning']) test(`bounded actual verification process ${kind} refuses completion`, async t => {
  const controller = new AbortController(); const h = await setup(t);
  const originalSpawn = childProcess.spawn; let observed = false; let timer;
  if (kind === 'timeout') {
    const set = globalThis.setTimeout;
    timer = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => set(fn, ms === 30000 ? 20 : ms, ...args));
  }
  childProcess.spawn = (executable, args, options) => {
    observed = true;
    assert.deepEqual(args.slice(0, 3), ['-I', '-S', '-B']);
    assert.ok(args[3].endsWith('verify-manager-bundle.py'));
    assert.equal(options.shell, false);
    assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'PATH', 'SystemRoot']);
    const response = '{"ok":true,"embeddedIdentityVerified":true,"archivesExtracted":false,"payloadExecuted":false}\n';
    const program = kind === 'stderr-warning' ? `import sys;sys.stdout.buffer.write(${JSON.stringify(response)}.encode('ascii'));sys.stderr.write('unexpected warning')` : kind === 'oversized' ? 'import sys;sys.stdout.write("X"*9000)' : kind === 'wrong-result' ? 'print("untrusted diagnostic")' : 'import time;time.sleep(60)';
    const child = originalSpawn(executable, ['-I', '-S', '-B', '-c', program], options);
    if (kind === 'cancelled') controller.abort();
    return child;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await h.run({ signal: controller.signal }); }
  finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); timer?.mock.restore(); }
  assert.equal(observed, true); assert.equal(result.ok, false);
  assert.equal(result.code, kind === 'timeout' ? 'verifier-timeout' : kind === 'cancelled' ? 'cancelled' : 'verifier-refused');
  await assert.rejects(readFile(join(h.directory, 'quarantine-receipt.json')), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(result).includes('untrusted diagnostic'));
});

test('changed producer module is refused before its code can run', async t => {
  const h = await setup(t);
  const root = join(h.parent, 'isolated-source'); const scripts = join(root, 'scripts'); const release = join(root, 'release'); const inputs = join(root, 'inputs');
  await mkdir(scripts, { recursive: true }); await mkdir(release); await mkdir(inputs);
  const verifier = fileURLToPath(new URL('../scripts/verify-manager-bundle.py', import.meta.url));
  await copyFile(verifier, join(scripts, 'verify-manager-bundle.py'));
  await copyFile(fileURLToPath(new URL('../release/policy.py', import.meta.url)), join(release, 'policy.py'));
  const original = await readFile(fileURLToPath(new URL('../release/coordinator.py', import.meta.url)), 'utf8');
  const sentinel = join(root, 'MUST_NOT_RUN');
  await writeFile(join(release, 'coordinator.py'), original + `\n__import__('pathlib').Path(${JSON.stringify(sentinel)}).write_text('unsafe')\n`);
  for (const [name, bytes] of Object.entries(h.data)) await writeFile(join(inputs, name), bytes);
  const result = spawnSync(PYTHON, ['-I', '-S', '-B', join(scripts, 'verify-manager-bundle.py'), inputs, TAG, SHA], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '{"ok":false,"code":"bundle-refused"}\n');
  assert.equal(result.stderr, ''); await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
});

for (const changing of [false, true]) test(`Windows stat domains ${changing ? 'still refuse an in-handle metadata change' : 'are independently bracketed with actual byte verification'}`, async t => {
  const h = await setup(t); const inputs = join(h.parent, 'observed'); await mkdir(inputs);
  for (const [name, bytes] of Object.entries(h.data)) await writeFile(join(inputs, name), bytes);
  const helper = fileURLToPath(new URL('../scripts/verify-manager-bundle.py', import.meta.url));
  const program = "import runpy,sys,json,types\nn=runpy.run_path(sys.argv[1]);g=n['verify'].__globals__;g['WINDOWS']=True\nf=g['os'].fstat;calls=0\ndef metadata(fd):\n global calls\n calls+=1;s=f(fd);keys=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode');v={k:getattr(s,k) for k in keys};v['st_ctime_ns']+=1000000000+(calls if sys.argv[5]=='change' else 0);return types.SimpleNamespace(**v)\ng['os'].fstat=metadata\ntry: value=n['verify'](*sys.argv[2:5]);print(json.dumps({'ok':value['ok']}))\nexcept Exception: print(json.dumps({'ok':False}));sys.exit(1)";
  const result = spawnSync(PYTHON, ['-I', '-S', '-B', '-c', program, helper, inputs, TAG, SHA, changing ? 'change' : 'stable'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, changing ? 1 : 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: !changing });
});


test('host-owned shared download uses actual consumer bytes and exposes only sanitized completion', async t => {
  const { ManagerDownloads } = await import('../host/manager-downloads.mjs');
  const { parseDownloadState } = await import('../host/manager-download-protocol.mjs');
  const h = await setup(t);
  const host = new ManagerDownloads({ parent: h.parent, python: PYTHON, consumer: args => h.run(args) });
  t.after(()=>host.dispose());
  assert.equal((await host.request({action:'status'})).status,'idle');
  const pending = await host.request({action:'start',tag:TAG});
  assert.equal(pending.status,'downloading');
  await assert.rejects(host.request({action:'start',tag:TAG}));
  await host.active.promise;
  const done = parseDownloadState(await host.request({action:'status'}));
  assert.equal(done.status,'complete'); assert.equal(done.source_sha,SHA); assert.equal(done.update_eligible,false);
  assert.equal(JSON.stringify(done).includes(h.parent),false);
  const receipt=JSON.parse(await readFile(join(h.parent,done.folder,'quarantine-receipt.json'),'utf8'));
  assert.equal(receipt.embeddedIdentityVerified,true);assert.equal(receipt.updateEligible,false);
  assert.deepEqual(await readFile(join(h.parent,done.folder,'manager-browser.zip')),h.data['manager-browser.zip']);
  assert.deepEqual(await host.request({action:'cancel',operation_id:done.operation_id}),done);
});
