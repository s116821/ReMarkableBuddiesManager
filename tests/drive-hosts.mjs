import {readTabletFor, showPanel} from './fixtures/navigation.mjs';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { unavailableDrive } from '../host/drive-protocol.mjs';
import {tabletDriveHostFixture} from './fixtures/tablet-drive-hosts.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'manager-drive-ui-'));
await mkdir('test-results', { recursive: true });
const state = status => ({ ...unavailableDrive(), status, error: null });
const connected = () => ({ ...state('connected'), account: { label: 'fixture@example.invalid' }, checkedAt: new Date().toISOString(), authorizationId: '1'.repeat(64) });
async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://api.github.com/repos/s116821/ReMarkableBuddies/releases/latest' || url === 'https://api.github.com/repos/s116821/ReMarkableBuddiesManager/releases/latest') return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    if (url.startsWith('file:') || (origin && new URL(url).origin === origin)) return route.continue();
    return route.abort();
  });
}
async function verify(page, publish, host, capture = () => page.screenshot({ path: `test-results/drive-${host}.png`, fullPage: true })) {
 await showPanel(page,'drive');
  const status = page.getByTestId('drive-status');
  await status.filter({ hasText: 'Not signed in' }).waitFor();
  await showPanel(page, 'cloud');
  await expect(page.getByRole('button', {name: /Open Tablet/})).toHaveCount(0);
  await page.getByRole('button', {name: 'Open Google account'}).click();
  await expect(status).toContainText('Not signed in');
  const sign = page.getByRole('button', { name: 'Sign in to Google Drive', exact: true });
  await sign.click(); await status.filter({ hasText: 'Waiting for Google' }).waitFor();
  const consent = page.getByRole('link', { name: 'Continue sign-in with Google' });
  assert.equal(await consent.count(), 1); assert.match(await consent.getAttribute('href'), /^https:\/\/accounts.google.com\/o\/oauth2\/v2\/auth/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await status.filter({ hasText: 'cancelled' }).waitFor();
  const saved = connected();
  await publish(saved); await sign.click(); await status.filter({ hasText: 'Google Drive connected' }).waitFor();
  assert.equal(await page.getByTestId('drive-account').textContent(), 'fixture@example.invalid');
  const check = page.getByRole('button', { name: 'Check connection', exact: true });
  const reconnect = page.getByText('Google requires a new sign-in. Choose Sign in to Google Drive to reconnect.', { exact: true });
  const failedCheck = { ...saved, status: 'authorization-failed', authorizationId: null };
  await publish({ ...failedCheck, error: 'authorization-required' });
  await check.click();
  await reconnect.waitFor();
  await page.getByText(`Last checked: ${saved.checkedAt}`, { exact: true }).waitFor();
  assert.equal(await sign.isEnabled(), true);
  await publish({ ...state('disconnected'), error: 'authorization-required' });
  await check.click();
  await expect(page.getByText('Manager’s Google registration changed.', {exact: false})).toBeVisible();
  await expect(sign).toBeEnabled();
  await expect(check).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Remove Google access…', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Disconnect this Manager', exact: true})).toBeEnabled();
  await publish({ ...failedCheck, error: 'authorization-failed' });
  await sign.click();
  await reconnect.waitFor({ state: 'hidden' });
  await status.filter({ hasText: 'Sign-in or account check failed' }).waitFor();
  await publish(saved);
  await check.click();
  await status.filter({ hasText: 'Google Drive connected' }).waitFor();
  await showPanel(page,'cloud');
  await page.getByTestId('cloud-backup-status').filter({hasText: 'Scan for isolated Buddy backups.'}).waitFor();
  await expect(page.getByRole('button', {name: /Open Tablet/})).toHaveCount(0);
  assert.equal(await page.getByRole('button', {name: 'Scan for cloud backups', exact: true}).isEnabled(), true);
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await showPanel(page,'drive');
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#drive-title').scrollIntoViewIfNeeded(); await capture();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Remove Google access…', exact: true }).click(); assert.equal(await status.textContent(), 'Google Drive connected');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Remove Google access…', exact: true }).click(); await status.filter({ hasText: 'removal could not be confirmed' }).waitFor();
  await page.getByRole('button', { name: 'Disconnect this Manager', exact: true }).click(); await status.filter({ hasText: 'Not signed in' }).waitFor();
  await publish({ ...connected(), access_token: 'SYNTHETIC_PRIVATE_SENTINEL' }); await sign.click(); await status.filter({ hasText: 'connection unavailable' }).waitFor();
  assert.equal(await page.getByText('SYNTHETIC_PRIVATE_SENTINEL').count(), 0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  console.log(`${host}: actual sandbox/shared UI with explicit synthetic auth-state responses; no live Google proof`);
}
async function verifyTabletDrive(page, peer, host) {
  await readTabletFor(page, 'drive');
  const panel = page.getByTestId('tablet-drive-setup');
  const status = panel.getByTestId('tablet-drive-status');
  const connect = panel.getByRole('button', {name: 'Connect this tablet…', exact: true});
  const save = panel.getByRole('button', {name: 'Save tablet connection', exact: true});
  const check = panel.getByRole('button', {name: 'Check original tablet change', exact: true});
  const consent = panel.getByRole('link', {name: 'Continue tablet sign-in with Google', exact: true});
  const editModel = page.getByRole('button', {name: 'Edit model', exact: true});
  await showPanel(page, 'model');
  await expect(editModel).toBeEnabled();
  await showPanel(page, 'drive');
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(status).toContainText('Finish signing in with Google');
  await expect(save).toHaveCount(0);
  if (host === 'browser') {
    await expect(consent).toHaveAttribute('href', /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  } else await expect(consent).toHaveCount(0);
  await peer.completeConsent();
  await expect(panel.getByText('Synthetic account', {exact: true})).toBeVisible();
  await expect(save).toBeEnabled();
  const review = await peer.snapshot();
  assert.equal(review.takes, 1);
  assert.equal(review.applies, 0, 'showing the account does not write a credential');
  await save.click();
  try {
    await expect.poll(async () => (await peer.snapshot()).applies).toBe(1);
    const held = await peer.snapshot();
    assert.equal(held.originals.length, 1);
    await showPanel(page, 'model');
    await expect(editModel).toBeDisabled();
    await editModel.evaluate(button => button.click());
    await showPanel(page, 'drive');
    const afterNavigation = await peer.snapshot();
    assert.equal(afterNavigation.applies, 1);
    assert.equal(afterNavigation.wiredCalls, held.wiredCalls);
    assert.equal(afterNavigation.wiredCancels, held.wiredCancels);
    assert.deepEqual(afterNavigation.originals, held.originals);
  } finally {
    await peer.releaseApply();
  }
  await expect(status).toContainText(/result is unknown|response was lost/i);
  const pending = await peer.snapshot();
  assert.equal(pending.applies, 1);
  assert.equal(pending.originals.length, 1);

  await page.reload();
  await readTabletFor(page, 'drive');
  await expect(check).toBeEnabled();
  await check.click();
  await expect(status).toContainText('The requested credential state is present on the tablet');
  await expect(check).toHaveCount(0);
  const recovered = await peer.snapshot();
  assert.equal(recovered.applies, 1);
  assert.deepEqual(recovered.readbacks, [pending.originals[0].readback]);
  assert.deepEqual(recovered.originals, []);

  await peer.holdBegin();
  await connect.click();
  await expect.poll(async () => (await peer.snapshot()).held).toBe(true);
  try { await showPanel(page, 'cloud'); }
  finally { await peer.releaseBegin(); }
  await expect.poll(async () => (await peer.snapshot()).finishes).toBe(recovered.finishes + 1);
  await expect.poll(async () => (await peer.snapshot()).cancels).toBeGreaterThan(recovered.cancels);
  await showPanel(page, 'drive');
  await expect(connect).toBeEnabled();
  await expect(save).toHaveCount(0);
  await expect(consent).toHaveCount(0);
  const navigated = await peer.snapshot();
  assert.equal(navigated.takes, 1);
  assert.equal(navigated.applies, 1);
  assert.deepEqual(navigated.originals, []);

  const replies = await peer.replies();
  for (const state of ['authorizing', 'ready', 'unknown', 'observed']) {
    assert.ok(replies.some(reply => reply.tablet_drive.state === state), 'Expected a reduced ' + state + ' reply');
  }
  const serialized = JSON.stringify(replies);
  for (const privateValue of ['synthetic-client-secret', 'synthetic-access', 'synthetic-refresh', 'synthetic-account',
    'client_secret', 'access_token', 'refresh_token', 'account_permission_id', 'credential_b64', 'binding_sha256',
    'mode_token', 'parent_identity_sha256', 'local_mode_raw']) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
    await expect(panel).not.toContainText(privateValue);
  }
  console.log(host + ': Tablet connection confirmation, original readback and navigation with synthetic peers');
}

