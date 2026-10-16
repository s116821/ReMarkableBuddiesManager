import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const REPO = 's116821/ReMarkableBuddies';
const API = `https://api.github.com/repos/${REPO}`;
export const PACKAGE_NAMES = ['reader-buddy-armv7-unknown-linux-gnueabihf.tar.gz', 'reader-buddy-aarch64-unknown-linux-gnu.tar.gz'];
const NAMES = [...PACKAGE_NAMES, 'provenance.json'];
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const fail = code => { throw new Error(code); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const positive = n => Number.isSafeInteger(n) && n > 0;

// JSON.parse alone loses duplicate object members. Scan the same valid JSON first.
function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail('invalid-json');
  };
  function scan(depth = 0) {
    if (depth > 32) fail('json-depth');
    space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        space(); const key = string();
        if (keys.has(key)) fail('duplicate-json-member');
        keys.add(key); space(); i++; scan(depth + 1); space();
        if (text[i++] === '}') return;
      }
    }
    if (text[i] === '[') {
      i++; space();
      if (text[i] === ']') { i++; return; }
      while (true) { scan(depth + 1); space(); if (text[i++] === ']') return; }
    }
    if (text[i] === '"') { string(); return; }
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
  }
  scan(); return value;
}

async function response(fetcher, url, accept, signal) {
  for (let redirect = 0; redirect <= 5; redirect++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.hash) fail('unsafe-remote-url');
    const res = await fetcher(parsed.href, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location) fail('invalid-redirect');
      url = new URL(location, parsed).href; continue;
    }
    if (res.status !== 200 || !res.body) { await res.body?.cancel(); fail('remote-refusal'); }
    return res;
  }
  fail('redirect-limit');
}

async function consume(res, limit, signal, write = null) {
  const reader = res.body.getReader();
  const chunks = []; const digest = createHash('sha256'); let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('byte-limit');
      digest.update(value);
      if (write) await write(value); else chunks.push(Buffer.from(value));
    }
    return { size, digest: digest.digest('hex'), bytes: write ? null : Buffer.concat(chunks) };
  } finally { await reader.cancel().catch(() => {}); }
}

async function json(fetcher, path, signal) {
  const res = await response(fetcher, `${API}/${path}`, 'application/vnd.github+json', signal);
  return strictJson((await consume(res, 256 * 1024, signal)).bytes);
}

function completion(body) {
  if (typeof body !== 'string') fail('invalid-completion');
  const markers = [...body.matchAll(/<!-- reader-buddy-complete:(.*?) -->/gs)];
  if (markers.length !== 1 || body.split('reader-buddy-complete:').length !== 2) fail('invalid-completion');
  return strictJson(Buffer.from(markers[0][1]));
}

async function publication(fetcher, tag, signal) {
  const ref = await json(fetcher, `git/ref/tags/${tag}`, signal);
  if (ref.ref !== `refs/tags/${tag}` || ref.object?.type !== 'tag' || !SHA.test(ref.object.sha)) fail('invalid-tag');
  const annotation = await json(fetcher, `git/tags/${ref.object.sha}`, signal);
  if (annotation.sha !== ref.object.sha || annotation.tag !== tag || annotation.object?.type !== 'commit' || !SHA.test(annotation.object.sha)) fail('invalid-tag');
  const sha = annotation.object.sha;
  const release = await json(fetcher, `releases/tags/${tag}`, signal);
  if (!positive(release.id) || release.tag_name !== tag || release.draft !== false || release.prerelease !== false || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)) || release.html_url !== `https://github.com/${REPO}/releases/tag/${tag}` || !Array.isArray(release.assets) || release.assets.length !== 3) fail('invalid-release');
  const record = completion(release.body);
  if (!exact(record, ['tag', 'sha', 'version', 'packages', 'provenance_sha256']) || record.tag !== tag || record.sha !== sha || record.version !== tag.slice(1) || !exact(record.packages, PACKAGE_NAMES) || !Object.values(record.packages).every(v => typeof v === 'string' && HASH.test(v)) || typeof record.provenance_sha256 !== 'string' || !HASH.test(record.provenance_sha256)) fail('invalid-completion');
  const assets = []; const ids = new Set();
  for (const name of NAMES) {
    const matches = release.assets.filter(a => a.name === name);
    if (matches.length !== 1) fail('invalid-assets');
    const a = matches[0];
    const expected = name === 'provenance.json' ? record.provenance_sha256 : record.packages[name];
    if (!positive(a.id) || ids.has(a.id) || a.state !== 'uploaded' || !positive(a.size) || a.size > (name === 'provenance.json' ? 64 * 1024 : 512 * 1024 * 1024) || a.digest !== `sha256:${expected}` || a.browser_download_url !== `https://github.com/${REPO}/releases/download/${tag}/${name}` || a.url !== `${API}/releases/assets/${a.id}`) fail('invalid-assets');
    ids.add(a.id); assets.push({ id: a.id, name, size: a.size, sha256: expected });
  }
  if (assets.reduce((sum, a) => sum + a.size, 0) > 768 * 1024 * 1024) fail('aggregate-limit');
  return { tag, sha, version: tag.slice(1), tagObject: annotation.sha, releaseId: release.id, publishedAt: release.published_at, assets, record };
}

