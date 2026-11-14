import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium, _electron as electron, expect} from '@playwright/test';
import {startHelper} from '../host/browser-helper.mjs';
import {historical, original, setup} from './fixtures/isolated-root.mjs';

const packaged = process.argv.includes('--packaged');
const driveStatus = {contract_version: 1, status: 'unconfigured', account: null, checkedAt: null,
  error: null, authorizationId: null, backupReady: false};

async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:' || url.origin === origin) return route.continue();
    if (url.hostname === 'api.github.com') {
      return route.fulfill({status: 404, headers: {'Access-Control-Allow-Origin': '*'}, body: '{}'});
    }
    return route.abort();
  });
}

async function verify(page, control) {
  const section = page.getByRole('region', {name: 'Prepare isolated backup storage'});
  const status = section.getByTestId('isolated-root-status');
  const review = section.getByRole('button', {name: 'Review saved backup'});
  const prepare = section.getByRole('button', {name: 'Prepare cloud storage'});
  const retry = section.getByRole('button', {name: 'Retry original preparation'});
  const rows = section.getByTestId('isolated-root-retained').locator('li');
  const report = section.getByTestId('isolated-root-report');
  const read = async () => {
    await page.getByRole('button', {name: 'Read tablet state', exact: true}).click();
    await page.getByTestId('tablet-model').waitFor();
  };
  const openReview = async () => {
    await review.click();
    await expect(status).toContainText('Review complete');
    await expect(prepare).toBeEnabled();
  };

  await expect(review).toBeDisabled();
  await read();
  await openReview();
  await expect(section.getByTestId('isolated-root-preview')).toContainText('Separate cloud backup');
  assert.deepEqual(await control.inputs(), []);

  await section.getByRole('button', {name: 'Cancel backup review'}).click();
  await expect(prepare).toHaveCount(0);
  await openReview();
  await page.evaluate(() => globalThis.dispatchEvent(new Event('pagehide')));
  await expect(prepare).toHaveCount(0);
  await openReview();
  await page.evaluate(() => {
    const document = globalThis.document;
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
  });
  await expect(prepare).toHaveCount(0);
  await openReview();
  await read();
  await expect(prepare).toHaveCount(0);
  await openReview();
  await page.getByRole('button', {name: 'Review change', exact: true}).click();
  await expect(prepare).toHaveCount(0);
  await expect(page.getByTestId('local-mode-choice-status')).toContainText('Review complete');
  await page.clock.install();
  await openReview();
  await page.clock.fastForward(120001);
  await expect(prepare).toHaveCount(0);
  assert.deepEqual(await control.inputs(), []);

  await openReview();
  await control.hold();
  await prepare.click();
  await expect(status).toContainText('Preparing cloud storage');
  await expect(page.getByRole('button', {name: 'Review change', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Read saved storage mode', exact: true})).toBeDisabled();
  await control.release();
  await expect(status).toContainText('outcome is unknown');
  await expect(report).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('outcome is unknown');
  const [originalInput] = await control.inputs();
  assert.ok(originalInput);

  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(retry).toBeDisabled();
  await read();
  await expect(retry).toBeEnabled();
  assert.deepEqual(await control.inputs(), [originalInput]);
  await control.historical();
  await retry.click();
  await expect(status).toContainText('earlier backup');
  await expect(report).toContainText('Backup packages, Buddy runtime, and native pages need separate verification');
  await expect(rows.first()).toContainText('Verified cloud storage evidence retained');
  await expect(retry).toHaveCount(0);
  assert.deepEqual(await control.inputs(), [originalInput, originalInput]);

  const markup = await section.textContent();
  for (const value of [originalInput, original.data.current_snapshot.token.sha256,
    original.data.current_snapshot.mode.binding_sha256]) assert.equal(markup.includes(value), false);
}

const fixture = setup({raw: 'lost', report: historical});
fixture.observer.observe = async function () {
  return {contract_version: 1, status: 'observed', observation: structuredClone(this.lastObservation)};
};

const helper = await startHelper({
  root: path.resolve(packaged ? 'dist/manager/browser' : 'test-results/development/browser'),
  observer: fixture.observer, isolatedRootStore: fixture.store,
  driveAuth: {status: async () => driveStatus, dispose() {}},
  downloads: {async request() { throw Error('Synthetic download unavailable'); }, dispose() {}},
});
try {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await isolate(context, helper.origin);
    const page = await context.newPage();
    await page.goto(helper.origin + '/preview/');
    await verify(page, {
      inputs: () => fixture.calls.filter(request => request.selector === 'provision-isolated-backup').map(request => request.input_base64),
      hold: () => { fixture.options.delay = true; },
      async release() {
        await expect.poll(() => typeof fixture.release).toBe('function');
        fixture.options.delay = false;
        fixture.release();
      },
      historical: () => { fixture.options.raw = undefined; },
    });
  } finally {
    await browser.close();
  }
} finally {
  await helper.close();
}
console.log('Browser isolated backup review, page lifetime, unresolved result, reload and exact-byte historical retry passed');

const profile = await mkdtemp(path.join(os.tmpdir(), 'manager-isolated-root-ui-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MANAGER_')));
Object.assign(env, {MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: profile,
  MANAGER_DRIVE_AUTH_ROOT: path.join(profile, 'unused')});
try {
  const desktop = await electron.launch({
    executablePath: packaged ? path.resolve('out/packages',
      `ReMarkableBuddiesManager-${process.platform}-x64`,
      process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager') : undefined,
    args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])],
    env,
  });
  try {
    const page = await desktop.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await isolate(desktop.context());
    await desktop.evaluate(({app}, fixtures) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path'), crypto = require('node:crypto');
      const root = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'host');
      const {WiredObserver} = require(path.join(root, 'observer.mjs'));
      const {DriveAuth} = require(path.join(root, 'drive-auth.mjs'));
      const {DriveStore} = require(path.join(root, 'drive-store.mjs'));
      const sorted = value => value === null || typeof value !== 'object' ? value :
        Array.isArray(value) ? value.map(sorted) :
          Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
      const digest = value => crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
      let journal = null;
      const control = globalThis.isolatedRootTest = {inputs: [], lost: true, hold: false, release: null};
      DriveAuth.prototype.status = async () => fixtures.driveStatus;
      DriveStore.prototype.isolatedRootOperations = () => ({
        value: sorted(journal), digest: journal ? digest(journal) : null,
      });
      DriveStore.prototype.appendIsolatedRootOperation = (record, expected) => {
        if ((journal ? digest(journal) : null) !== expected) throw Error('Synthetic storage changed');
        journal ??= {version: 1, originals: []};
        journal.originals.push(structuredClone(record));
        return {committed: true, digest: digest(journal)};
      };
      WiredObserver.prototype.observe = async function () {
        this.lastObservation = structuredClone(fixtures.tablet);
        return {contract_version: 1, status: 'observed', observation: this.lastObservation};
      };
      WiredObserver.prototype.run = async function (action, request) {
        if (action !== 'local-mode-choice') throw Error('Unexpected synthetic action');
        let raw;
        if (request.selector === 'inspect') {
          raw = JSON.stringify({report_version: 1, operation: 'inspect', status: 'ok', incomplete: false,
            activation_performed: false, data: {current_snapshot: fixtures.original.data.current_snapshot,
              receipt: null, receipt_status: null}}) + '\n';
        } else if (request.selector === 'provision-isolated-backup') {
          control.inputs.push(request.input_base64);
          const report = structuredClone(fixtures.historical);
          report.data.isolated_root.operation = JSON.parse(Buffer.from(request.input_base64, 'base64')).operation;
          if (control.hold) await new Promise(resolve => { control.release = resolve; });
          raw = control.lost ? 'lost' : JSON.stringify(report) + '\n';
        } else {
          throw Error('Unexpected synthetic selector');
        }
        return {contract_version: 1, status: 'observed', observation: structuredClone(this.lastObservation),
          local_mode_raw: {status: 'reported', stdout_base64: Buffer.from(raw).toString('base64')}};
      };
    }, {original, historical, tablet: fixture.observer.lastObservation, driveStatus});
    await desktop.evaluate(async ({app, BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows()[0];
      await window.loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`);
      window.show();
    });
    await verify(page, {
      inputs: () => desktop.evaluate(() => globalThis.isolatedRootTest.inputs),
      hold: () => desktop.evaluate(() => { globalThis.isolatedRootTest.hold = true; }),
      async release() {
        await expect.poll(() => desktop.evaluate(() => typeof globalThis.isolatedRootTest.release)).toBe('function');
        await desktop.evaluate(() => {
          globalThis.isolatedRootTest.hold = false;
          globalThis.isolatedRootTest.release();
        });
      },
      historical: () => desktop.evaluate(() => { globalThis.isolatedRootTest.lost = false; }),
    });
  } finally {
    await desktop.close();
  }
} finally {
  await rm(profile, {recursive: true, force: true});
}
console.log('Electron isolated backup review, page lifetime, unresolved result, reload and exact-byte historical retry passed');