function captureTabletDriveReplies(server) {
  const bodies = [];
  const track = (request, response) => {
    if (request.method !== 'POST' || request.url !== '/manager-tablet-drive') return;
    // Observe the actual helper response. The browser deliberately reloads
    // during recovery and Chromium can discard the previous document's bodies.
    const chunks = [];
    for (const method of ['write', 'end']) {
      const send = response[method];
      response[method] = function (...args) {
        const [chunk, encoding] = args;
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
        else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
        return send.apply(this, args);
      };
    }
    response.once('finish', () => {
      if (response.statusCode >= 200 && response.statusCode < 300) bodies.push(Buffer.concat(chunks));
    });
  };
  server.prependListener('request', track);
  return {
    replies: () => bodies.map(body => JSON.parse(body.toString('utf8'))),
    detach: () => server.off('request', track)
  };
}

let value = state('disconnected');
const browserTablet = tabletDriveHostFixture();
const cancelTablet = browserTablet.auth.cancel;
const fixtureAuth = Object.assign(browserTablet.auth, {
  status: async () => value, begin: async () => { const start = ['disconnected', 'cancelled'].includes(value.status); if (start) value = state('connecting'); return { state: value, authorizationUrl: start ? 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' : null }; },
  cancel: () => { cancelTablet(); if (value.status === 'connecting') value = state('cancelled'); return value; },
  check: async () => value, disconnect: async () => value = state('disconnected'),
  revoke: async id => { assert.equal(id, '1'.repeat(64)); return value = { ...connected(), status: 'revocation-unconfirmed', authorizationId: null, error: 'revocation-unconfirmed' }; }
});
const helper = await startHelper({ root: path.resolve('dist/manager/browser'), observer: browserTablet.observer,
  driveAuth: fixtureAuth, isolatedRootStore: {isolatedRootOperations: () => ({value: null, digest: null})} });
const browser = await chromium.launch();
try {
  const context = await browser.newContext(); await isolate(context, helper.origin);
  const page = await context.newPage(); await page.goto(helper.origin + '/preview/');
  await verify(page, async v => { value = v; }, 'browser');
  value = connected();
  await page.reload();
  const capture = captureTabletDriveReplies(helper.server);
  try {
    await verifyTabletDrive(page, {...browserTablet, replies: capture.replies}, 'browser');
  } finally { capture.detach(); }
} finally { await browser.close(); await helper.close(); }
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined;
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MANAGER_')));
const app = await electron.launch({ executablePath, args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: { ...shellEnv,
  MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: root, MANAGER_DRIVE_AUTH_ROOT: path.join(root, 'missing'), MANAGER_DRIVE_PYTHON: process.env.MANAGER_DRIVE_PYTHON ?? (process.platform === 'linux' ? '/usr/bin/python3' : process.env.MANAGER_WIRED_PYTHON) } });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  await app.evaluate(async ({ app, BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`); });
  const hasDistributedClient = existsSync(new URL('../host/google-drive-client-id', import.meta.url));
  await showPanel(page, 'drive');
  await expect(page.getByTestId('drive-status')).toContainText(hasDistributedClient ? 'Not signed in' : 'Google Drive setup required');
  assert.equal(await page.evaluate(() => window.managerHost.driveAuth.revoke('wrong').then(() => 'accepted', () => 'refused')), 'refused');
  // The real host checked first-run registration above; response substitution below
  // is an explicit renderer/preload/IPC fixture, not OAuth or Windows filesystem evidence.
  await app.evaluate(({ ipcMain }) => {
    globalThis.driveFixture = { contract_version: 1, status: 'disconnected', account: null, authorizationId: null, checkedAt: null, error: null, backupReady: false };
    for (const action of ['status', 'begin', 'cancel', 'check', 'disconnect', 'revoke']) ipcMain.removeHandler(`manager:drive:${action}`);
    ipcMain.handle('manager:drive:status', () => globalThis.driveFixture);
    ipcMain.handle('manager:drive:begin', () => { const start = ['disconnected', 'cancelled'].includes(globalThis.driveFixture.status); if (start) globalThis.driveFixture = { ...globalThis.driveFixture, status: 'connecting' }; return { state: globalThis.driveFixture, authorizationUrl: start ? 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' : null }; });
    for (const action of ['cancel', 'disconnect']) ipcMain.handle(`manager:drive:${action}`, () => globalThis.driveFixture = { contract_version: 1, status: action === 'cancel' ? 'cancelled' : 'disconnected', account: null, authorizationId: null, checkedAt: null, error: null, backupReady: false });
    ipcMain.handle('manager:drive:revoke', (_event, id) => { if (id !== '1'.repeat(64)) throw new Error('fixture confirmation refused'); return globalThis.driveFixture = { ...globalThis.driveFixture, status: 'revocation-unconfirmed', authorizationId: null, error: 'revocation-unconfirmed' }; });
    ipcMain.handle('manager:drive:check', () => globalThis.driveFixture);
  });
  const host = packaged ? 'desktop-packaged-IPC' : 'desktop-IPC';
  await page.reload(); await verify(page, value => app.evaluate((_electron, value) => { globalThis.driveFixture = value; }, value), host, async () => {
    // Match the existing desktop evidence path: capture a hidden native window
    // with Electron's supported stayAwake API, not Chromium's full-page capture.
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (image.isEmpty()) throw new Error('Drive desktop capture is empty');
      return image.toPNG().toString('base64');
    });
    await writeFile(`test-results/drive-${host}.png`, Buffer.from(png, 'base64'));
  });
  // Keep the actual IPC handler and preload. Substitute only provider,
  // protected storage and wired peers below the handler.
  await app.evaluate(({ app, ipcMain }, fixturePath) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path');
    const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(app.getAppPath(), 'host');
    const {DriveAuth} = require(path.join(hostRoot, 'drive-auth.mjs'));
    const {DriveStore} = require(path.join(hostRoot, 'drive-store.mjs'));
    const {WiredObserver} = require(path.join(hostRoot, 'observer.mjs'));
    const peers = require(fixturePath).tabletDriveHostFixture();
    globalThis.tabletDriveFixture = peers;
    for (const name of ['snapshot', 'beginTabletAuthorization', 'tabletAuthorizationStatus',
      'takeTabletAuthorization', 'ownsAuthorizationUrl', 'cancel']) {
      DriveAuth.prototype[name] = function (...args) {
        const value = peers.auth[name](...args);
        this.generation = peers.auth.generation;
        return value;
      };
    }
    for (const name of ['tabletDriveOperations', 'saveTabletDriveOperations']) {
      DriveStore.prototype[name] = (...args) => peers.store[name](...args);
    }
    WiredObserver.prototype.observe = async function () {
      const result = await peers.observer.observe();
      this.lastObservation = result.observation;
      return result;
    };
    WiredObserver.prototype.run = (...args) => peers.observer.run(...args);
    WiredObserver.prototype.cancel = () => peers.observer.cancel();
    const channel = 'manager:tabletDriveSetup';
    const invoke = ipcMain._invokeHandlers.get(channel);
    if (typeof invoke !== 'function') throw Error('Tablet Drive IPC handler missing');
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      const value = await invoke(...args);
      peers.replies.push(value);
      return value;
    });
  }, path.resolve('tests/fixtures/tablet-drive-hosts.mjs'));
  await app.evaluate((_electron, v) => { globalThis.driveFixture = v; }, connected());
  await page.reload();
  await verifyTabletDrive(page, {
    completeConsent: () => app.evaluate(() => globalThis.tabletDriveFixture.completeConsent()),
    holdBegin: () => app.evaluate(() => globalThis.tabletDriveFixture.holdBegin()),
    releaseBegin: () => app.evaluate(() => globalThis.tabletDriveFixture.releaseBegin()),
    releaseApply: () => app.evaluate(() => globalThis.tabletDriveFixture.releaseApply()),
    snapshot: () => app.evaluate(() => globalThis.tabletDriveFixture.snapshot()),
    replies: () => app.evaluate(() => globalThis.tabletDriveFixture.replies)
  }, host);
} finally { await app.close(); await rm(root, { recursive: true, force: true }); }
