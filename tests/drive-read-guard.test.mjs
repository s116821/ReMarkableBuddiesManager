import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat, mkdir, mkdtemp, realpath, rename, rmdir, unlink, writeFile, chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DriveReadGuard} from '../host/drive-read-guard.mjs';
import {DriveAuth, DRIVE_SCOPE} from '../host/drive-auth.mjs';
import {DriveStore} from '../host/drive-store.mjs';

const python = process.env.MANAGER_DRIVE_PYTHON ?? process.env.MANAGER_WIRED_PYTHON ??
  (process.platform === 'linux' ? '/usr/bin/python3' : null);
const native = !!python && (process.platform === 'linux' ?
  spawnSync(python, ['-I', '-B', '-c', 'from pathlib import Path; assert hasattr(Path, "is_junction")']).status === 0 :
  process.platform === 'win32' && spawnSync(python, ['-I', '-B', '-c', 'import win32file, win32security']).status === 0);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const client = Buffer.from('{"registration":"synthetic client"}\n');
const grant = Buffer.from('{"credential":"synthetic original grant"}\n');
const changed = Buffer.from('{"credential":"synthetic changed grant!"}\n');
const stat = target => lstat(target, {bigint: true});
const missing = async target => stat(target).then(() => false, error => {
  if (error.code === 'ENOENT') return true;
  throw error;
});

const aclScript = [
  'import sys, win32api, win32con, win32security as security, ntsecuritycon',
  'token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)',
  'try:',
  '    sid = security.GetTokenInformation(token, security.TokenUser)[0]',
  'finally:',
  '    token.Close()',
  'acl = security.ACL()',
  'acl.AddAccessAllowedAceEx(security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS, sid)',
  'security.SetNamedSecurityInfo(sys.argv[1], security.SE_FILE_OBJECT, security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION, sid, None, acl, None)',
].join('\n');

async function removeOwned(target, original, directory) {
  assert.equal(await realpath(target), target);
  const current = await stat(target);
  assert.equal(current.isSymbolicLink(), false);
  assert.equal(current.isDirectory(), directory);
  assert.equal(current.dev, original.dev);
  assert.equal(current.ino, original.ino);
  if (directory) await rmdir(target);
  else await unlink(target);
}

async function fixture(t, {clientBytes = client, grantBytes = grant} = {}) {
  const temporary = await realpath(os.tmpdir());
  const namespace = await mkdtemp(path.join(temporary, 'manager-read-guard-test-'));
  const outer = await stat(namespace);
  const root = path.join(namespace, 'drive');
  await mkdir(root, {mode: 0o700});
  const original = await stat(root);
  if (process.platform === 'win32') {
    const set = spawnSync(python, ['-I', '-B', '-c', aclScript, root], {windowsHide: true});
    assert.equal(set.status, 0, set.stderr?.toString());
  }
  const files = new Map();
  const create = async (name, bytes) => {
    const target = path.join(root, name);
    await writeFile(target, bytes, {flag: 'wx', mode: 0o600});
    const id = await stat(target);
    files.set(target, id);
    return target;
  };
  const clientPath = await create('client.json', clientBytes);
  const grantPath = await create('grant.json', grantBytes);
  const authority = new AbortController();
  t.after(async () => {
    authority.abort();
    for (const [target, id] of files) if (!await missing(target)) await removeOwned(target, id, false);
    await removeOwned(root, original, true);
    await removeOwned(namespace, outer, true);
  });
  const args = {root, python, clientDigest: sha(clientBytes), grantDigest: sha(grantBytes), signal: authority.signal};
  return {
    args, root, clientPath, grantPath, authority,
    async recordGrantReplacement() {
      assert.equal(await realpath(grantPath), grantPath);
      const replaced = await stat(grantPath);
      assert.ok(replaced.isFile() && !replaced.isSymbolicLink());
      files.set(grantPath, replaced);
    },
    async replaceGrant() {
      const replacement = await create('next.json', changed);
      const replacementId = files.get(replacement);
      // Atomic replacement is confined to two exact, verified synthetic files.
      for (const target of [replacement, grantPath]) {
        const id = await stat(target), original = files.get(target);
        assert.equal(await realpath(target), target);
        assert.equal(id.dev, original.dev);
        assert.equal(id.ino, original.ino);
      }
      await rename(replacement, grantPath);
      files.set(grantPath, replacementId);
    },
    async open() {
      const guard = await DriveReadGuard.open(args);
      t.after(() => guard.close());
      return guard;
    },
  };
}

test('missing or malformed original capture refuses before connecting to a child', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(DriveReadGuard.open({python: 'python', root: '.', signal}), /authority unavailable/);
  await assert.rejects(DriveReadGuard.open({python, root: '.', clientDigest: sha(client), grantDigest: sha(grant), signal}),
    /authority unavailable/);
});

test('original registration and grant are both required at admission', {skip: !native}, async t => {
  const f = await fixture(t);
  for (const field of ['clientDigest', 'grantDigest']) {
    await assert.rejects(DriveReadGuard.open({...f.args, [field]: '0'.repeat(64)}), /authority unavailable/);
  }
  const guard = await f.open();
  assert.equal(await guard.check(), true);
  await guard.close();
  assert.equal(guard.signal.aborted, true);
});

test('one native guard serves a 4096-chunk before/after path without materializing payload data', {skip: !native}, async t => {
  const f = await fixture(t);
  const guard = await f.open();
  const children = new Set([guard.pid]);
  assert.ok(Number.isInteger(guard.pid));
  const started = performance.now();
  let responsive = false;
  setImmediate(() => { responsive = true; });
  for (let chunk = 0; chunk < 4096; chunk++) {
    assert.equal(await guard.check(), true);
    assert.equal(await guard.check(), true);
    children.add(guard.pid);
  }
  const elapsed = Math.round(performance.now() - started);
  assert.equal(responsive, true);
  assert.equal(children.size, 1);
  assert.ok(elapsed < 120000, 'authority checks exceeded the supported transfer window');
  t.diagnostic('8192 native before/after checks, ' + children.size + ' persistent child, ' + elapsed + ' ms');
  await guard.close();
});

