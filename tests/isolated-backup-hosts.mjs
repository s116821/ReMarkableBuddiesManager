import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {chromium, _electron as electron, expect} from '@playwright/test';
import {startHelper} from '../host/browser-helper.mjs';

// Source-derived synthetic provider frames. The real host, transport and UI
// consume them, but they are not live Drive or producer-emitted evidence.
const backup = 'db766c9e-d346-41fd-aad4-17d754fd50c7';
const device = '3696d8c3-8889-4b67-917d-ea52b54cefe1';
const marker = JSON.stringify({
  isolated_backup_version: 1, data_backup: {bytes: 11, sha256: '1'.repeat(64)},
  portable_configuration: {bytes: 12, sha256: '2'.repeat(64)},
});
const digest = createHash('sha256').update(marker).digest('hex');
const fixture = {backup, device, marker, digest};
const packaged = process.argv.includes('--packaged');

function makeDriveFixture({backup, device, marker, digest}) {
  const json = value => Buffer.from(JSON.stringify(value));
  const file = (id, size, properties) => ({
    id, size: String(size), spaces: ['appDataFolder'], mimeType: 'application/octet-stream', trashed: false,
    appProperties: {backup, buddy_isolated: '1', root: 'PrivateRoot', ...properties},
  });
  const root = file('PrivateRoot', 0, {kind: 'root', device, grant: 'c'.repeat(64)});
  const revision = file('PrivateRevision', Buffer.byteLength(marker), {kind: 'marker', predecessor: root.id, sha256: digest});
  const state = {
    contract_version: 1, status: 'connected', account: {label: 'fixture@example.invalid'},
    checkedAt: new Date(1760000000000).toISOString(), error: null, authorizationId: 'f'.repeat(64), backupReady: false,
  };
  let authority = new AbortController();
  const control = {qualified: false, hold: false, readCount: 0, abortedReads: 0};
  const changeAuthority = () => {
    authority.abort();
    authority = new AbortController();
  };
  return {
    control,
    status: () => state,
    check: () => { changeAuthority(); return state; },
    openBackupRead(signal) {
      if (!control.qualified) return {status: 'unqualified'};
      const captured = AbortSignal.any([signal, authority.signal]);
      return {status: 'qualified', signal: captured, binding: {
        isCurrent: () => !captured.aborted,
        list(query) {
          if (control.hold) {
            control.readCount++;
            return new Promise(resolve => {
              query.signal.addEventListener('abort', () => {
                control.abortedReads++;
                resolve(json({files: [], incompleteSearch: true}));
              }, {once: true});
            });
          }
          return json({files: query.kind === 'root' ? [root] : [revision], incompleteSearch: false});
        },
        readMetadata: query => json(query.kind === 'root' ? root : revision),
        readMarker: () => Buffer.from(marker),
      }};
    },
    dispose: changeAuthority,
  };
}

async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:' || url.origin === origin) return route.continue();
    if (url.hostname === 'api.github.com') return route.fulfill({status: 404, headers: {'Access-Control-Allow-Origin': '*'}, body: '{}'});
    return route.abort();
  });
}

async function verify(page, control) {
  const status = page.getByTestId('cloud-backup-status');
  const list = page.getByTestId('cloud-backup-list');
  const selection = page.getByTestId('cloud-backup-selection');
  const scan = page.getByRole('button', {name: 'Scan for cloud backups', exact: true});
  await expect(page.getByTestId('drive-status')).toContainText('Google Drive connected');
  await expect(page.getByTestId('tablet-model')).toHaveCount(0);
  await scan.click();
  await expect(status).toContainText('hasn’t verified access');
  await expect(list).toHaveCount(0);

  await control.set('qualified', true);
  await control.set('hold', true);
  await scan.click();
  await expect.poll(() => control.get('readCount')).toBe(1);
  await page.getByRole('button', {name: 'Cancel backup check', exact: true}).click();
  await expect.poll(() => control.get('abortedReads')).toBe(1);
  await expect(list).toHaveCount(0);

  await control.set('hold', false);
  await scan.click();
  await expect(status).toContainText('Choose a backup revision');
  await expect(list).toContainText('Newest in this scan');
  await page.getByRole('button', {name: 'Select revision', exact: true}).click();
  await expect(selection).toContainText(digest);
  await expect(selection).toContainText('Package and media verification require a download');
  assert.doesNotMatch(await list.textContent(), /PrivateRoot|PrivateRevision|authorizationId|appProperties/);

  await page.getByRole('button', {name: 'Check connection', exact: true}).click();
  await expect(selection).toHaveCount(0);
  await expect(list).toHaveCount(0);
  await expect(scan).toBeEnabled();

  await scan.click();
  await expect(list).toBeVisible();
  await page.evaluate(() => globalThis.dispatchEvent(new Event('pagehide')));
  await expect(list).toHaveCount(0);
  await expect(selection).toHaveCount(0);
}

