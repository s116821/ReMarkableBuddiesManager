import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, readdir, realpath, rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'node:test';
import {IsolatedBackupVerifier} from '../host/isolated-backup-verifier.mjs';
import source from '../host/buddy-oracle-source.json' with {type: 'json'};

const corpus = fileURLToPath(new URL('./fixtures/isolated-backup-actual/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptBytes = await readFile(path.join(corpus, 'receipt.json'));
const receipt = JSON.parse(receiptBytes);
const selected = ['COMMAND', 'SHA256', 'BYTES'].map(key => process.env['READER_BUDDY_ARCHIVE_TEST_' + key]);
const required = process.env.MANAGER_REQUIRE_RETAINED_ORACLE === '1';

async function checkCorpus() {
  assert.deepEqual(await readFile(path.join(corpus, 'receipt.json')), receiptBytes);
  assert.equal(hash(receiptBytes), 'e90a495bb2e3a8c914a301b47b96d93b5946c9644bee4c3be8b06ede7c32f8b3');
  assert.equal(receipt.fixture_receipt_version, 1);
  assert.equal(receipt.synthetic_test_content_only, true);
  // Original clean author revision; published unchanged as Buddy f4f1b9a3.
  assert.equal(receipt.source.commit, 'efb05505bec17e086f940148442216f5bcf96f6c');
  assert.equal(receipt.source.compiled_commit, receipt.source.commit);
  assert.equal(receipt.source.tree, 'a4903c9787d7134fdd6d67c897f4e3cb8a1a21e5');
  assert.equal(receipt.source.cargo_lock_sha256, source.cargoLockSha256);
  assert.ok(receipt.source.sdk_source.endsWith('#' + source.sdkRevision));
  assert.deepEqual((await readdir(corpus)).sort(), ['complete', 'media-omitted', 'receipt.json']);
  for (const [name, value] of Object.entries(receipt.cases)) {
    assert.equal(value.directory, name);
    const root = path.join(corpus, name), found = [];
    async function visit(relative = '') {
      for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
        const member = relative ? relative + '/' + entry.name : entry.name;
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) {
          assert.ok(['data', 'data/objects'].includes(member));
          await visit(member);
        } else {
          assert.equal(entry.isFile(), true);
          found.push(member);
          assert.ok(Object.hasOwn(value.files, member), member);
          const bytes = await readFile(path.join(root, member));
          assert.deepEqual({bytes: bytes.length, sha256: hash(bytes)}, value.files[member]);
        }
      }
    }
    await visit();
    assert.deepEqual(found.sort(), Object.keys(value.files).sort());
    assert.equal(value.marker_sha256, value.files['isolated-backup.json'].sha256);
    assert.equal(value.expected_report.incomplete, name === 'media-omitted');
    assert.equal(value.expected_report.activation_performed, false);
  }
}

