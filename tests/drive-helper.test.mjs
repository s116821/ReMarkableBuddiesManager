import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startHelper } from '../host/browser-helper.mjs';
import { unavailableDrive } from '../host/drive-protocol.mjs';

test('real helper Drive API retains origin/cookie/fixed-action/canonical-body and confirmation guards', async t => {
  const called = []; const driveAuth = Object.fromEntries(['status', 'begin', 'cancel', 'check', 'disconnect', 'revoke'].map(action => [action, async value => { called.push({ action, value }); return unavailableDrive(); }])); driveAuth.dispose = () => {};
  const helper = await startHelper({ root: path.resolve('dist/manager/browser'), driveAuth }); t.after(() => helper.close());
  const response = await fetch(helper.origin + '/preview/'); const cookie = response.headers.get('set-cookie').split(';')[0]; await response.text();
  const request = (body, override = {}) => fetch(helper.origin + '/manager-drive', { method: 'POST', headers: { Origin: helper.origin, 'Content-Type': 'application/json', Cookie: cookie, ...override }, body });
  assert.equal((await request('{"action":"status"}')).status, 200); assert.equal(called.length, 1);
  assert.equal((await request('{"action":"status"}', { Origin: 'http://other.invalid' })).status, 403);
  assert.equal((await request('{"action":"status"}', { Cookie: 'wrong' })).status, 403);
  assert.equal((await request('{"action":"read-file","path":"/private"}')).status, 400);
  assert.equal((await request('{"action":"status","action":"disconnect"}')).status, 400);
  assert.equal((await request('{"action":"revoke"}')).status, 400);
  assert.equal((await request(JSON.stringify({ action: 'revoke', authorizationId: '1'.repeat(64) }))).status, 200);
  assert.deepEqual(called, [{ action: 'status', value: undefined }, { action: 'revoke', value: '1'.repeat(64) }]);
  assert.equal((await request('x'.repeat(193))).status, 413);
});