test('external in-place registration change and atomic grant replacement revoke the original child', {skip: !native}, async t => {
  for (const type of ['grant', 'client']) {
    const f = await fixture(t);
    const guard = await f.open();
    assert.equal(await guard.check(), true);
    const pid = guard.pid;
    if (type === 'grant') await f.replaceGrant();
    else await writeFile(f.clientPath, Buffer.from('{"registration":"synthetic moved!"}\n'));
    await assert.rejects(guard.check(), /authority unavailable/);
    assert.equal(guard.signal.aborted, true);
    assert.equal(guard.pid, pid);
    if (type === 'client') await writeFile(f.clientPath, client);
    await assert.rejects(guard.check(), /authority unavailable/);
  }
});

test('in-flight original grant abort invalidates promptly and joins the same child', {skip: !native}, async t => {
  const f = await fixture(t);
  const guard = await f.open();
  const current = guard.check();
  f.authority.abort();
  assert.equal(guard.signal.aborted, true);
  await assert.rejects(current, /authority unavailable/);
  await guard.close();
  await assert.rejects(guard.check(), /authority unavailable/);
});

test('native protected reader rejects permission changes instead of trusting an unchanged digest', {
  skip: !native || process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  const guard = await f.open();
  await chmod(f.grantPath, 0o644);
  await assert.rejects(guard.check(), /authority unavailable/);
  assert.equal(guard.signal.aborted, true);
});

test('composed native authority streams 4096 reused chunks and rejects changed or cancelled grants', {
  skip: !native, timeout: 90000,
}, async t => {
  const config = {schema: 1, type: 'google-desktop', clientId: '123456789012-fixture.apps.googleusercontent.com', clientSecret: null};
  const saved = {schema: 1, clientId: config.clientId, checkedAt: Date.now(),
    account: {label: 'fixture@example.invalid', permissionId: 'synthetic-permission-id'},
    tokens: {access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
      expiry_date: Date.now() + 300000, scope: DRIVE_SCOPE, token_type: 'Bearer'}};
  for (const outcome of ['healthy', 'mutation', 'cancel']) {
    const f = await fixture(t, {clientBytes: Buffer.from(JSON.stringify(config)), grantBytes: Buffer.from(JSON.stringify(saved))});
    const store = new DriveStore({root: f.root, python});
    const operations = [], children = [];
    const originalOperation = store.operation.bind(store), openGuard = store.openReadGuard.bind(store);
    store.operation = request => { operations.push(request.operation); return originalOperation(request); };
    store.openReadGuard = async request => {
      const guard = await openGuard(request);
      children.push(guard);
      return guard;
    };
    const chunk = Buffer.alloc(65536);
    let joined = 0, sawAbort = false;
    const auth = new DriveAuth({store, backupReadFactory: () => ({
      list: () => assert.fail('unexpected list'),
      readMetadata: () => assert.fail('unexpected metadata'),
      readMarker: () => assert.fail('unexpected marker'),
      listObject: () => assert.fail('unexpected object lookup'),
      readObjectMetadata: () => assert.fail('unexpected object metadata'),
      async *streamObject({signal}) {
        try {
          for (let i = 0; i < 4096; i++) yield chunk;
        } finally { joined++; sawAbort = signal.aborted; }
      },
    })});
    try {
      auth.oauth = () => ({setCredentials() {}, refreshAccessToken: () => assert.fail('unexpected refresh')});
      auth.account = async () => ({account: saved.account, tokens: saved.tokens});
      assert.equal((await auth.check()).status, 'connected');
      // DriveStore.check performed a normal synthetic atomic grant CAS.
      await f.recordGrantReplacement();
      const beforeCapture = operations.length;
      const capture = auth.openBackupRead(f.authority.signal);
      assert.equal(capture.status, 'qualified');
      assert.deepEqual(operations.slice(beforeCapture), ['read-client', 'read-grant']);
      const beforeStream = operations.length, started = performance.now();
      let accepted = 0, responsive = false;
      setImmediate(() => { responsive = true; });
      const stream = async () => {
        for await (const bytes of capture.binding.streamObject({
          id: 'SyntheticObject', sha256: 'a'.repeat(64), maxBytes: 256 * 1024 * 1024,
          timeoutMs: 5000, signal: f.authority.signal,
        })) {
          assert.equal(bytes, chunk);
          accepted++;
          if (accepted === 2 && outcome === 'mutation') await f.replaceGrant();
          if (accepted === 2 && outcome === 'cancel') setImmediate(() => auth.cancel());
        }
      };
      if (outcome === 'healthy') {
        await stream();
        assert.equal(accepted, 4096);
        t.diagnostic('4096 chunks through DriveStore and DriveAuth, one child, zero synchronous store calls after admission, ' +
          Math.round(performance.now() - started) + ' ms');
      } else {
        await assert.rejects(stream(), /authorization-failed/);
        assert.equal(accepted, 2);
        assert.equal(capture.signal.aborted, true);
        assert.equal(sawAbort, true);
      }
      assert.equal(joined, 1);
      assert.equal(responsive, true);
      assert.equal(operations.length, beforeStream);
      assert.equal(children.length, 1);
      assert.ok(Number.isInteger(children[0].pid));
    } finally {
      auth.dispose();
      await Promise.all(children.map(guard => guard.close()));
    }
  }
});
