import { chromium, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const development = process.argv.includes('--development');
const root = path.resolve(development ? 'test-results/development/browser' : 'dist/manager/browser');
const info = JSON.parse(await readFile('electron/build-info.json', 'utf8'));
await mkdir('test-results', { recursive: true });

const releaseUrl = 'https://api.github.com/repos/s116821/ReMarkableBuddies/releases/latest';

async function installFixture(context, localOrigin) {
  const fixture = { tag: 'v0.3.0', fail: false, pending: undefined, requests: 0, unexpected: [], errors: [] };
  const observeErrors = page => page.on('pageerror', error => fixture.errors.push(error.message));
  context.on('page', observeErrors);
  for (const page of context.pages()) observeErrors(page);
  // Deny external traffic, including unexpected endpoints, before any UI loads.
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url === releaseUrl) {
      fixture.requests++;
      if (fixture.pending) await fixture.pending;
      return route.fulfill({ status: fixture.fail ? 503 : 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Accept,X-GitHub-Api-Version' }, json: {
        tag_name: fixture.tag, draft: false, prerelease: false,
        html_url: `https://github.com/s116821/ReMarkableBuddies/releases/tag/${fixture.tag}`,
        published_at: '2026-10-08T12:00:00Z', assets: [],
      } });
    }
    if (url.startsWith('file:') || (localOrigin && new URL(url).origin === localOrigin)) return route.continue();
    fixture.unexpected.push(url);
    return route.abort();
  });
  return fixture;
}

