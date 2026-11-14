import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat, mkdir, mkdtemp, realpath, rename, rmdir, unlink, writeFile, chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DriveReadGuard} from '../host/drive-read-guard.mjs';

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

async function fixture(t) {
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
  const clientPath = await create('client.json', client);
  const grantPath = await create('grant.json', grant);
  const authority = new AbortController();
  t.after(async () => {
    authority.abort();
    for (const [target, id] of files) if (!await missing(target)) await removeOwned(target, id, false);
    await removeOwned(root, original, true);
    await removeOwned(namespace, outer, true);
  });
  const args = {root, python, clientDigest: sha(client), grantDigest: sha(grant), signal: authority.signal};
  return {
    args, root, clientPath, grantPath, authority,
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
