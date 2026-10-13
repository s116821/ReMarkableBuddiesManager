import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { PACKAGE_NAMES, quarantineRelease } from '../host/quarantine.mjs';

const API = 'https://api.github.com/repos/s116821/ReMarkableBuddies';
const TAG = 'v1.2.3'; const SHA = 'a'.repeat(40); const TAG_SHA = 'b'.repeat(40);
const digest = b => createHash('sha256').update(b).digest('hex');
// Actual gzip/tar bytes containing a nonexecuted sentinel script; consumer never extracts.
function archive() {
  const payload = Buffer.from('#!/bin/sh\ntouch THIS_MUST_NEVER_RUN\n');
  const header = Buffer.alloc(512);
  header.write('reader-buddy'); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(payload.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, payload, Buffer.alloc(512 - payload.length), Buffer.alloc(1024)]), { mtime: 0 });
}

async function harness(t, mutate = () => {}) {
  // Windows TEMP can use an 8.3 alias/case spelling; valid fixtures use the actual
  // canonical parent, while unsafe-alias refusal remains a separate control.
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'buddy-quarantine-')));
  const directory = join(parent, 'new');
  const packages = Object.fromEntries(PACKAGE_NAMES.map(name => [name, archive()]));
  const provenance = { tag: TAG, sha: SHA, version: '1.2.3', packages: Object.fromEntries(PACKAGE_NAMES.map(name => [name, digest(packages[name])])) };
  const data = { ...packages, 'provenance.json': Buffer.from(JSON.stringify(provenance)) };
  const record = { ...provenance, provenance_sha256: digest(data['provenance.json']) };
  const assets = Object.entries(data).map(([name, bytes], index) => ({ id: index + 1, name, size: bytes.length, state: 'uploaded', digest: `sha256:${digest(bytes)}`, url: `${API}/releases/assets/${index + 1}`, browser_download_url: `https://github.com/s116821/ReMarkableBuddies/releases/download/${TAG}/${name}` }));
  const release = { id: 123, tag_name: TAG, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', html_url: `https://github.com/s116821/ReMarkableBuddies/releases/tag/${TAG}`, assets, body: `A release\n<!-- reader-buddy-complete:${JSON.stringify(record)} -->` };
  let visits = 0; const requests = [];
  const state = { data, record, release, provenance, assets, parent, directory, requests };
  mutate(state);
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization, accept: req.headers.accept });
    let body;
    if (req.url === `/git/ref/tags/${TAG}`) { visits++; body = { ref: `refs/tags/${TAG}`, object: { type: state.lightweight ? 'commit' : 'tag', sha: TAG_SHA } }; }
    else if (req.url === `/git/tags/${TAG_SHA}`) body = { sha: TAG_SHA, tag: TAG, object: { type: 'commit', sha: state.moveTag && visits > 1 ? 'c'.repeat(40) : SHA } };
    else if (req.url === `/releases/tags/${TAG}`) { body = structuredClone(release); if (state.moveRelease && visits > 1) body.id++; }
    else {
      const a = assets.find(a => `/releases/assets/${a.id}` === req.url);
      if (!a) { res.writeHead(404); res.end(); return; }
      if (state.redirect) { res.writeHead(302, { Location: state.redirect }); res.end(); return; }
      if (state.cancel) state.cancel.abort();
      res.end(data[a.name]); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(state.rawRelease && req.url === `/releases/tags/${TAG}` ? state.rawRelease : JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(parent, { recursive: true, force: true }); });
  const fetcher = (url, options) => {
    assert.ok(url.startsWith(API + '/'), 'only derived fixed API URLs reach test transport');
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, undefined);
    return fetch(`http://127.0.0.1:${server.address().port}` + url.slice(API.length), options);
  };
  return { ...state, fetcher, run: (extra = {}) => quarantineRelease({ tag: TAG, directory, fetcher, ...extra }) };
}

async function noReceipt(directory) {
  await assert.rejects(readFile(join(directory, 'quarantine-receipt.json')), { code: 'ENOENT' });
}

