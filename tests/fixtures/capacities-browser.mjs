/* global window, document, innerWidth */
import {chromium, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {startHelper} from '../../host/browser-helper.mjs';
import {productFixture} from './product-settings.mjs';
import {readTabletFor, showPanel} from './navigation.mjs';

// Actual built renderer/helper/popup boundary. Provider consent and tablet data
// are explicit fixtures; this never calls the provider or a physical device.
export async function verifyCapacitiesBrowser(root) {
  const product = productFixture();
  let value = {contract_version: 1, status: 'disconnected'};
  const helper = await startHelper({root, observer: product.observer,
    capacitiesFactory: ({openAuthorization}) => ({
      status: () => value,
      begin: async () => {
        value = {contract_version: 1, status: 'starting'};
        await openAuthorization('https://api.capacities.io/oauth/authorize?state=CI_PRIVATE_STATE&code_challenge=CI_PRIVATE_CHALLENGE');
        return (value = {contract_version: 1, status: 'awaiting-consent'});
      },
      cancel: () => (value = {contract_version: 1, status: 'canceled'}),
      reconcile: () => value,
      dispose() {},
    }),
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const unexpected = [], errors = [], navigation = [], responses = [];
    const consentUrl = 'https://api.capacities.io/oauth/authorize?state=CI_PRIVATE_STATE&code_challenge=CI_PRIVATE_CHALLENGE';
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === helper.origin) {
        if (url.pathname === '/manager-capacities-open') {
          navigation.push(await request.allHeaders());
          // Playwright routes the first request in a redirect chain only. Read
          // the real helper's 303 without following it, verify its private
          // Location, then substitute the consent page at this local boundary.
          const response = await route.fetch({maxRedirects: 0});
          try {
            assert.equal(response.status(), 303);
            assert.equal(response.headers().location, consentUrl);
          } finally { await response.dispose(); }
          return route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>Fixture consent</title><p>Fixture consent</p>'});
        }
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
    const popupReady = context.waitForEvent('page');
    await page.getByTestId('capacities-connect').click();
    const popup = await popupReady;
    await popup.waitForURL(helper.origin + '/manager-capacities-open?launch=*');
    await expect(popup).toHaveTitle('Fixture consent');
    assert.equal(await popup.evaluate(() => window.opener), null);
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
    console.log('Verified actual Capacities browser popup, Fetch Metadata, helper 303 and cancel; substituted consent page without following provider redirect');
  } finally { await browser.close(); await helper.close(); }
}