async function verifyElectronReload(page, control) {
  const request = value => page.evaluate(value => globalThis.managerHost.isolatedBackup(value), value);
  const status = operation => request({version: 1, action: 'status', operation});
  const reload = async () => {
    await page.reload();
    await expect(page.getByTestId('drive-status')).toContainText('Google Drive connected');
  };
  const priorReads = await control.get('readCount'), priorAborts = await control.get('abortedReads');
  await control.set('hold', true);
  const pending = await request({version: 1, action: 'scan'});
  await expect.poll(() => control.get('readCount')).toBe(priorReads + 1);
  await reload();
  await expect.poll(() => control.get('abortedReads')).toBe(priorAborts + 1);
  assert.equal((await status(pending.operation)).status, 'invalidated');

  await control.set('hold', false);
  const scan = await request({version: 1, action: 'scan'});
  await expect.poll(async () => (await status(scan.operation)).status).toBe('observed');
  const observed = await status(scan.operation);
  const selection = await request({version: 1, action: 'select', inspection: scan.operation,
    choice: observed.backups[0].revisions[0].reference});
  await expect.poll(async () => (await status(selection.operation)).status).toBe('selected');
  await reload();
  assert.equal((await status(selection.operation)).status, 'invalidated');
}

async function installSyntheticDrive(app) {
  await app.evaluate(({app}, {source, fixture}) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path');
    const root = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'host');
    const {DriveAuth} = require(path.join(root, 'drive-auth.mjs'));
    // Fixture code runs only in the Playwright-controlled main process.
    const drive = Function('fixture', 'return (' + source + ')(fixture);')(fixture);
    for (const method of ['status', 'check', 'openBackupRead', 'dispose']) DriveAuth.prototype[method] = drive[method];
    globalThis.isolatedBackupUiFixture = drive.control;
  }, {source: makeDriveFixture.toString(), fixture});
  return {
    get: key => app.evaluate((_electron, key) => globalThis.isolatedBackupUiFixture[key], key),
    set: (key, value) => app.evaluate((_electron, {key, value}) => { globalThis.isolatedBackupUiFixture[key] = value; }, {key, value}),
  };
}

function helperStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {method: 'POST', headers, timeout: 3000}, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(Error('Helper probe timed out')));
    request.end(JSON.stringify({version: 1, action: 'scan'}));
  });
}

