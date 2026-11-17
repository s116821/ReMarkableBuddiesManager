/* global window, document, innerWidth */
import {chromium, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {startHelper} from '../../host/browser-helper.mjs';
import {productFixture} from './product-settings.mjs';
import {readTabletFor, showPanel} from './navigation.mjs';

// Actual built renderer/helper/popup boundary. Chromium refuses provider DNS
// locally with proxies disabled; tablet and consent-broker state are fixtures.
export async function verifyCapacitiesBrowser(root) {
  const product = productFixture();
  const {promise: browserProtected, resolve: releaseConsent} = Promise.withResolvers();
  let value = {contract_version: 1, status: 'disconnected'};
  const helper = await startHelper({root, observer: product.observer,
    capacitiesFactory: ({openAuthorization}) => ({
      status: () => value,
      begin: async () => {
        value = {contract_version: 1, status: 'starting'};
        await browserProtected;
        await openAuthorization('https://api.capacities.io/oauth/authorize?state=CI_PRIVATE_STATE&code_challenge=CI_PRIVATE_CHALLENGE');
        return (value = {contract_version: 1, status: 'awaiting-consent'});
      },
      cancel: () => (value = {contract_version: 1, status: 'canceled'}),
      reconcile: () => value,
      dispose() {},
    }),
  });
  let browser;
  try {
    browser = await chromium.launch({args: [
      '--no-proxy-server', '--no-system-proxy-config-service',
      '--host-resolver-rules=MAP api.capacities.io ^NOTFOUND',
    ]});
    const context = await browser.newContext();
    const unexpected = [], errors = [], navigation = [], responses = [];
    const consentUrl = 'https://api.capacities.io/oauth/authorize?state=CI_PRIVATE_STATE&code_challenge=CI_PRIVATE_CHALLENGE';
    // Read actual received headers; Chromium adds Fetch Metadata after the
    // Playwright request interception point.
    helper.server.on('request', request => {
      if (request.url?.startsWith('/manager-capacities-open?')) navigation.push(request.headers);
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === helper.origin) {
        return route.continue();
      }
      if (url.origin === 'https://api.github.com') return route.fulfill({status: 404, headers: {'Access-Control-Allow-Origin': '*'}, body: '{}'});
      unexpected.push(request.url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('response', response => {
      if (response.url() === helper.origin + '/manager-capacities') responses.push(response);
    });
    await page.goto(helper.origin + '/preview/');
    await showPanel(page, 'product');
    await expect(page.getByTestId('capacities-auth-status')).toContainText('ready to connect');
    await expect(page.getByTestId('capacities-connect')).toBeDisabled();
    await readTabletFor(page, 'product');
    await expect(page.getByTestId('capacities-connect')).toBeEnabled();
    const [popup] = await Promise.all([
      context.waitForEvent('page', {timeout: 5000}),
      page.getByTestId('capacities-connect').click(),
    ]);
    assert.equal(await popup.evaluate(() => window.opener), null);
    // A redirect chain bypasses later Playwright routes. The launch-time
    // resolver rule contains it; arm observation before releasing Begin.
    const redirectReady = popup.waitForResponse(response =>
      response.url().startsWith(helper.origin + '/manager-capacities-open?'), {timeout: 5000});
    const blockedReady = popup.waitForEvent('requestfailed', {
      predicate: request => request.url() === consentUrl, timeout: 5000,
    });
    releaseConsent();
    const [redirect, blocked] = await Promise.all([redirectReady, blockedReady]);
    assert.equal(redirect.status(), 303);
    assert.equal(redirect.headers().location, consentUrl);
    assert.equal(blocked.failure()?.errorText, 'net::ERR_NAME_NOT_RESOLVED');
    await expect(page.getByTestId('capacities-auth-status')).toContainText('Finish sign-in');
    assert.equal(navigation.length, 1);
    assert.equal(navigation[0]['sec-fetch-site'], 'same-origin');
    assert.equal(navigation[0]['sec-fetch-mode'], 'navigate');
    assert.equal(navigation[0]['sec-fetch-dest'], 'document');
    for (const response of responses) {
      const body = await response.text();
      assert.equal(body.includes('CI_PRIVATE_'), false);
      assert.equal(body.includes('api.capacities.io'), false);
    }
    assert.equal((await page.textContent('body')).includes('CI_PRIVATE_'), false);
    await page.getByTestId('capacities-cancel').click();
    await expect(page.getByTestId('capacities-auth-status')).toContainText('canceled');
    await popup.close();
    for (const width of [390, 1280]) {
      await page.setViewportSize({width, height: 950});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log('Verified actual Capacities popup, received Fetch Metadata, helper 303 and cancel; provider navigation blocked before dispatch');
  } finally {
    try { await browser?.close(); } finally { await helper.close(); }
  }
}