async function verifyRetainedReader(resourceRoot, verifier, python) {
  const hostRoot = path.dirname(resourceRoot);
  assert.equal(path.basename(resourceRoot), 'buddy-oracle');
  assert.equal(path.basename(hostRoot), 'host');
  assert.equal(path.basename(path.dirname(hostRoot)), 'resources');
  for (const name of ['isolated-backup-download.mjs', 'isolated-backup-staging.mjs', 'isolated-backup-staging.py']) {
    const file = path.join(hostRoot, name);
    assert.equal(await realpath(file), file);
    assert.equal((await lstat(file)).isFile(), true);
  }
  const {IsolatedBackupDownload} = await import(pathToFileURL(path.join(hostRoot, 'isolated-backup-download.mjs')));
  const {IsolatedBackupStaging} = await import(pathToFileURL(path.join(hostRoot, 'isolated-backup-staging.mjs')));
  const complete = receipt.cases.complete;
  const dataName = 'data/backup.json';
  const markerName = 'isolated-backup.json';
  const preferencesName = 'portable-configuration.json';
  const original = new Map(await Promise.all(Object.keys(complete.files).map(async name =>
    [name, await readFile(path.join(corpus, complete.directory, name))])));
  const root = {id: 'RetainedReaderRoot', backup: 'db766c9e-d346-41fd-aad4-17d754fd50c7'};
  const objects = [...original].filter(([name]) => name !== markerName).map(([name, contents], index) => ({
    contents,
    metadata: {
      id: 'RetainedReaderObject' + index, size: String(contents.length), spaces: ['appDataFolder'],
      trashed: false, mimeType: 'application/octet-stream',
      appProperties: {buddy_isolated: '1', kind: 'object', root: root.id, backup: root.backup,
        sha256: complete.files[name].sha256},
    },
  }));
  const selectionController = new AbortController();
  const signal = selectionController.signal;
  const current = () => !signal.aborted;
  const binding = {
    isCurrent: current,
    async checkCurrent(bounds) {
      signal.throwIfAborted();
      bounds.signal.throwIfAborted();
    },
    listObject({rootId, backup, sha256}) {
      assert.deepEqual({id: rootId, backup}, root);
      const files = objects.filter(object => object.metadata.appProperties.sha256 === sha256)
        .map(object => object.metadata);
      return Buffer.from(JSON.stringify({files, incompleteSearch: false}));
    },
    readObjectMetadata({id}) {
      return Buffer.from(JSON.stringify(objects.find(object => object.metadata.id === id).metadata));
    },
    async *streamObject({id, sha256, signal}) {
      signal.throwIfAborted();
      const object = objects.find(object => object.metadata.id === id);
      assert.equal(object.metadata.appProperties.sha256, sha256);
      if (object.contents.length) yield object.contents;
    },
  };
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), 'manager-retained-reader-'));
  const identity = await lstat(parent, {bigint: true});
  const staging = new IsolatedBackupStaging({python, parent, excludedRoots: [hostRoot, corpus]});
  const reader = new IsolatedBackupDownload({staging, verifier});
  try {
    if (process.platform === 'win32') {
      // Match the native staging fixture's owner-only, protected DACL.
      execFileSync(python, ['-I', '-B', '-c', [
        'import sys, win32api, win32con, win32security as security, ntsecuritycon',
        'token = security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)',
        'try:',
        '    owner = security.GetTokenInformation(token, security.TokenUser)[0]',
        'finally:',
        '    token.Close()',
        'acl = security.ACL()',
        'acl.AddAccessAllowedAceEx(security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS, owner)',
        'security.SetNamedSecurityInfo(sys.argv[1], security.SE_FILE_OBJECT, security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION, owner, None, acl, None)',
      ].join('\n'), parent], {windowsHide: true, timeout: 5000});
    }
    const operation = hash('retained reader operation'), reference = hash('retained reader selection');
    const result = await reader.download({
      operation, reference, current, binding,
      selection: {
        root, signal, marker: {id: 'RetainedReaderMarker', ...complete.files[markerName]},
        markerBytes: original.get(markerName),
        components: {data: complete.files[dataName], preferences: complete.files[preferencesName]},
      },
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.inspection.markerSha256, complete.marker_sha256);
    let readFile, member;
    const chunks = [];
    const handoff = await reader.handoff(operation, reference, async source => {
      member = source.files.find(file => file.name === dataName);
      readFile = source.readFile;
      await readFile(dataName, chunk => { chunks.push(chunk); });
    });
    assert.deepEqual(handoff, {status: 'handed-off', inspection: null, cleanupPending: false});
    assert.deepEqual(member, {name: dataName, ...complete.files[dataName]});
    const observed = Buffer.concat(chunks);
    assert.ok(observed.length > 0);
    assert.deepEqual(observed, original.get(dataName));
    assert.deepEqual({bytes: observed.length, sha256: hash(observed)}, complete.files[dataName]);
    await assert.rejects(readFile(dataName, () => assert.fail('Retired reader delivered bytes')));
    assert.deepEqual(await readdir(parent), []);
  } finally {
    selectionController.abort();
    assert.equal((await reader.dispose()).cleanupPending, false);
    const final = await lstat(parent, {bigint: true});
    assert.equal(await realpath(parent), parent);
    assert.ok(final.isDirectory() && !final.isSymbolicLink() && final.dev === identity.dev && final.ino === identity.ino);
    await rmdir(parent);
  }
}

test('actual isolated producer corpus retains its exact source receipt and file closure', checkCorpus);

test('retained host oracle verifies actual producer packages through the Manager verifier',
  {skip: !required && selected.every(value => value === undefined), timeout: 150000}, async () => {
    assert.ok(selected.every(value => typeof value === 'string' && value.length > 0), 'Retained command custody is required');
    const [command, sha256, bytes] = selected;
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.match(bytes, /^[1-9][0-9]*$/);
    const resourceRoot = await realpath(path.dirname(command));
    const metadata = JSON.parse(await readFile(path.join(resourceRoot, 'provenance.json')));
    assert.deepEqual(metadata.source, source);
    assert.equal(metadata.executable.name, path.basename(command));
    assert.equal(metadata.executable.sha256, sha256);
    assert.equal(String(metadata.executable.bytes), bytes);
    assert.equal(String((await lstat(command)).size), bytes);
    const python = process.env.MANAGER_DRIVE_PYTHON;
    assert.ok(python && path.isAbsolute(python), 'Trusted retained-host interpreter is required');
    const verifier = new IsolatedBackupVerifier({resourceRoot, python});
    const bounds = () => ({signal: new AbortController().signal, timeoutMs: 30000});
    await checkCorpus();
    assert.equal(await verifier.available(bounds()), true);
    for (const [name, value] of Object.entries(receipt.cases)) {
      const output = await verifier.verify({...bounds(), root: await realpath(path.join(corpus, name)),
        markerSha256: value.marker_sha256, maxBytes: 16384});
      assert.deepEqual(JSON.parse(output.toString('utf8')), value.expected_report);
      // The verifier reports the truthful omission. Complete-handoff policy is
      // owned by the download coordinator; this test does not enable a restore.
    }
    const wrongMarker = await verifier.verify({...bounds(), root: await realpath(path.join(corpus, 'complete')),
      markerSha256: '0'.repeat(64), maxBytes: 16384});
    assert.deepEqual(JSON.parse(wrongMarker.toString('utf8')), {
      report_version: 1, operation: 'inspect-isolated', status: 'unsupported', incomplete: false,
      activation_performed: false, data: null,
    });
    await verifyRetainedReader(resourceRoot, verifier, python);
    await checkCorpus(); // No config, Store, cache, credential or other output appeared.
  });