async function verify(page, host, fixture) {
  let releasePending;
  await page.getByRole('heading', { name: 'A home for your Buddies.' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Not configured', exact: true }).count(), 1);
  assert.equal(await page.getByText(`${host} edition`, { exact: true }).count(), 1);
  assert.equal(await page.getByTestId('version').textContent(), info.version);
  assert.equal(await page.getByText('Coming in a later release', { exact: true }).count(), 3);
  await page.getByTestId('official-version').filter({ hasText: fixture.tag }).waitFor();
  assert.equal(await page.getByTestId('installed-version').textContent(), 'Unknown — tablet not connected');
  assert.equal(await page.getByTestId('eligible-version').textContent(), 'Qualified available version: unavailable');
  assert.equal(await page.getByRole('button', { name: 'Install unavailable', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#release-source option[value=community]').isDisabled(), true);
  assert.equal(fixture.requests, 1, 'The initial UI load must use the release fixture before any refresh or reload');
  fixture.tag = 'v0.4.0'; await page.getByRole('button', { name: 'Refresh releases' }).click();
  await page.getByTestId('official-version').filter({ hasText: fixture.tag }).waitFor();
  await page.evaluate(() => localStorage.setItem('remarkable-buddies-manager.release-source', 'community'));
  await page.reload();
  assert.equal(await page.locator('#release-source').inputValue(), 'community');
  await page.locator('#release-source').selectOption('official'); await page.reload();
  assert.equal(await page.locator('#release-source').inputValue(), 'official');
  await page.getByTestId('official-version').filter({ hasText: fixture.tag }).waitFor();
  // Generated Tailwind utilities, not merely class strings, style both hosts.
  assert.equal(await page.getByRole('button', { name: 'Refresh releases' }).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(34, 77, 64)');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  await verifyStyles(page, host);
  if (host === 'Browser') await page.screenshot({ path: `test-results/browser${development ? '-development' : ''}.png`, fullPage: true });
  fixture.pending = new Promise(resolve => { releasePending = resolve; });
  const refresh = page.getByRole('button', { name: 'Refresh releases' });
  await refresh.click();
  await page.getByText('Checking official releases…', { exact: true }).waitFor();
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await refresh.evaluate(el => getComputedStyle(el).cursor), 'wait');
  assert.equal(await refresh.evaluate(el => getComputedStyle(el).opacity), '0.6');
  fixture.fail = true; releasePending(); fixture.pending = undefined;
  const error = page.getByText('Official release metadata could not be verified. Try again.', { exact: true });
  await error.waitFor();
  assert.equal(await error.evaluate(el => getComputedStyle(el).color), 'rgb(153, 27, 27)');
  assert.equal(await error.evaluate(el => getComputedStyle(el).borderLeftWidth), '4px');
  await page.getByText('Displayed candidate is from a previous successful check.', { exact: true }).waitFor();
  if (host === 'Browser') await page.screenshot({ path: `test-results/browser-error${development ? '-development' : ''}.png`, fullPage: true });
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.unexpected, [], 'Unexpected external requests must never reach the network');
}

async function verifyFocus(locator) {
  const focus = await locator.evaluate(el => {
    const style = getComputedStyle(el);
    return { active: document.activeElement === el, visible: el.matches(':focus-visible'),
      width: parseFloat(style.outlineWidth), style: style.outlineStyle,
      color: style.outlineColor, dpr: devicePixelRatio };
  });
  assert.equal(focus.active, true);
  assert.equal(focus.visible, true);
  assert.equal(focus.style, 'solid');
  assert.equal(focus.color, 'rgb(180, 83, 9)');
  // Chromium quantizes outlines to physical pixels (3px becomes 2.4px at DPR 1.25).
  // Retain the intended thickness, allowing strictly less than one physical pixel.
  assert.ok(focus.width > 0 && Math.abs(focus.width - 3) * focus.dpr < 1,
    `Expected visible 3 CSS px focus within physical-pixel quantization: ${JSON.stringify(focus)}`);
}

async function verifyStyles(page, host) {
  // Check actual generated CSS, including semantic components and responsive utilities.
  const refresh = page.getByRole('button', { name: 'Refresh releases' });
  const disabled = page.getByRole('button', { name: 'Install unavailable' });
  assert.equal(await refresh.evaluate(el => getComputedStyle(el).borderRadius), '6px');
  assert.equal(await disabled.evaluate(el => getComputedStyle(el).cursor), 'not-allowed');
  assert.equal(await page.locator('#release-source').evaluate(el => getComputedStyle(el).borderColor), 'rgb(120, 113, 108)');
  assert.equal(await page.locator('.ui-panel').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  // WCAG contrast calculation on computed colors, rather than trusting token names.
  const contrast = await page.evaluate(() => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
        c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const ratio = (a, b) => (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
    const body = getComputedStyle(document.body);
    const button = getComputedStyle(document.querySelector('.ui-button-primary'));
    const muted = getComputedStyle(document.querySelector('.ui-eyebrow'));
    return [ratio(luminance(body.color), luminance(body.backgroundColor)),
      ratio(luminance(button.color), luminance(button.backgroundColor)),
      ratio(luminance(muted.color), luminance(body.backgroundColor))];
  });
  assert.ok(contrast.every(value => value >= 4.5), `Insufficient text contrast: ${contrast}`);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const grid = await page.getByRole('heading', { name: 'Install & update', exact: true })
      .evaluate(el => getComputedStyle(el.closest('section').parentElement).gridTemplateColumns.split(' ').length);
    assert.equal(grid, width < 768 ? 1 : 3);
  }
  // Reset at the brand, then use actual keyboard traversal to the skip link
  // and controls; prior release-preview clicks must not determine test order.
  await page.locator('header a').focus();
  await page.keyboard.press('Shift+Tab');
  await verifyFocus(page.locator('.ui-skip'));
  await page.keyboard.press('Tab'); // brand
  await page.keyboard.press('Tab'); // refresh
  assert.equal(await refresh.evaluate(el => el === document.activeElement), true);
  await verifyFocus(refresh);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#release-source').evaluate(el => el === document.activeElement), true);
  if (host === 'Browser') await page.screenshot({ path: `test-results/browser-focus${development ? '-development' : ''}.png`, fullPage: true });
}

if (!packaged) {
  const server = createServer(async (req, res) => {
    try {
      const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/preview\//, '');
      const file = path.resolve(root, relative || 'index.html');
      if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    for (const deviceScaleFactor of [1, 1.25]) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor, serviceWorkers: 'block' });
      const fixture = await installFixture(context, origin);
      const page = await context.newPage();
      await page.goto(`${origin}/preview/`);
      await verify(page, 'Browser', fixture);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: 'test-results/browser-mobile.png', fullPage: true });
      await page.locator('#release-source').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
      await context.close();
      console.log(`Verified browser startup interception and visible focus at DPR ${deviceScaleFactor}`);
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

if (development) {
  console.log('Verified development browser generated Tailwind styles and states');
  process.exit(0);
}

const executablePath = packaged
  ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`)
  : undefined;
const args = [...(packaged ? [] : ['.']), ...(process.platform === 'linux' ? ['--disable-gpu'] : [])];
const testProfile = path.resolve(`test-results/desktop-profile-${Date.now()}`);
await mkdir(testProfile, { recursive: true });
const app = await electron.launch({ executablePath, args, env: { ...process.env, MANAGER_TEST: '1', MANAGER_TEST_DEFER_LOAD: '1', MANAGER_TEST_PROFILE: testProfile } });
try {
  const fixture = await installFixture(app.context());
  const page = await app.firstWindow();
  assert.equal(page.url(), 'about:blank', 'Electron must defer UI startup until interception is ready');
  assert.equal(fixture.requests, 0);
  await app.evaluate(async ({ app, BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].loadFile(`${app.getAppPath()}/dist/manager/browser/index.html`);
  });
  // Xvfb's compositor needs a mapped window; this is a virtual CI display.
  if (process.platform === 'linux') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await verify(page, 'Desktop', fixture);
  if (packaged) assert.equal(await app.evaluate(({ app }) => app.getVersion()), info.version);
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  });
  assert.deepEqual(prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), testProfile);
  // Optional visual evidence: some headless compositors cannot capture a hidden
  // surface. DOM, runtime identity and isolation assertions above are mandatory.
  if (process.env.MANAGER_CAPTURE === '1') {
    await page.locator('section[aria-labelledby="release-title"]').evaluate(el => el.scrollIntoView({ block: 'start' }));
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (capture.isEmpty()) throw new Error('Desktop capture is empty');
      return capture.toPNG().toString('base64');
    });
    await writeFile(`test-results/desktop${packaged ? '-packaged' : ''}.png`, Buffer.from(png, 'base64'));
  }
} finally { await app.close(); }
console.log(`Verified ${packaged ? 'packaged desktop' : 'browser, responsive browser and Electron'}; version ${info.version}`);