test('real HTTP bytes are preserved; final receipt refuses APK eligibility and no extraction occurs', async t => {
  const h = await harness(t); const result = await h.run();
  assert.equal(result.ok, true); assert.equal(result.receipt.apkInstallEligible, false);
  assert.equal(result.receipt.signatureVerified, false); assert.equal(result.receipt.payloadSafetyVerified, false);
  for (const [name, bytes] of Object.entries(h.data)) assert.deepEqual(await readFile(join(h.directory, name)), bytes);
  assert.deepEqual((await readdir(h.directory)).sort(), [...Object.keys(h.data), 'quarantine-receipt.json'].sort());
  assert.equal(h.requests.length, 9); assert.ok(h.requests.every(r => r.authorization === undefined));
  assert.ok(h.requests.filter(r => /assets/.test(r.path)).every(r => r.accept === 'application/octet-stream'));
});

for (const [name, change, code] of [
  ['corrupt bytes', s => { const b = Buffer.from(s.data[PACKAGE_NAMES[0]]); b[0] ^= 1; s.data[PACKAGE_NAMES[0]] = b; }, 'asset-mismatch'],
  ['truncated bytes', s => { s.data[PACKAGE_NAMES[0]] = s.data[PACKAGE_NAMES[0]].subarray(0, 5); }, 'asset-mismatch'],
  ['extra streamed bytes', s => { s.data[PACKAGE_NAMES[0]] = Buffer.concat([s.data[PACKAGE_NAMES[0]], Buffer.from('extra')]); }, 'byte-limit'],
  ['missing asset', s => { s.release.assets.pop(); }, 'invalid-release'],
  ['duplicate asset ID', s => { s.assets[1].id = s.assets[0].id; }, 'invalid-assets'],
  ['wrong repository', s => { s.release.html_url = 'https://github.com/other/repo/releases/tag/v1.2.3'; }, 'invalid-release'],
  ['preview release', s => { s.release.prerelease = true; }, 'invalid-release'],
  ['lightweight tag', s => { s.lightweight = true; }, 'invalid-tag'],
  ['server digest mismatch', s => { s.assets[0].digest = 'sha256:' + '0'.repeat(64); }, 'invalid-assets'],
  ['foreign asset URL', s => { s.assets[0].url = 'https://example.org/asset'; }, 'invalid-assets'],
  ['missing completion', s => { s.release.body = ''; }, 'invalid-completion'],
  ['duplicate completion', s => { s.release.body += s.release.body; }, 'invalid-completion'],
  ['comma-joined package key cannot substitute exact members', s => {
    s.record.packages = { [PACKAGE_NAMES.toSorted().join()]: 'a'.repeat(64) };
    s.release.body = `<!-- reader-buddy-complete:${JSON.stringify(s.record)} -->`;
  }, 'invalid-completion'],
  ['oversized metadata-declared package', s => { s.assets[0].size = 512 * 1024 * 1024 + 1; }, 'invalid-assets'],
  ['aggregate declared size', s => { s.assets[0].size = s.assets[1].size = 500 * 1024 * 1024; }, 'aggregate-limit'],
  ['moved annotated tag', s => { s.moveTag = true; }, 'invalid-completion'],
  ['replaced stable release', s => { s.moveRelease = true; }, 'publication-changed'],
  ['unsafe redirect host', s => { s.redirect = 'https://example.org/private?secret=value'; }, 'unsafe-remote-url'],
  ['redirect loop', s => { s.redirect = API + '/releases/assets/1'; }, 'redirect-limit'],
  ['oversized JSON', s => { s.rawRelease = JSON.stringify({ ...s.release, body: 'x'.repeat(256 * 1024) }); }, 'byte-limit'],
  ['duplicate JSON member', s => { s.rawRelease = JSON.stringify(s.release).replace('"id":123', '"id":999,"id":123'); }, 'duplicate-json-member'],
]) test(name + ' never yields a completion receipt', async t => {
  const h = await harness(t, change); const result = await h.run();
  assert.equal(result.ok, false); assert.equal(result.code, code); await noReceipt(h.directory);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('contradictory provenance with authenticated matching byte digest still refuses', async t => {
  const h = await harness(t, s => {
    const bytes = Buffer.from(JSON.stringify({ ...s.provenance, sha: 'c'.repeat(40) }));
    s.data['provenance.json'] = bytes; const a = s.assets.find(a => a.name === 'provenance.json');
    a.size = bytes.length; a.digest = `sha256:${digest(bytes)}`;
    s.record.provenance_sha256 = digest(bytes); s.release.body = `<!-- reader-buddy-complete:${JSON.stringify(s.record)} -->`;
  });
  assert.equal((await h.run()).code, 'provenance-mismatch'); await noReceipt(h.directory);
});

test('existing directory and its user file are preserved', async t => {
  const h = await harness(t); await mkdir(h.directory); await writeFile(join(h.directory, 'keep'), 'user data');
  assert.equal((await h.run()).ok, false); assert.equal(await readFile(join(h.directory, 'keep'), 'utf8'), 'user data');
  assert.deepEqual(await readdir(h.directory), ['keep']);
});

test('symlink destination or parent cannot receive release bytes', async t => {
  const h = await harness(t); const target = join(h.parent, 'target'); await mkdir(target);
  // Windows junction creation does not require developer-mode symlink permission.
  await symlink(target, h.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.run()).ok, false);
  assert.equal((await h.run({ directory: join(h.directory, 'child') })).code, 'invalid-directory-input');
  assert.deepEqual(await readdir(target), []);
});

test('aborted HTTP download leaves no completion receipt', async t => {
  const controller = new AbortController(); const h = await harness(t, s => { s.cancel = controller; });
  assert.equal((await h.run({ signal: controller.signal })).code, 'cancelled'); await noReceipt(h.directory);
});

test('tag and output path aliases refuse before requests', async t => {
  const h = await harness(t);
  for (const tag of ['v01.2.3', 'v1.2.3-rc.1', '../main', 'main']) assert.equal((await h.run({ tag })).code, 'invalid-tag-input');
  assert.equal((await h.run({ directory: h.directory + '/.' })).code, 'invalid-directory-input');
  assert.equal(h.requests.length, 0);
});

test('alteration of already downloaded file during publication recheck refuses', async t => {
  const h = await harness(t); let visited = 0;
  // Use a wrapper around the harness transport, keeping the actual HTTP response.
  const result = await h.run({ fetcher: async (url, options) => {
    if (url === `${API}/git/ref/tags/${TAG}` && ++visited === 2) await writeFile(join(h.directory, PACKAGE_NAMES[0]), Buffer.alloc(h.data[PACKAGE_NAMES[0]].length));
    return h.fetcher(url, options);
  } });
  assert.equal(result.code, 'staging-changed'); await noReceipt(h.directory);
});

for (const kind of ['cancellation', 'deadline']) test(`late ${kind} during final directory validation refuses receipt commit`, async t => {
  const controller = new AbortController(); const h = await harness(t);
  const originalRealpath = fsPromises.realpath;
  let triggered = false; let clock;
  fsPromises.realpath = async path => {
    if (path === h.directory && (await readdir(path)).includes('.quarantine-receipt.pending')) {
      triggered = true;
      if (kind === 'cancellation') controller.abort();
      else {
        // Simulate an elapsed monotonic deadline even before the timer's callback.
        const now = performance.now.bind(performance);
        clock = t.mock.method(performance, 'now', () => now() + 300001);
      }
    }
    return originalRealpath(path);
  };
  syncBuiltinESMExports();
  let result;
  try { result = await h.run({ signal: controller.signal }); }
  finally { fsPromises.realpath = originalRealpath; syncBuiltinESMExports(); clock?.mock.restore(); }
  assert.equal(triggered, true); assert.equal(result.ok, false);
  assert.equal(result.code, kind === 'cancellation' ? 'cancelled' : 'deadline');
  await noReceipt(h.directory);
  assert.ok((await readdir(h.directory)).includes('.quarantine-receipt.pending'));
});

test('cancellation after atomic link is issued cannot revoke its successful commit', async t => {
  const controller = new AbortController(); const h = await harness(t);
  const originalLink = fsPromises.link; let issued = false;
  fsPromises.link = (source, destination) => {
    const request = originalLink(source, destination);
    issued = true; controller.abort();
    return request;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await h.run({ signal: controller.signal }); }
  finally { fsPromises.link = originalLink; syncBuiltinESMExports(); }
  assert.equal(issued, true); assert.equal(controller.signal.aborted, true);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(await readFile(join(h.directory, 'quarantine-receipt.json'), 'utf8')), result.receipt);
});