async function verifyPackagedBrowser(executablePath, env) {
  const app = await electron.launch({
    executablePath, args: ['--browser-helper', ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env,
  });
  let origin;
  try {
    await expect.poll(() => app.evaluate(() => globalThis.managerBrowserHelperOrigin ?? '')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    origin = await app.evaluate(() => globalThis.managerBrowserHelperOrigin);
    assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length), 0);
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({viewport: {width: 390, height: 980}});
      await isolate(context, origin);
      const page = await context.newPage();
      const response = await page.goto(origin + '/preview/');
      assert.equal(response.status(), 200);
      // Angular rendered from the packaged ASAR, with no protected host configuration.
      await expect(page.getByTestId('drive-status')).toContainText('Google Drive');
      await expect(page.getByTestId('tablet-model')).toHaveCount(0);
      assert.equal(await page.evaluate(() => typeof globalThis.managerHost), 'undefined');
      const cookie = (await context.cookies(origin)).find(item => item.name === 'manager_session');
      assert.ok(cookie?.httpOnly && cookie.sameSite === 'Strict');
      const endpoint = origin + '/manager-isolated-backup';
      const headers = {Origin: origin, Cookie: 'manager_session=' + cookie.value, 'Content-Type': 'application/json'};
      assert.equal(await helperStatus(endpoint, {...headers, Host: 'invalid.example'}), 403);
      assert.equal(await helperStatus(endpoint, {...headers, Origin: 'http://127.0.0.1:1'}), 403);
      assert.equal(await helperStatus(endpoint, {...headers, Cookie: 'manager_session=invalid'}), 403);
      const pending = await page.evaluate(async () => {
        const response = await fetch('/manager-isolated-backup', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: 1, action: 'scan'})});
        return response.json();
      });
      assert.equal(pending.status, 'scanning');
      await expect.poll(() => page.evaluate(async operation => {
        const response = await fetch('/manager-isolated-backup', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: 1, action: 'status', operation})});
        return (await response.json()).status;
      }, pending.operation)).toBe('unqualified');
      const control = await installSyntheticDrive(app);
      await page.reload();
      await verify(page, control);
      assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length), 0);
      await control.set('hold', true);
      await page.getByRole('button', {name: 'Scan for cloud backups', exact: true}).click();
      await expect.poll(() => control.get('readCount')).toBe(2);
    } finally { await browser.close(); }
  } finally { await app.close(); }
  await assert.rejects(helperStatus(origin + '/manager-isolated-backup', {}), {code: 'ECONNREFUSED'});
  console.log('Packaged browser helper served the ASAR UI over loopback and stopped on quit');
}

async function verifySourceBrowser() {
  const drive = makeDriveFixture(fixture);
  let tabletObservations = 0;
  const observer = {
    generation: 0,
    cancel() {},
    observe() {
      tabletObservations++;
      throw Error('Unexpected tablet observation in cloud backup fixture');
    },
  };
  const helper = await startHelper({root: path.resolve('dist/manager/browser'), driveAuth: drive, observer});
  try {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({viewport: {width: 390, height: 980}});
      await isolate(context, helper.origin);
      const page = await context.newPage();
      await page.goto(helper.origin + '/preview/');
      await verify(page, {get: key => drive.control[key], set: (key, value) => { drive.control[key] = value; }});
    } finally { await browser.close(); }
  } finally { await helper.close(); }
  assert.equal(tabletObservations, 0);
  console.log('Browser disconnected backup scan, cancel, selection and lifecycle passed with synthetic provider frames');
}

if (!packaged) await verifySourceBrowser();

const profileParent = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(profileParent, 'manager-isolated-backup-ui-'));
const originalProfile = await lstat(profile, {bigint: true});
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MANAGER_')));
Object.assign(env, {MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: profile,
  MANAGER_DRIVE_AUTH_ROOT: path.join(profile, 'unused')});
const executablePath = packaged ? path.resolve('out/packages', 'ReMarkableBuddiesManager-' + process.platform + '-x64',
  process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager') : undefined;
try {
  if (packaged) await verifyPackagedBrowser(executablePath, env);
  const app = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await isolate(app.context());
    const control = await installSyntheticDrive(app);
    await app.evaluate(async ({app, BrowserWindow}) => {
      const main = BrowserWindow.getAllWindows()[0];
      await main.loadFile(app.getAppPath() + '/dist/manager/browser/index.html');
      main.show();
    });
    await verify(page, control);
    await verifyElectronReload(page, control);
  } finally { await app.close(); }
} finally {
  const canonicalProfile = await realpath(profile);
  const currentProfile = await lstat(profile, {bigint: true});
  assert.ok(path.isAbsolute(canonicalProfile) && canonicalProfile === profile &&
    path.dirname(canonicalProfile) === profileParent && currentProfile.isDirectory() &&
    !currentProfile.isSymbolicLink() && currentProfile.dev === originalProfile.dev &&
    currentProfile.ino === originalProfile.ino, 'Temporary Electron profile changed before teardown');
  await rm(canonicalProfile, {recursive: true});
}
console.log('Electron disconnected backup scan, cancel, selection and lifecycle passed with synthetic provider frames');
