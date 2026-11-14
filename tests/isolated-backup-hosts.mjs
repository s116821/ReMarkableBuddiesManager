import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
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

const profileParent = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(profileParent, 'manager-isolated-backup-ui-'));
const originalProfile = await lstat(profile, {bigint: true});
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MANAGER_')));
Object.assign(env, {MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: profile,
  MANAGER_DRIVE_AUTH_ROOT: path.join(profile, 'unused')});
try {
  const app = await electron.launch({
    executablePath: packaged ? path.resolve('out/packages', 'ReMarkableBuddiesManager-' + process.platform + '-x64',
      process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager') : undefined,
    args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await isolate(app.context());
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
    await app.evaluate(async ({app, BrowserWindow}) => {
      const main = BrowserWindow.getAllWindows()[0];
      await main.loadFile(app.getAppPath() + '/dist/manager/browser/index.html');
      main.show();
    });
    await verify(page, {
      get: key => app.evaluate((_electron, key) => globalThis.isolatedBackupUiFixture[key], key),
      set: (key, value) => app.evaluate((_electron, {key, value}) => { globalThis.isolatedBackupUiFixture[key] = value; }, {key, value}),
    });
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
