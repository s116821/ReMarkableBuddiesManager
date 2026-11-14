import assert from 'node:assert/strict';
import {mkdir, mkdtemp, lstat, readdir, readFile, realpath, rename, rmdir, symlink, open, unlink, chmod, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {IsolatedBackupStaging} from '../host/isolated-backup-staging.mjs';

const python = process.env.MANAGER_DRIVE_PYTHON ?? process.env.MANAGER_WIRED_PYTHON ??
  (process.platform === 'linux' ? '/usr/bin/python3' : null);
const native = !!python && ['linux', 'win32'].includes(process.platform) &&
  (process.platform !== 'win32' || spawnSync(python, ['-I', '-B', '-c', 'import win32file, win32security']).status === 0);
const options = (maxBytes = 0) => ({maxBytes, signal: new AbortController().signal, timeoutMs: 5000});
const inspect = name => lstat(name, {bigint: true});
const broker = fileURLToPath(new URL('../host/isolated-backup-staging.py', import.meta.url));

async function removeOwned(name, original, directory) {
  const current = await inspect(name);
  assert.equal(await realpath(name), name);
  assert.equal(current.isSymbolicLink(), false);
  assert.equal(current.isDirectory(), directory);
  assert.equal(current.dev, original.dev);
  assert.equal(current.ino, original.ino);
  if (directory) await rmdir(name);
  else await unlink(name);
}

const privateDirectory = [
  'import sys, win32api, win32con, win32security as security, ntsecuritycon',
  'token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)',
  'try:',
  '    owner = security.GetTokenInformation(token, security.TokenUser)[0]',
  'finally:',
  '    token.Close()',
  'acl = security.ACL()',
  'acl.AddAccessAllowedAceEx(security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS, owner)',
  'security.SetNamedSecurityInfo(sys.argv[1], security.SE_FILE_OBJECT, security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION, owner, None, acl, None)',
].join('\n');

async function fixture(t) {
  const temporary = await realpath(os.tmpdir());
  const namespace = await mkdtemp(path.join(temporary, 'manager-backup-staging-test-'));
  const namespaceId = await inspect(namespace);
  const parent = path.join(namespace, 'private'), excluded = path.join(namespace, 'unrelated');
  t.after(() => removeOwned(namespace, namespaceId, true));
  await mkdir(parent, {mode: 0o700});
  const original = await inspect(parent);
  if (process.platform === 'win32') {
    const adjusted = spawnSync(python, ['-I', '-B', '-c', privateDirectory, parent], {windowsHide: true});
    assert.equal(adjusted.status, 0, adjusted.stderr?.toString());
  }
  return {parent, excluded, async close() { await removeOwned(parent, original, true); },
    adapter: new IsolatedBackupStaging({parent, python, excludedRoots: [excluded]})};
}

async function write(stage, name, bytes) {
  const payload = Buffer.from(bytes);
  const file = await stage.openExclusive(name, options(payload.length));
  try {
    if (payload.length) await file.write(payload);
    await file.sync();
  } finally { await file.close(); }
}

test('default and relative-path staging stay unavailable', async () => {
  for (const adapter of [new IsolatedBackupStaging(), new IsolatedBackupStaging({parent: '.', python: 'python'})]) {
    assert.equal(await adapter.available(options()), false);
    await assert.rejects(adapter.create(options()), /staging unavailable/);
  }
});

test('native stage uses fixed exclusive entries, exact writes, marker-last membership and checked release',
  {skip: !native}, async t => {
    const f = await fixture(t);
    try {
      assert.equal(await f.adapter.available(options()), true);
      assert.ok(await f.adapter.freeBytes(null, options()) > 0);
      const stage = await f.adapter.create(options());
      try {
        assert.equal(path.dirname(stage.root), f.parent);
        assert.ok(await f.adapter.freeBytes(stage.root, options()) > 0);
        await assert.rejects(f.adapter.freeBytes(path.dirname(stage.root), options()), /staging unavailable/);
        await assert.rejects(stage.openExclusive('../out', options(1)), /staging unavailable/);
        await assert.rejects(stage.openExclusive('data/objects/' + '1'.repeat(64), options(0)), /staging unavailable/);
        const data = 'data/backup.json', zero = 'data/objects/' + '1'.repeat(64);
        await write(stage, data, 'manifest');
        await assert.rejects(stage.openExclusive(data, options(1)), /staging unavailable/);
        await write(stage, zero, '');
        await assert.rejects(stage.openExclusive('isolated-backup.json', options(1)), /staging unavailable/);
        await write(stage, 'portable-configuration.json', 'settings');
        await write(stage, 'isolated-backup.json', 'marker');
        assert.equal((await readFile(path.join(stage.root, data))).toString(), 'manifest');
        assert.equal((await inspect(path.join(stage.root, zero))).size, 0n);
        const members = [data, zero, 'portable-configuration.json', 'isolated-backup.json'];
        assert.equal(await stage.assertOwned(members, options()), true);
        assert.equal(await stage.assertOwned(members.slice(1), options()), false);
        if (process.platform === 'linux') {
          assert.equal(Number((await inspect(stage.root)).mode & 0o777n), 0o700);
          assert.equal(Number((await inspect(path.join(stage.root, data))).mode & 0o777n), 0o600);
        }
      } finally { await stage.release(); }
      assert.deepEqual(await readdir(f.parent), []);
    } finally { await f.close(); }
  });

test('native release refuses an open file, then removes the exact partial transfer after close',
  {skip: !native}, async t => {
    const f = await fixture(t);
    try {
      const stage = await f.adapter.create(options());
      const file = await stage.openExclusive('data/backup.json', options(3));
      await file.write(Buffer.from('ab'));
      await assert.rejects(file.write(Buffer.from('cd')), /staging unavailable/);
      await assert.rejects(file.sync(), /staging unavailable/);
      await assert.rejects(stage.release(), /staging unavailable/);
      await file.close();
      await stage.release();
      assert.deepEqual(await readdir(f.parent), []);
    } finally { await f.close(); }
  });

test('native cleanup preserves unexpected files and refuses replacement identity',
  {skip: !native}, async t => {
    for (const replace of [false, true]) {
      const f = await fixture(t);
      const stage = await f.adapter.create(options());
      const dirs = [stage.root, path.join(stage.root, 'data'), path.join(stage.root, 'data', 'objects')];
      const dirIds = await Promise.all(dirs.map(inspect));
      const data = path.join(stage.root, 'data', 'backup.json');
      await write(stage, 'data/backup.json', 'original');
      const dataId = await inspect(data);
      const moved = path.join(stage.root, 'data', 'moved'), unexpected = replace ? data : path.join(stage.root, 'unexpected');
      if (replace) await rename(data, moved);
      const extra = await open(unexpected, 'wx', 0o600);
      await extra.writeFile('replacement');
      await extra.close();
      const extraId = await inspect(unexpected);
      await assert.rejects(stage.release(), /staging unavailable/);
      assert.equal((await readFile(unexpected)).toString(), 'replacement');
      assert.equal((await readFile(replace ? moved : data)).toString(), 'original');
      await removeOwned(unexpected, extraId, false);
      await removeOwned(replace ? moved : data, dataId, false);
      for (let i = dirs.length - 1; i >= 0; i--) await removeOwned(dirs[i], dirIds[i], true);
      await f.close();
    }
  });

test('Linux refuses unsafe parent mode, symlink parent and overlap with an excluded root',
  {skip: !native || process.platform !== 'linux'}, async t => {
    const f = await fixture(t);
    try {
      const link = f.excluded;
      await symlink(f.parent, link, 'dir');
      const linkId = await inspect(link);
      try {
        const linked = new IsolatedBackupStaging({parent: link, python, excludedRoots: [path.join(f.parent, '..', 'separate')]});
        assert.equal(await linked.available(options()), false);
        const overlapping = new IsolatedBackupStaging({parent: f.parent, python, excludedRoots: [link]});
        assert.equal(await overlapping.available(options()), false);
        await chmod(f.parent, 0o755);
        assert.equal(await f.adapter.available(options()), false);
        await chmod(f.parent, 0o700);
      } finally {
        const current = await inspect(link);
        assert.ok(current.isSymbolicLink() && current.dev === linkId.dev && current.ino === linkId.ino);
        assert.equal(await realpath(path.dirname(link)), path.dirname(link));
        await unlink(link);
      }
    } finally { await f.close(); }
  });

test('configured broker refuses unavailable platform custody without a stage',
  {skip: !python || native}, async t => {
    const temporary = await realpath(os.tmpdir());
    const namespace = await mkdtemp(path.join(temporary, 'manager-backup-refused-test-'));
    const original = await inspect(namespace);
    t.after(() => removeOwned(namespace, original, true));
    const parent = path.join(namespace, 'private');
    await mkdir(parent, {mode: 0o700});
    const parentId = await inspect(parent);
    try {
      const adapter = new IsolatedBackupStaging({parent, python, excludedRoots: [path.join(namespace, 'other')]});
      assert.equal(await adapter.available(options()), false);
      await assert.rejects(adapter.create(options()), /staging unavailable/);
      assert.deepEqual(await readdir(parent), []);
      const result = spawnSync(python, ['-I', '-B', broker, parent, '[]'], {
        input: '{"action":"probe"}\n', windowsHide: true,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stderr.length, 0);
    } finally { await removeOwned(parent, parentId, true); }
  });

test('interrupted create preserves residue and reports uncertain cleanup',
  {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t);
    const parent = path.dirname(f.parent);
    const executable = path.join(parent, 'interrupted-broker');
    const residue = path.join(f.parent, 'isolated-backup-' + 'a'.repeat(32));
    const program = [
      '#!/bin/sh',
      'IFS= read -r request || exit 2',
      '[ "$request" = \'{"action":"create"}\' ] || exit 3',
      'mkdir -m 700 -- "$4/isolated-backup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || exit 4',
      'printf \'{"ok":false}\\n\'',
      'exit 7',
    ].join('\n') + '\n';
    await writeFile(executable, program, {mode: 0o700, flag: 'wx'});
    const executableId = await inspect(executable);
    try {
      const staging = new IsolatedBackupStaging({parent: f.parent, python: executable, excludedRoots: [f.excluded]});
      await assert.rejects(staging.create(options()), {message: 'Private backup staging unavailable', cleanupPending: true});
      assert.deepEqual(await readdir(f.parent), [path.basename(residue)]);
      await removeOwned(residue, await inspect(residue), true);
    } finally {
      await removeOwned(executable, executableId, false);
      await f.close();
    }
  });
