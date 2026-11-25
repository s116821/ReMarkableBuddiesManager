import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium, _electron as electron, expect} from '@playwright/test';
import {startHelper} from '../host/browser-helper.mjs';
import {firstConfigurationFixture, personalizationAfterFirstSave, tablet} from './fixtures/first-configuration.mjs';
import {disconnectFor, readTabletFor, showPanel} from './fixtures/navigation.mjs';

const packaged = process.argv.includes('--packaged');
const docRoot = path.resolve('dist/manager/browser');
const observed = {...tablet, service: {LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead'}};
const driveStatus = {contract_version: 1, status: 'unconfigured', account: null, checkedAt: null,
  error: null, authorizationId: null, backupReady: false};

async function isolate(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file:') || origin && new URL(url).origin === origin) return route.continue();
    return route.fulfill({status: 404, headers: {'Access-Control-Allow-Origin': '*'}, body: '{}'});
  });
}

async function exercise(page, calls) {
  await readTabletFor(page, 'setup');
  const check = page.getByRole('button', {name: 'Check current configuration', exact: true});
  const review = page.getByRole('button', {name: 'Review first configuration', exact: true});
  const save = page.getByRole('button', {name: 'Save default configuration', exact: true});
  await check.click();
  await expect(page.getByTestId('first-configuration-current')).toHaveText('No saved configuration is present.');
  assert.deepEqual(await calls(), ['check-existing-default']);
  await expect(save).toHaveCount(0);
  await review.click();
  await expect(save).toBeEnabled();
  assert.deepEqual(await calls(), ['check-existing-default', 'check-existing-default']);
  await save.click();
  await expect(page.getByTestId('first-configuration-status')).toHaveText('Default configuration created and verified.');
  assert.deepEqual(await calls(), ['check-existing-default', 'check-existing-default', 'create-existing-default']);
  await expect(save).toHaveCount(0);
  await page.getByRole('button', {name: 'Open personalization', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Personalization', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Read personalization', exact: true}).click();
  const field = page.getByLabel('Response preference', {exact: true});
  await expect(field).toHaveValue('');
  await field.fill('Use short sentences.\nKeep examples 🦊');
  await page.getByLabel('Enable this preference').check();
  await page.getByRole('button', {name: 'Save preference', exact: true}).click();
  await expect(page.getByTestId('personalization-status')).toContainText('restart required');
  await page.getByRole('button', {name: 'Read personalization', exact: true}).click();
  await expect(field).toHaveValue('Use short sentences.\nKeep examples 🦊');
}

async function exerciseUncertainSaves(page, configure, transport) {
  const review = page.getByRole('button', {name: 'Review first configuration', exact: true});
  const check = page.getByRole('button', {name: 'Check current configuration', exact: true});
  const save = page.getByRole('button', {name: 'Save default configuration', exact: true});
  const stop = page.getByRole('button', {name: 'Stop configuration wait', exact: true});
  const storage = page.getByRole('button', {name: 'Review storage setup', exact: true});
  const current = page.getByTestId('first-configuration-current');
  const original = page.getByTestId('first-configuration-original');
  for (const mode of ['lost', 'stopped']) {
    // Each simulated tablet has its own retained operation history.
    await disconnectFor(page, 'tablet');
    await configure({
      connectionId: (mode === 'lost' ? '1' : '2').repeat(64), exists: false,
      lost: false, holdCreateUntilStop: mode === 'stopped',
    });
    await readTabletFor(page, 'setup');
    const before = (await transport()).calls.length;
    if (mode === 'stopped') {
      await showPanel(page, 'product');
      await expect(page.getByTestId('capacities-inspect')).toBeEnabled();
      await showPanel(page, 'tablet');
    }
    await review.click();
    await expect(current).toHaveText('No saved configuration is present.');
    await expect(storage).toBeDisabled();
    await expect(save).toBeEnabled();
    if (mode === 'lost') await configure({lost: true});
    await save.click();
    if (mode === 'stopped') {
      await expect.poll(async () => (await transport()).exists).toBe(true);
      await expect(current).toHaveCount(0);
      await expect(storage).toBeDisabled();
      await showPanel(page, 'product');
      await expect(page.getByTestId('capacities-inspect')).toBeDisabled();
      await expect(page.getByRole('button', {name: 'Edit Reader & Writer'})).toBeDisabled();
      await showPanel(page, 'tablet');
      await stop.click();
    }
    await expect(page.getByTestId('first-configuration-status')).toContainText('Configuration creation was not confirmed.');
    await expect(current).toHaveCount(0);
    await expect(original).toBeVisible();
    await expect(review).toBeDisabled();
    await expect(storage).toBeDisabled();
    await expect(save).toHaveCount(0);
    assert.deepEqual((await transport()).calls.slice(before), ['check-existing-default', 'create-existing-default']);

    await configure({lost: false});
    await check.click();
    await expect(current).toHaveText('A valid saved configuration is present.');
    await expect(original).toBeVisible();
    await expect(review).toBeDisabled();
    await expect(storage).toBeEnabled();
    assert.deepEqual((await transport()).calls.slice(before), [
      'check-existing-default', 'create-existing-default', 'check-existing-default',
    ]);
  }
}

