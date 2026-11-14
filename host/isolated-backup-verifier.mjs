import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, opendir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import expectedSource from './buddy-oracle-source.json' with {type: 'json'};
import {strictJson} from './strict-json.mjs';

const REPORT_BYTES = 16384;
const EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_WAIT = 120000;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refuse = () => { throw Error('Isolated backup verifier unavailable'); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const boundedText = (value, length) => typeof value === 'string' && value.length > 0 &&
  value.length <= length && /^[\x20-\x7e]+$/.test(value);
const stamp = info => [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs];
const same = (a, b) => isDeepStrictEqual(stamp(a), stamp(b));
const equalPath = (left, right) => process.platform === 'win32' ?
  left.toLowerCase() === right.toLowerCase() : left === right;

function limitOperation({signal, timeoutMs}) {
  if (!(signal instanceof AbortSignal) || signal.aborted || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > MAX_WAIT) refuse();
  const deadline = performance.now() + timeoutMs;
  const active = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return {
    signal: active,
    check() { if (active.aborted || performance.now() >= deadline) refuse(); },
  };
}

function safeAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !equalPath(path.resolve(value), value) ||
      path.dirname(value) === value || (process.platform === 'win32' &&
        (!/^[A-Za-z]:\\/.test(value) || value.slice(2).includes(':')))) refuse();
}

async function directories(target, scope) {
  safeAbsolute(target);
  if (!equalPath(await realpath(target), target)) refuse();
  const ancestors = [];
  for (let parent = target; ; parent = path.dirname(parent)) {
    scope.check();
    const entry = await lstat(parent, {bigint: true});
    if (!entry.isDirectory() || entry.isSymbolicLink()) refuse();
    ancestors.push([parent, entry]);
    if (path.dirname(parent) === parent) break;
  }
  return ancestors;
}

async function confirmDirectories(entries, scope) {
  for (const [directory, original] of entries) {
    scope.check();
    const current = await lstat(directory, {bigint: true});
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== original.dev || current.ino !== original.ino) refuse();
  }
}

async function fileIdentity(target, scope) {
  scope.check();
  const info = await lstat(target, {bigint: true});
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
      !equalPath(await realpath(target), target)) refuse();
  scope.check();
  return info;
}

async function readFile(target, original, maximum, scope, consume) {
  if (original.size < 1n || original.size > BigInt(maximum)) refuse();
  const file = await open(target, constants.O_RDONLY |
    (process.platform === 'linux' ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
  try {
    if (!same(await file.stat({bigint: true}), original)) refuse();
    const buffer = Buffer.alloc(64 * 1024);
    let received = 0;
    for (;;) {
      scope.check();
      const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, maximum + 1 - received), received);
      scope.check();
      if (!bytesRead) break;
      received += bytesRead;
      if (received > maximum || BigInt(received) > original.size) refuse();
      consume(buffer.subarray(0, bytesRead));
    }
    if (BigInt(received) !== original.size || !same(await file.stat({bigint: true}), original) ||
        !same(await fileIdentity(target, scope), original)) refuse();
  } finally { await file.close(); }
}

function platform() {
  if (process.arch !== 'x64') refuse();
  if (process.platform === 'win32') return {target: 'x86_64-pc-windows-msvc', name: 'reader-buddy.exe'};
  if (process.platform === 'linux') return {target: 'x86_64-unknown-linux-gnu', name: 'reader-buddy'};
  refuse();
}

async function membership(root, name, scope) {
  scope.check();
  const expected = new Set(['provenance.json', name]);
  // Use incremental enumeration so foreign membership fails immediately.
  const directory = await opendir(root);
  for await (const entry of directory) {
    scope.check();
    if (!expected.delete(entry.name) || !entry.isFile() || entry.isSymbolicLink()) refuse();
  }
  if (expected.size) refuse();
}

async function verifyExecutable(executable, info, reference, scope) {
  if (BigInt(reference.bytes) !== info.size || (process.platform === 'linux' && (info.mode & 0o111n) === 0n)) refuse();
  const hash = createHash('sha256');
  await readFile(executable, info, reference.bytes, scope, chunk => hash.update(chunk));
  if (hash.digest('hex') !== reference.sha256) refuse();
}

