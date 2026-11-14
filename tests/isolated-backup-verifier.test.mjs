import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, realpath, rename, rmdir, symlink, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {IsolatedBackupVerifier} from '../host/isolated-backup-verifier.mjs';
import source from '../host/buddy-oracle-source.json' with {type: 'json'};

const platform = process.arch === 'x64' && ['linux', 'win32'].includes(process.platform);
const name = process.platform === 'win32' ? 'reader-buddy.exe' : 'reader-buddy';
const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stat = name => lstat(name, {bigint: true});
const digest = 'a'.repeat(64);
const report = '{"synthetic":"bounded process output"}\n';
const code = 'process.stdout.write(' + JSON.stringify(report) + ')';
const deferred = () => Promise.withResolvers();

async function fixture(t, behavior = code) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'manager-oracle-test-'));
  const rootId = await stat(root);
  const entries = new Map();
  async function owned(name, directory, bytes) {
    const full = path.join(root, name);
    if (directory) await mkdir(full, {mode: 0o700});
    else await writeFile(full, bytes, {flag: 'wx', mode: 0o700});
    entries.set(full, [await stat(full), directory]);
    return full;
  }
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.equal(path.dirname(root), parent);
    const info = await stat(root);
    assert.equal(info.dev, rootId.dev);
    assert.equal(info.ino, rootId.ino);
    for (const [full, [original, directory]] of [...entries].reverse()) {
      const current = await stat(full);
      assert.equal(current.dev, original.dev, full);
      assert.equal(current.ino, original.ino, full);
      assert.equal(current.isSymbolicLink(), original.isSymbolicLink(), full);
      if (!current.isSymbolicLink()) assert.equal(await realpath(full), full);
      if (directory) await rmdir(full);
      else await unlink(full);
    }
    await rmdir(root);
  });

  const resourceRoot = await owned('resources', true);
  const stage = await owned('staged', true);
  const executableBytes = Buffer.from('synthetic executable identity');
  const executable = await owned(path.join('resources', name), false, executableBytes);
  const artifact = {schema: 1, source, target, profile: 'release', features: [],
    rustc: 'rustc synthetic', version: 'dev.v0.77.2-123-g958cacf',
    executable: {name, bytes: executableBytes.length, sha256: hash(executableBytes)}};
  const metadata = await owned(path.join('resources', 'provenance.json'), false, JSON.stringify(artifact));
  const children = [], started = deferred();
  let closed = 0;
  const verifier = new IsolatedBackupVerifier({resourceRoot, spawnChild(file, args, options) {
    assert.equal(file, executable);
    assert.deepEqual(args, ['--archive-operation', 'inspect-isolated', '--archive-input', '-']);
    assert.equal(options.cwd, stage);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(Object.keys(options.env), process.platform === 'win32' && process.env.SystemRoot ? ['SystemRoot'] : []);
    const script = 'let raw="";process.stdin.on("data",b=>raw+=b);process.stdin.on("end",()=>{' +
      'if(raw!==' + JSON.stringify(JSON.stringify({path: stage, marker_sha256: digest})) + ')process.exit(32);' +
      behavior + '\n});';
    // Real subprocess mechanics with a tiny synthetic identity file.
    const child = spawn(process.execPath, ['-e', script], options);
    children.push(child);
    child.once('close', () => { closed++; });
    started.resolve(child);
    return child;
  }});
  return {
    verifier, stage, executable, metadata, artifact, children, started: started.promise,
    get closed() { return closed; },
    run({signal = new AbortController().signal, timeoutMs = 5000, maxBytes = 16384} = {}) {
      return verifier.verify({root: stage, markerSha256: digest, signal, timeoutMs, maxBytes});
    },
    add: owned,
    async move(from, to) {
      const expected = entries.get(from);
      const found = await stat(from);
      assert.equal(found.ino, expected[0].ino);
      assert.equal(found.dev, expected[0].dev);
      await rename(from, to);
      entries.delete(from);
      entries.set(to, expected);
    },
    async link(relative, target) {
      const full = path.join(root, relative);
      await symlink(target, full, 'file');
      entries.set(full, [await stat(full), false]);
    },
  };
}

test('an absent resource root leaves the verifier disabled', async () => {
  const verifier = new IsolatedBackupVerifier();
  const bounds = {signal: new AbortController().signal, timeoutMs: 5000};
  assert.equal(await verifier.available(bounds), false);
  await assert.rejects(verifier.verify({...bounds, root: os.tmpdir(), markerSha256: digest, maxBytes: 16384}), /verifier unavailable/);
});

