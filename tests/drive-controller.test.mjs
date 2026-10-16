import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveController } from '../src/drive-auth.ts';
import { unavailableDrive } from '../host/drive-protocol.mjs';
const state = (status = 'disconnected') => ({ ...unavailableDrive(), status, error: null });
const adapter = () => ({ status: async () => state(), begin: async () => ({ state: state('connecting'), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' }),
  cancel: async () => state('cancelled'), check: async () => state(), disconnect: async () => state(), revoke: async () => state() });

test('shared controller rejects token-bearing status and arbitrary consent destinations', async () => {
  const a = adapter(); let seen; const c = new DriveController(a, s => { seen = s; });
  a.status = async () => ({ ...state(), access_token: 'synthetic-private' }); await c.load(); assert.equal(seen.status, 'unavailable'); assert.ok(!JSON.stringify(seen).includes('synthetic-private'));
  for (const url of ['https://other.invalid/', 'https://accounts.google.com/o/oauth2/v2/auth?code_verifier=synthetic-private', 'https://accounts.google.com/o/oauth2/v2/auth?state=one&state=two']) { a.begin = async () => ({ state: state('connecting'), authorizationUrl: url }); await c.begin(); assert.equal(seen.status, 'unavailable'); } c.dispose();
});
test('late start/check responses cannot replace cancelled or disconnected shared UI', async () => {
  for (const action of ['cancel', 'disconnect']) {
    const a = adapter(); let release; a.begin = () => new Promise(resolve => { release = resolve; });
    const c = new DriveController(a, () => {}); const pending = c.begin(); await c.action(action);
    release({ state: state('connecting'), authorizationUrl: null }); await pending; assert.equal(c.state.status, action === 'cancel' ? 'cancelled' : 'disconnected'); c.dispose();
  }
});
test('revocation carries only the host-issued confirmation ID from the displayed snapshot', async () => {
  const a = adapter(); const current = { ...state('cached'), account: { label: 'fixture@example.invalid' }, checkedAt: new Date().toISOString(), authorizationId: '1'.repeat(64) };
  a.status = async () => current; let received; a.revoke = async id => { received = id; return state(); };
  const c = new DriveController(a, () => {}); await c.load(); await c.action('revoke'); assert.equal(received, current.authorizationId); c.dispose();
});
