import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {copyFile, link, lstat, mkdir, mkdtemp, open, realpath, rename, rmdir, symlink, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {lockWindowsResources} from '../host/isolated-backup-resource-lock.mjs';
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

function simulatedLock(events = [], {ready = ['rea', 'dy\n'], confirmed = 'confirmed\n', exitCode = 0} = {}) {
  const opened = deferred();
  return {
    opened: opened.promise,
    spawnLock(file, args, options) {
      assert.equal(file, process.execPath);
      assert.deepEqual(args.slice(0, 2), ['-I', '-B']);
      assert.equal(path.basename(args[2]), 'isolated-backup-resource-lock.py');
      assert.equal(path.basename(args[3]), 'resources');
      assert.equal(args.length, 4);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()});
      let closed = false;
      child.finish = (code = exitCode) => {
        if (closed) return;
        closed = true;
        child.emit('exit', code, null);
        child.emit('close', code, null);
      };
      child.kill = () => child.finish(1);
      child.stdin.on('data', data => {
        assert.equal(data.toString(), 'confirm\n');
        events.push('confirm');
        child.stdout.write(confirmed);
      });
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = () => {
        events.push('release');
        end();
      };
      child.stdin.once('end', () => {
        child.finish();
        events.push('lock closed');
      });
      child.stdin.resume();
      events.push('acquire');
      opened.resolve(child);
      queueMicrotask(() => ready.forEach(chunk => child.stdout.write(chunk)));
      return child;
    },
  };
}

