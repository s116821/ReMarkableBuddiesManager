import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
    const verifier = new IsolatedBackupVerifier({resourceRoot, python: process.env.MANAGER_DRIVE_PYTHON});
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
    await checkCorpus(); // No config, Store, cache, credential or other output appeared.
  });