test('launches the fixed archive command with exact closed stdin and returns one original line after close',
  {skip: !platform}, async t => {
    const f = await fixture(t);
    const signal = new AbortController().signal;
    assert.equal(await f.verifier.available({signal, timeoutMs: 5000}), true);
    assert.equal(f.children.length, 0);
    assert.deepEqual(await f.run({maxBytes: Buffer.byteLength(report)}), Buffer.from(report));
    assert.equal(f.children.length, 1);
    assert.equal(f.closed, 1);
  });

test('wrong provenance, hash, target, or foreign resources refuse before process creation',
  {skip: !platform}, async t => {
    for (const mutate of [
      value => { value.source = {...value.source, sourceSha: '0'.repeat(40)}; },
      value => { value.target = 'wrong-platform'; },
      value => { value.executable.sha256 = 'b'.repeat(64); },
      value => { value.executable.bytes--; },
      value => { value.version = 'dev.unknown'; },
      value => { value.version = 'reader-buddy dev.v0.77.2-123-g958cacf'; },
      value => { value.version = 'dev.v0.77.2-123-g958cacf extra'; },
      value => { value.unexpected = true; },
    ]) {
      const f = await fixture(t);
      mutate(f.artifact);
      await writeFile(f.metadata, JSON.stringify(f.artifact));
      assert.equal(await f.verifier.available({signal: new AbortController().signal, timeoutMs: 5000}), false);
      await assert.rejects(f.run(), /verifier unavailable/);
      assert.equal(f.children.length, 0);
    }
    const absent = await fixture(t);
    await absent.move(absent.executable, path.join(path.dirname(absent.stage), 'unavailable-command'));
    await assert.rejects(absent.run(), /verifier unavailable/);
    assert.equal(absent.children.length, 0);
    const extra = await fixture(t);
    await extra.add(path.join('resources', 'unexpected'), false, 'foreign');
    await assert.rejects(extra.run(), /verifier unavailable/);
    assert.equal(extra.children.length, 0);
  });

test('refuses a symlink executable', {skip: process.platform !== 'linux' || !platform}, async t => {
  const f = await fixture(t);
  const moved = path.join(path.dirname(f.stage), 'redirect-target');
  await f.move(f.executable, moved);
  await f.link(path.join('resources', name), moved);
  await assert.rejects(f.run(), /verifier unavailable/);
  assert.equal(f.children.length, 0);
});

test('rejects stderr, nonzero, missing newline, multiple lines and oversized output after joining',
  {skip: !platform}, async t => {
    for (const processScript of ['process.stderr.write("synthetic private stderr")', 'process.exit(7)',
      'process.stdout.write("{}")', 'process.stdout.write("{}\\n{}\\n")', 'process.stdout.write("x".repeat(16385))']) {
      const f = await fixture(t, processScript);
      await assert.rejects(f.run(), {message: 'Isolated backup verifier unavailable'});
      assert.equal(f.children.length, 1);
      assert.equal(f.closed, 1);
    }
  });

test('cancellation, remaining timeout and late output join the original child',
  {skip: !platform}, async t => {
    for (const abort of [true, false]) {
      const f = await fixture(t, 'setTimeout(()=>process.stdout.write("{}\\n"), 2000)');
      const controller = new AbortController();
      const pending = f.run({signal: controller.signal, timeoutMs: abort ? 5000 : 600});
      await f.started;
      if (abort) controller.abort(new Error('private message'));
      await assert.rejects(pending, {message: 'Isolated backup verifier unavailable'});
      assert.equal(f.children.length, 1);
      assert.equal(f.closed, 1);
    }
  });

test('same-length changed executable or changed provenance invalidates a successful child reply',
  {skip: !platform}, async t => {
    for (const asset of ['executable', 'metadata']) {
      const f = await fixture(t, 'setTimeout(()=>process.stdout.write("{}\\n"), 400)');
      const pending = f.run();
      await f.started;
      if (asset === 'executable') await writeFile(f.executable, 'unrelated executable identity');
      else await writeFile(f.metadata, JSON.stringify({...f.artifact, version: 'dev.changed'}));
      await assert.rejects(pending, /verifier unavailable/);
      assert.equal(f.closed, 1);
    }
  });