async function sameDirectory(directory, initial) {
  const now = await lstat(directory);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== initial.dev || now.ino !== initial.ino || await realpath(directory) !== directory) fail('staging-changed');
}

async function verifyFiles(directory, assets, signal) {
  if ((await readdir(directory)).sort().join() !== NAMES.toSorted().join()) fail('staging-changed');
  for (const asset of assets) {
    const path = join(directory, asset.name);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.size || before.nlink !== 1) fail('staging-changed');
    const file = await open(path, 'r');
    try {
      const opened = await file.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) fail('staging-changed');
      const digest = createHash('sha256'); let count = 0;
      for await (const bytes of file.createReadStream({ autoClose: false })) { signal.throwIfAborted(); count += bytes.length; if (count > asset.size) fail('staging-changed'); digest.update(bytes); }
      const after = await lstat(path);
      if (count !== asset.size || digest.digest('hex') !== asset.sha256 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('staging-changed');
    } finally { await file.close(); }
  }
}

// fetcher injection is solely for controlled HTTP tests; the CLI supplies native fetch.
export async function quarantineRelease({ tag, directory, signal: callerSignal, fetcher = fetch }) {
  let created = false;
  try {
    if (typeof tag !== 'string' || tag.length > 64 || !/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) fail('invalid-tag-input');
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory !== resolve(directory) || await realpath(dirname(directory)) !== dirname(directory)) fail('invalid-directory-input');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
    const deadline = performance.now() + 300000;
    signal.throwIfAborted();
    const source = await publication(fetcher, tag, signal);
    signal.throwIfAborted();
    await mkdir(directory, { mode: 0o700 }); created = true;
    const initial = await lstat(directory);
    let provenance;
    for (const asset of source.assets) {
      await sameDirectory(directory, initial); signal.throwIfAborted();
      const res = await response(fetcher, `${API}/releases/assets/${asset.id}`, 'application/octet-stream', signal);
      let file;
      try { file = await open(join(directory, asset.name), 'wx', 0o600); }
      catch (error) { await res.body.cancel().catch(() => {}); throw error; }
      let downloaded;
      try {
        const chunks = [];
        downloaded = await consume(res, asset.size, signal, async bytes => {
          let offset = 0;
          while (offset < bytes.length) { const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset); if (!bytesWritten) fail('staging-write'); offset += bytesWritten; }
          if (asset.name === 'provenance.json') chunks.push(Buffer.from(bytes));
        });
        await file.sync();
        if (asset.name === 'provenance.json') provenance = strictJson(Buffer.concat(chunks));
      } finally { await file.close(); }
      if (downloaded.size !== asset.size || downloaded.digest !== asset.sha256) fail('asset-mismatch');
    }
    if (!exact(provenance, ['tag', 'sha', 'version', 'packages']) || provenance.tag !== source.tag || provenance.sha !== source.sha || provenance.version !== source.version || !exact(provenance.packages, PACKAGE_NAMES) || PACKAGE_NAMES.some(name => provenance.packages[name] !== source.record.packages[name])) fail('provenance-mismatch');
    const final = await publication(fetcher, tag, signal);
    if (JSON.stringify(final) !== JSON.stringify(source)) fail('publication-changed');
    await sameDirectory(directory, initial); await verifyFiles(directory, source.assets, signal);
    await sameDirectory(directory, initial); signal.throwIfAborted();
    const receipt = { state: 'legacy-quarantined', repository: REPO, tag, sourceSha: source.sha, annotatedTagSha: source.tagObject, releaseId: source.releaseId, assets: source.assets, checksumAgreement: true, apkInstallEligible: false, reason: 'legacy-tarballs-no-signed-apk-contract', archivesExtracted: false, payloadSafetyVerified: false, signatureVerified: false, reuseRequiresReverification: true };
    const pending = join(directory, '.quarantine-receipt.pending');
    const file = await open(pending, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    signal.throwIfAborted(); await sameDirectory(directory, initial);
    // Last awaited validation can yield to cancellation/deadline. Check again with
    // no await between this gate and issuing the atomic commit.
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new DOMException('deadline', 'TimeoutError');
    // Once link is issued, it cannot be preempted: success commits even if a
    // cancellation arrives in flight; failure publishes no successful receipt.
    await link(pending, join(directory, 'quarantine-receipt.json'));
    await unlink(pending).catch(() => {});
    return { ok: true, receipt };
  } catch (error) {
    const codes = new Set(['invalid-json', 'json-depth', 'duplicate-json-member', 'unsafe-remote-url', 'invalid-redirect', 'remote-refusal', 'redirect-limit', 'byte-limit', 'invalid-completion', 'invalid-tag', 'invalid-release', 'invalid-assets', 'aggregate-limit', 'staging-changed', 'invalid-tag-input', 'invalid-directory-input', 'staging-write', 'asset-mismatch', 'provenance-mismatch', 'publication-changed']);
    return { ok: false, code: codes.has(error.message) ? error.message : callerSignal?.aborted ? 'cancelled' : error.name === 'TimeoutError' ? 'deadline' : 'operation-refused', incompleteQuarantine: created };
  }
}
