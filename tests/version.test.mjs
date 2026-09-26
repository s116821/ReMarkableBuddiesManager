import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildInfo } from '../scripts/version.mjs';

test('official metadata is exact clean tag/SHA; developer builds never impersonate releases', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'manager-version-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(dir, 'app.txt'), 'fixture'); git('add', '.'); git('commit', '-m', 'feat(test): fixture');
    git('tag', 'v0.1.0'); const sha = git('rev-parse', 'HEAD');
    const env = { MANAGER_RELEASE_TAG: 'v0.1.0', MANAGER_RELEASE_SHA: sha };
    assert.match(buildInfo(dir, {}).version, /-dev-/);
    assert.deepEqual(buildInfo(dir, env), { version: '0.1.0', sha, tag: 'v0.1.0', official: true });
    assert.throws(() => buildInfo(dir, { ...env, MANAGER_RELEASE_SHA: 'wrong' }), /mismatch/);
    assert.throws(() => buildInfo(dir, { ...env, MANAGER_RELEASE_TAG: 'v1.0.0' }), /REM-35/);
    writeFileSync(path.join(dir, 'app.txt'), 'changed');
    assert.throws(() => buildInfo(dir, env), /clean full history/);
    assert.match(buildInfo(dir, {}).version, /-dirty$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
