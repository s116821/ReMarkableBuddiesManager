import { chromium, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startHelper } from '../host/browser-helper.mjs';
import { unavailableDrive } from '../host/drive-protocol.mjs';
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
async function verify(page, publish, host) {
  const status = page.getByTestId('drive-status');
  await status.filter({ hasText: 'Not signed in' }).waitFor();
  const sign = page.getByRole('button', { name: 'Sign in to Google Drive', exact: true });
  await sign.click(); await status.filter({ hasText: 'Waiting for Google' }).waitFor();
  const consent = page.getByRole('link', { name: 'Continue sign-in with Google' });
  assert.equal(await consent.count(), 1); assert.match(await consent.getAttribute('href'), /^https:\/\/accounts.google.com\/o\/oauth2\/v2\/auth/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await status.filter({ hasText: 'cancelled' }).waitFor();
  await publish(connected()); await sign.click(); await status.filter({ hasText: 'Google Drive connected' }).waitFor();
  assert.equal(await page.getByTestId('drive-account').textContent(), 'fixture@example.invalid');
  await page.getByText(/Backup browsing and tablet restore are not available yet/).waitFor();
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#drive-title').scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/drive-${host}.png`, fullPage: true });
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Remove Google access…', exact: true }).click(); assert.equal(await status.textContent(), 'Google Drive connected');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Remove Google access…', exact: true }).click(); await status.filter({ hasText: 'removal could not be confirmed' }).waitFor();
  await page.getByRole('button', { name: 'Disconnect this Manager', exact: true }).click(); await status.filter({ hasText: 'Not signed in' }).waitFor();
  await publish({ ...connected(), access_token: 'SYNTHETIC_PRIVATE_SENTINEL' }); await sign.click(); await status.filter({ hasText: 'connection unavailable' }).waitFor();
  assert.equal(await page.getByText('SYNTHETIC_PRIVATE_SENTINEL').count(), 0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined'); assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  console.log(`${host}: actual sandbox/shared UI with explicit synthetic auth-state responses; no live Google proof`);
}
let value = state('disconnected');
const fixtureAuth = { status: async () => value, begin: async () => { const start = ['disconnected', 'cancelled'].includes(value.status); if (start) value = state('connecting'); return { state: value, authorizationUrl: start ? 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' : null }; },
  cancel: async () => value = state('cancelled'), check: async () => value, disconnect: async () => value = state('disconnected'),
  revoke: async id => { assert.equal(id, '1'.repeat(64)); return value = { ...connected(), status: 'revocation-unconfirmed', authorizationId: null, error: 'revocation-unconfirmed' }; }, dispose: () => {} };
const helper = await startHelper({ root: path.resolve('dist/manager/browser'), driveAuth: fixtureAuth });
const browser = await chromium.launch();
try { const context = await browser.newContext(); await isolate(context, helper.origin); const page = await context.newPage(); await page.goto(helper.origin + '/preview/'); await verify(page, async v => { value = v; }, 'browser'); }
finally { await browser.close(); await helper.close(); }
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`) : undefined;
const app = await electron.launch({ executablePath, args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env: { ...process.env,
  MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: root, MANAGER_DRIVE_AUTH_ROOT: path.join(root, 'missing'), MANAGER_DRIVE_PYTHON: process.env.MANAGER_DRIVE_PYTHON ?? (process.platform === 'linux' ? '/usr/bin/python3' : process.env.MANAGER_WIRED_PYTHON) } });
try {
  // CI needs a visible native surface for Electron screenshot capture.
  // MANAGER_TEST otherwise creates a hidden window for IPC-only tests.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await isolate(app.context());
  await app.evaluate(async ({ app, BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`); });
  await page.getByTestId('drive-status').filter({ hasText: 'Google Drive setup required' }).waitFor();
  assert.equal(await page.evaluate(() => window.managerHost.driveAuth.revoke('wrong').then(() => 'accepted', () => 'refused')), 'refused');
  // Actual packaged module/custody missing-config refusal above; response substitution below
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
  await page.reload(); await verify(page, value => app.evaluate((_electron, value) => { globalThis.driveFixture = value; }, value), packaged ? 'desktop-packaged-IPC' : 'desktop-IPC');
} finally { await app.close(); await rm(root, { recursive: true, force: true }); }