const wire = firstConfigurationFixture({
  lastObservation: null,
  async observe() {
    this.lastObservation = {...observed, connection_id: wire.state.connectionId ?? observed.connection_id};
    return {contract_version: 1, status: 'observed', observation: this.lastObservation};
  },
  cancel() { return {contract_version: 1, status: 'cancelled', observation: null}; },
});
wire.state.existing = true;
wire.observer.personalization = request => personalizationAfterFirstSave(wire.state, observed, request);
const helper = await startHelper({
  root: docRoot, observer: wire.observer,
  driveAuth: {status: async () => driveStatus, dispose() {}},
  downloads: {async request() { throw Error('Fixture has no downloads'); }, dispose() {}},
});
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await isolate(context, helper.origin);
  const page = await context.newPage();
  await page.goto(helper.origin + '/preview/');
  const endpoint = helper.origin + '/manager-first-configuration';
  for (const [origin, payload, expected] of [
    ['https://invalid.example', {action: 'retained'}, 403],
    [helper.origin, {action: 'retained', path: '/foreign'}, 400],
  ]) {
    const response = await context.request.post(endpoint, {
      headers: {Origin: origin, 'Content-Type': 'application/json'}, data: payload,
    });
    assert.equal(response.status(), expected);
  }
  await exercise(page, () => wire.state.calls.map(({request}) => request.selector));
  await exerciseUncertainSaves(page, patch => Object.assign(wire.state, patch),
    () => ({exists: wire.state.exists, calls: wire.state.calls.map(({request}) => request.selector)}));
  console.log('Browser setup passed through the actual helper with a synthetic Buddy transport.');
} finally {
  await browser.close();
  await helper.close();
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'manager-first-configuration-ui-'));
const env = {...process.env};
for (const name of Object.keys(env)) if (name.startsWith('MANAGER_')) delete env[name];
Object.assign(env, {MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: profile});
let app;
try {
  const executable = process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager';
  app = await electron.launch({
    executablePath: packaged ? path.resolve('out/packages', `ReMarkableBuddiesManager-${process.platform}-x64`, executable) : undefined,
    args: [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])], env,
  });
  const page = await app.firstWindow();
  await isolate(app.context());
  await app.evaluate(async ({app, BrowserWindow}, fixture) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path');
    const root = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(app.getAppPath(), 'host');
    const {WiredObserver} = require(path.join(root, 'observer.mjs'));
    const {DriveAuth} = require(path.join(root, 'drive-auth.mjs'));
    const {firstConfigurationFixture, personalizationAfterFirstSave} = require(path.join(fixture.root, 'tests/fixtures/first-configuration.mjs'));
    const wire = firstConfigurationFixture();
    wire.state.existing = true;
    globalThis.firstConfigurationState = wire.state;
    WiredObserver.prototype.observe = async function () {
      this.lastObservation = {...fixture.observed,
        connection_id: wire.state.connectionId ?? fixture.observed.connection_id};
      return {contract_version: 1, status: 'observed', observation: this.lastObservation};
    };
    WiredObserver.prototype.runFirstConfiguration = wire.observer.runFirstConfiguration;
    WiredObserver.prototype.personalization = function (request) {
      return personalizationAfterFirstSave(wire.state, this.lastObservation, request);
    };
    DriveAuth.prototype.status = async () => fixture.driveStatus;
    await BrowserWindow.getAllWindows()[0].loadFile(path.join(app.getAppPath(), 'dist/manager/browser/index.html'));
  }, {root: path.resolve('.'), observed, driveStatus});
  const refused = await page.evaluate(async () => {
    const host = globalThis.managerHost;
    const badCalls = [() => host.firstConfiguration({action: 'retained', path: '/foreign'}),
      () => host.firstConfiguration({action: 'retained'}, {})];
    return Promise.all(badCalls.map(call => call().then(() => false, () => true)));
  });
  assert.deepEqual(refused, [true, true]);
  const transport = () => app.evaluate(() => {
    const state = globalThis.firstConfigurationState;
    return {exists: state.exists, calls: state.calls.map(({request}) => request.selector)};
  });
  await exercise(page, async () => (await transport()).calls);
  await exerciseUncertainSaves(page,
    patch => app.evaluate((_electron, values) => { Object.assign(globalThis.firstConfigurationState, values); }, patch),
    transport);
  if (packaged) {
    const resources = await app.evaluate(() => process.resourcesPath);
    const python = process.env.MANAGER_WIRED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawnSync(python, ['-B', path.join(resources, 'host', 'first_configuration_transport.py')],
      {input: '{}', timeout: 10000});
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr.toString());
    assert.equal(child.stderr.length, 0);
    assert.equal(child.stdout.includes(13), false);
    const [ready, frame, tail, ...extra] = child.stdout.toString('utf8').split('\n');
    assert.deepEqual([ready, tail, extra], ['READY', '', []]);
    assert.deepEqual(JSON.parse(frame), {
      dispatch: 'not-dispatched', observation: null, report: null, executable_sha256: null,
    });
  }
  console.log('Electron setup passed through actual preload and IPC with a synthetic Buddy transport.');
} finally {
  if (app) await app.close();
  await rm(profile, {recursive: true, force: true});
}
