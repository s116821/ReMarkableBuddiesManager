import {expect} from '@playwright/test';

const panels = {
  tablet: ['tablet', 'overview'], manager: ['tablet', 'overview', 'Manager updates'],
  product: ['settings', 'reader'], model: ['settings', 'model'],
  credential: ['settings', 'model', 'Credential file reference setup'],
  research: ['settings', 'research'], personalization: ['settings', 'personalization'],
  'memory-settings': ['settings', 'memory'], portable: ['settings', 'preferences'],
  conversations: ['data', 'conversations'], memory: ['data', 'memory'], handwriting: ['data', 'handwriting'],
  storage: ['data', 'storage', '', 'overview'], cache: ['data', 'storage', '', 'cache'],
  setup: ['tablet', 'setup'], owned: ['data', 'storage', '', 'legacy'],
  shared: ['settings', 'shared'], 'backup-setup': ['backup', 'setup'], cloud: ['backup', 'cloud'],
  drive: ['backup', 'account'], mode: ['backup', 'mode'], local: ['backup', 'mode', 'Change to Local-only'],
  export: ['backup', 'archives', '', '', 'export', 'legacy'],
  archive: ['backup', 'archives', '', '', 'export', 'history'],
  notebook: ['backup', 'archives', '', '', 'export', 'notebook'],
  'notebook-check': ['backup', 'archives', '', '', 'check', 'notebook'],
  'archive-check': ['backup', 'archives', '', '', 'check', 'history'],
  restore: ['backup', 'archives', '', '', 'restore', 'legacy'],
  'notebook-restore': ['backup', 'archives', '', '', 'restore', 'notebook'],
  configuration: ['troubleshooting', 'configuration'], basic: ['troubleshooting', 'diagnostics'],
  runtime: ['troubleshooting', 'runtime'],
};

/** Use the same visible navigation and workflow selectors as an operator. */
export async function showPanel(page, panel) {
  const route = panels[panel];
  if (!route) throw new Error(`Unknown Manager test destination: ${panel}`);
  const [destination, item, summary, storage, task, family] = route;
  const main = page.getByTestId(`nav-${destination}`);
  if (await main.getAttribute('aria-current') !== 'page') await main.click();
  await expect(main).toHaveAttribute('aria-current', 'page');
  if (item) {
    const sub = page.getByTestId(`nav-${destination}-${item}`);
    if (await sub.getAttribute('aria-current') !== 'page') await sub.click();
    await expect(sub).toHaveAttribute('aria-current', 'page');
  }
  if (storage && await page.locator('#storage-task').inputValue() !== storage) await page.locator('#storage-task').selectOption(storage);
  if (task && await page.locator('#archive-task').inputValue() !== task) await page.locator('#archive-task').selectOption(task);
  if (family && await page.locator('#archive-family').inputValue() !== family) await page.locator('#archive-family').selectOption(family);
  if (summary) {
    const toggle = page.locator('summary').filter({hasText: new RegExp(`^${summary}$`)});
    if (!await toggle.evaluate(el => el.parentElement.open)) await toggle.click();
  }
}

export async function readTabletFor(page, panel = 'tablet') {
  await showPanel(page, 'tablet');
  const stamp = page.getByText(/^Observed at /);
  const previous = await stamp.allTextContents();
  await page.getByRole('button', {name: 'Read tablet state', exact: true}).click();
  await expect.poll(async () => { const current = await stamp.allTextContents(); return current.length === 1 && (previous.length !== 1 || current[0] !== previous[0]); }).toBe(true);
  await expect(page.getByTestId('tablet-model')).toBeVisible();
  await showPanel(page, panel);
}

export async function disconnectFor(page, panel) {
  await showPanel(page, 'tablet');
  await page.getByRole('button', {name: 'Disconnect', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Disconnected', exact: true})).toBeVisible();
  await showPanel(page, panel);
}