async function fixture(t, behavior = code, {
  spawnLock = simulatedLock().spawnLock, python = process.execPath, events = [], retained,
} = {}) {
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
  const artifact = {schema: 1, source, target, profile: 'release', features: [],
    rustc: 'rustc synthetic', version: 'dev.v0.77.2-123-g958cacf',
    executable: {name, bytes: executableBytes.length, sha256: hash(executableBytes)}};
  let executable;
  if (retained) {
    executable = path.join(resourceRoot, name);
    await copyFile(retained, executable, constants.COPYFILE_EXCL);
    entries.set(executable, [await stat(executable), false]);
    artifact.executable.bytes = Number(process.env.READER_BUDDY_ARCHIVE_TEST_BYTES);
    artifact.executable.sha256 = process.env.READER_BUDDY_ARCHIVE_TEST_SHA256;
  } else {
    executable = await owned(path.join('resources', name), false, executableBytes);
  }
  const metadata = await owned(path.join('resources', 'provenance.json'), false, JSON.stringify(artifact));
  const children = [], started = deferred();
  let closed = 0;
  function spawnChild(file, args, options) {
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
    events.push('Buddy started');
    children.push(child);
    child.once('close', () => {
      closed++;
      events.push('Buddy closed');
    });
    started.resolve(child);
    return child;
  }
  const verifier = new IsolatedBackupVerifier({resourceRoot, python, spawnLock, spawnChild});
  return {
    verifier, stage, resourceRoot, executable, metadata, artifact, children, started: started.promise,
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

test('resource lock spans availability and the complete fixed invocation through child close',
  {skip: !platform}, async t => {
    const events = [];
    const f = await fixture(t, code, {spawnLock: simulatedLock(events).spawnLock, events});
    assert.equal(await f.verifier.available({signal: new AbortController().signal, timeoutMs: 5000}), true);
    assert.deepEqual(events.splice(0), ['acquire', 'confirm', 'release', 'lock closed']);
    assert.deepEqual(await f.run(), Buffer.from(report));
    assert.deepEqual(events, ['acquire', 'Buddy started', 'Buddy closed', 'confirm', 'release', 'lock closed']);
  });

test('resource lock framing, acquisition and exit failures refuse without accepting a report',
  {skip: !platform}, async t => {
    const controls = [
      {ready: ['ready\r\n'], ran: false},
      {ready: ['ready\njunk'], ran: false},
      {ready: ['x'.repeat(256)], ran: false},
      {ready: ['rea'], ran: false, timeoutMs: 250},
      {confirmed: 'confirmed\nconfirmed\n', ran: true},
      {exitCode: 1, ran: true},
    ];
    for (const {ran, timeoutMs, ...behavior} of controls) {
      const events = [];
      const f = await fixture(t, code, {spawnLock: simulatedLock(events, behavior).spawnLock, events});
      await assert.rejects(f.run({timeoutMs}), /verifier unavailable/);
      assert.equal(f.closed, ran ? 1 : 0);
      assert.equal(events.at(-1), 'lock closed');
    }
    const f = await fixture(t, code, {spawnLock: () => { throw Error('unavailable'); }});
    assert.equal(await f.verifier.available({signal: new AbortController().signal, timeoutMs: 5000}), false);
    await assert.rejects(f.run(), /verifier unavailable/);
    assert.equal(f.children.length, 0);
  });

test('resource lock is acquired before capture and original file identity must survive a successful child',
  {skip: !platform}, async t => {
    const events = [];
    const acquisition = simulatedLock(events, {ready: []});
    const f = await fixture(t, 'setTimeout(()=>process.stdout.write("{}\\n"), 500)', {
      spawnLock: acquisition.spawnLock, events,
    });
    const original = path.join(path.dirname(f.resourceRoot), 'captured-original');
    await f.move(f.executable, original);
    const pending = f.run();
    const guard = await acquisition.opened;
    await f.move(original, f.executable);
    guard.stdout.write('ready\n');
    await f.started;
    await f.move(f.executable, original);
    await f.add(path.relative(path.dirname(f.resourceRoot), f.executable), false, 'synthetic executable identity');
    await assert.rejects(pending, /verifier unavailable/);
    assert.deepEqual(events, ['acquire', 'Buddy started', 'Buddy closed', 'release', 'lock closed']);
  });

test('cancellation, timeout and guard loss join Buddy before releasing the control pipe',
  {skip: !platform}, async t => {
    for (const outcome of ['cancel', 'timeout', 'lost']) {
      const events = [];
      const guard = simulatedLock(events);
      const f = await fixture(t, 'setTimeout(()=>process.stdout.write("{}\\n"), 5000)', {spawnLock: guard.spawnLock, events});
      const controller = new AbortController();
      const pending = f.run({signal: controller.signal, timeoutMs: outcome === 'timeout' ? 600 : 2500});
      await f.started;
      if (outcome === 'cancel') controller.abort();
      if (outcome === 'lost') (await guard.opened).stdout.end();
      await assert.rejects(pending, /verifier unavailable/);
      assert.deepEqual(events.slice(0, 4), ['acquire', 'Buddy started', 'Buddy closed', 'release']);
      assert.equal(f.closed, 1);
    }
  });

test('the original deadline and cancellation apply while awaiting final confirmation',
  {skip: !platform}, async t => {
    for (const canceled of [false, true]) {
      const events = [];
      const guard = simulatedLock(events, {confirmed: ''});
      const f = await fixture(t, code, {spawnLock: guard.spawnLock, events});
      const controller = new AbortController();
      const pending = f.run({signal: controller.signal, timeoutMs: canceled ? 5000 : 950});
      if (canceled) {
        const child = await guard.opened;
        child.stdin.once('data', () => controller.abort());
      }
      await assert.rejects(pending, /verifier unavailable/);
      assert.deepEqual(events, ['acquire', 'Buddy started', 'Buddy closed', 'confirm', 'release', 'lock closed']);
    }
  });

const nativePython = process.env.MANAGER_DRIVE_PYTHON ?? process.env.MANAGER_WIRED_PYTHON;
const skipNative = !platform || process.platform !== 'win32' || !nativePython;
test('native Windows helper denies writes, replacement and ancestor rename until joined release',
  {skip: skipNative}, async t => {
    const retained = process.env.READER_BUDDY_ARCHIVE_TEST_COMMAND;
    const f = await fixture(t, code, {retained});
    await f.add('replacement', false, 'replacement bytes');
    const replacement = path.join(path.dirname(f.resourceRoot), 'replacement');
    const moved = path.join(path.dirname(f.resourceRoot), 'moved-resources');
    const signal = AbortSignal.timeout(10000);
    const lock = await lockWindowsResources(f.resourceRoot, nativePython, signal);
    try {
      for (const leaf of [f.executable, f.metadata]) {
        await (await open(leaf, 'r')).close();
        await assert.rejects(async () => (await open(leaf, 'r+')).close(), {code: /^(EACCES|EBUSY|EPERM)$/});
        await assert.rejects(rename(replacement, leaf), {code: /^(EACCES|EBUSY|EPERM)$/});
      }
      await assert.rejects(rename(f.resourceRoot, moved), {code: /^(EACCES|EBUSY|EPERM)$/});
      if (retained) {
        const verifier = new IsolatedBackupVerifier({resourceRoot: f.resourceRoot, python: nativePython});
        assert.equal(await verifier.available({signal, timeoutMs: 5000}), true);
        // The version command checks that the retained executable can load under the lock.
        const actual = spawn(f.executable, ['--version'], {
          windowsHide: true, env: {SystemRoot: process.env.SystemRoot}, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '', errors = '';
        actual.stdout.on('data', b => { output += b; });
        actual.stderr.on('data', b => { errors += b; });
        const joined = deferred();
        let launchError;
        actual.once('error', error => { launchError = error; });
        actual.once('close', (status, signal) => joined.resolve({status, signal}));
        const stop = () => actual.kill('SIGKILL');
        signal.addEventListener('abort', stop, {once: true});
        if (signal.aborted) stop();
        try {
          assert.deepEqual(await joined.promise, {status: 0, signal: null});
          assert.equal(launchError, undefined);
          assert.equal(errors, '');
          assert.match(output, /dev\.\S+/);
        } finally { signal.removeEventListener('abort', stop); }
      }
      await lock.confirm(signal);
    } finally { await lock.release(); }
    assert.equal(lock.signal.aborted, false);
    for (const leaf of [f.executable, f.metadata]) await (await open(leaf, 'r+')).close();
    await rename(f.resourceRoot, moved);
    await rename(moved, f.resourceRoot);
  });

test('native Windows guard refuses reparse ancestors, reparse leaves and a nonsingle-link leaf',
  {skip: skipNative}, async t => {
    const f = await fixture(t);
    const parent = path.dirname(f.resourceRoot);
    const alias = path.join(parent, 'alias');
    const hard = path.join(parent, 'hard');
    const signal = AbortSignal.timeout(10000);
    await symlink(parent, alias, 'junction');
    try {
      await assert.rejects(lockWindowsResources(path.join(alias, 'resources'), nativePython, signal), /resource lock unavailable/);
    } finally { await unlink(alias); }
    await link(f.executable, hard);
    try {
      await assert.rejects(lockWindowsResources(f.resourceRoot, nativePython, signal), /resource lock unavailable/);
    } finally { await unlink(hard); }
    const moved = path.join(parent, 'moved-leaf');
    await f.move(f.executable, moved);
    await symlink(f.stage, f.executable, 'junction');
    try {
      await assert.rejects(lockWindowsResources(f.resourceRoot, nativePython, signal), /resource lock unavailable/);
    } finally {
      await unlink(f.executable);
      await f.move(moved, f.executable);
    }
  });

test('native Windows guard releases after verifier success, cancellation and timeout',
  {skip: skipNative}, async t => {
    for (const outcome of ['success', 'cancel', 'timeout']) {
      const f = await fixture(t, outcome === 'success' ? code : 'setTimeout(()=>process.stdout.write("{}\\n"), 5000)', {
        python: nativePython, spawnLock: spawn,
      });
      const controller = new AbortController();
      const pending = f.run({signal: controller.signal, timeoutMs: outcome === 'timeout' ? 1500 : 8000});
      const started = await Promise.race([f.started.then(() => true), pending.then(() => false, () => false)]);
      assert.equal(started, true, 'verifier should acquire the native lock and start the original child');
      if (outcome === 'cancel') controller.abort();
      if (outcome === 'success') assert.deepEqual(await pending, Buffer.from(report));
      else await assert.rejects(pending, /verifier unavailable/);
      assert.equal(f.closed, 1);
      await (await open(f.executable, 'r+')).close();
      await (await open(f.metadata, 'r+')).close();
    }
  });