async function capture(root, scope) {
  const {target, name} = platform();
  const ancestors = await directories(root, scope);
  await membership(root, name, scope);

  const provenancePath = path.join(root, 'provenance.json');
  const provenanceInfo = await fileIdentity(provenancePath, scope);
  const chunks = [];
  await readFile(provenancePath, provenanceInfo, REPORT_BYTES, scope, chunk => chunks.push(Buffer.from(chunk)));
  const bytes = Buffer.concat(chunks);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse();
  const artifact = strictJson(bytes);
  if (!exact(artifact, ['schema', 'source', 'target', 'profile', 'features', 'rustc', 'version', 'executable']) ||
      artifact.schema !== 1 || !isDeepStrictEqual(artifact.source, expectedSource) || artifact.target !== target ||
      artifact.profile !== 'release' || !Array.isArray(artifact.features) || artifact.features.length !== 0 ||
      !boundedText(artifact.rustc, 256) || !boundedText(artifact.version, 128) || !/^dev\.\S+$/.test(artifact.version) ||
      artifact.version === 'dev.unknown' ||
      !exact(artifact.executable, ['name', 'bytes', 'sha256']) || artifact.executable.name !== name ||
      !Number.isSafeInteger(artifact.executable.bytes) || artifact.executable.bytes < 1 ||
      artifact.executable.bytes > EXECUTABLE_BYTES || !digest(artifact.executable.sha256)) refuse();
  const executable = path.join(root, name);
  const info = await fileIdentity(executable, scope);
  await verifyExecutable(executable, info, artifact.executable, scope);
  await confirmDirectories(ancestors, scope);
  return {info, ancestors, executable, reference: artifact.executable, provenanceInfo, provenancePath, bytes, name};
}

async function confirmProvenance(root, original, scope) {
  await membership(root, original.name, scope);
  const hash = createHash('sha256');
  await readFile(original.provenancePath, original.provenanceInfo, REPORT_BYTES, scope, chunk => hash.update(chunk));
  if (hash.digest('hex') !== createHash('sha256').update(original.bytes).digest('hex')) refuse();
}

function run(executable, cwd, input, maximum, scope, spawnChild) {
  scope.check();
  const env = process.platform === 'win32' && process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {};
  return new Promise((resolve, reject) => {
    const child = spawnChild(executable, ['--archive-operation', 'inspect-isolated', '--archive-input', '-'], {
      cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let refused = false, total = 0;
    const chunks = [];
    const abort = () => {
      if (refused) return;
      refused = true;
      child.kill('SIGKILL');
    };
    scope.signal.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', bytes => {
      if (refused) return;
      total += bytes.length;
      if (total > maximum) abort();
      else chunks.push(bytes);
    });
    child.stderr.on('data', abort);
    child.on('error', abort);
    child.stdin.on('error', abort);
    child.once('close', (code, signal) => {
      scope.signal.removeEventListener('abort', abort);
      const bytes = refused ? Buffer.alloc(0) : Buffer.concat(chunks, total);
      if (refused || code !== 0 || signal !== null || scope.signal.aborted ||
          bytes.length < 2 || bytes.indexOf(10) !== bytes.length - 1 || bytes.includes(13)) {
        reject(Error('Isolated backup verifier refused'));
      } else resolve(bytes);
    });
    if (scope.signal.aborted) abort();
    else child.stdin.end(input);
  });
}

export class IsolatedBackupVerifier {
  #resourceRoot;
  #spawn;

  // spawnChild is a host-only process seam for focused test fixtures.
  constructor({resourceRoot = null, spawnChild = spawn} = {}) {
    this.#resourceRoot = resourceRoot;
    this.#spawn = spawnChild;
  }

  async available(bounds) {
    try {
      const scope = limitOperation(bounds);
      await capture(this.#resourceRoot, scope);
      scope.check();
      return true;
    } catch { return false; }
  }

  async verify({root, markerSha256, maxBytes, timeoutMs, signal}) {
    try {
      const scope = limitOperation({signal, timeoutMs});
      if (!digest(markerSha256) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > REPORT_BYTES) refuse();
      safeAbsolute(root);
      const input = Buffer.from(JSON.stringify({path: root, marker_sha256: markerSha256}));
      if (input.length > REPORT_BYTES) refuse();
      const staged = await directories(root, scope);
      const original = await capture(this.#resourceRoot, scope);
      await confirmProvenance(this.#resourceRoot, original, scope);
      await confirmDirectories(original.ancestors, scope);
      await confirmDirectories(staged, scope);
      if (!same(await fileIdentity(original.executable, scope), original.info)) refuse();
      const output = await run(original.executable, root, input, maxBytes, scope, this.#spawn);
      await verifyExecutable(original.executable, original.info, original.reference, scope);
      await confirmProvenance(this.#resourceRoot, original, scope);
      await confirmDirectories(original.ancestors, scope);
      await confirmDirectories(staged, scope);
      scope.check();
      return output;
    } catch { refuse(); }
  }
}
