import { chromium, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const root = path.resolve('dist/manager/browser');
const info = JSON.parse(await readFile('electron/build-info.json', 'utf8'));
await mkdir('test-results', { recursive: true });

async function verify(page, host) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'A home for your Buddies.' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Not configured', exact: true }).count(), 1);
  assert.equal(await page.getByText(`${host} edition`, { exact: true }).count(), 1);
  assert.equal(await page.getByTestId('version').textContent(), info.version);
  assert.equal(await page.getByText('Coming in a later release', { exact: true }).count(), 3);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  if (host === 'Browser') await page.screenshot({ path: 'test-results/browser.png', fullPage: true });
  assert.deepEqual(errors, []);
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/preview/`);
    await verify(page, 'Browser');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'test-results/browser-mobile.png', fullPage: true });
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const executablePath = packaged
  ? path.resolve(`out/packages/ReMarkableBuddiesManager-${process.platform}-x64/${process.platform === 'win32' ? 'ReMarkableBuddiesManager.exe' : 'ReMarkableBuddiesManager'}`)
  : undefined;
const app = await electron.launch({ executablePath, args: packaged ? [] : ['.'], env: { ...process.env, MANAGER_TEST: '1' } });
try {
  const page = await app.firstWindow();
  await verify(page, 'Desktop');
  if (packaged) assert.equal(await app.evaluate(({ app }) => app.getVersion()), info.version);
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  });
  assert.deepEqual(prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (capture.isEmpty()) throw new Error('Desktop capture is empty');
    return capture.toPNG().toString('base64');
  });
  await writeFile(`test-results/desktop${packaged ? '-packaged' : ''}.png`, Buffer.from(png, 'base64'));
} finally { await app.close(); }
console.log(`Verified ${packaged ? 'packaged desktop' : 'browser, responsive browser and Electron'}; version ${info.version}`);
