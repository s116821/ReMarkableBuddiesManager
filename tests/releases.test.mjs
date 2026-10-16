import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCandidate, ReleaseController, RELEASE_API, SOURCE_KEY, POLL_MS } from '../src/releases.ts';
const release = (tag = 'v0.3.0') => ({ tag_name: tag, draft: false, prerelease: false,
  html_url: `https://github.com/s116821/ReMarkableBuddies/releases/tag/${tag}`, published_at: '2026-10-08T12:00:00Z',
  assets: [{ name: 'package.apk', state: 'uploaded', size: 12,
    browser_download_url: `https://github.com/s116821/ReMarkableBuddies/releases/download/${tag}/package.apk` }] });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
test('stable identity excludes previews, wrong provenance and incomplete asset state', () => {
  assert.equal(decodeCandidate(release()).assetsPublished, true);
  for (const patch of [{ prerelease: true }, { draft: true }, { tag_name: 'v0.3.0-rc.1' }, { html_url: 'https://other.invalid' }, { assets: null }]) assert.throws(() => decodeCandidate({ ...release(), ...patch }));
  const incomplete = release(); incomplete.assets[0].state = 'starter';
  assert.equal(decodeCandidate(incomplete).assetsPublished, false);
  assert.equal(decodeCandidate({ ...release(), assets: [] }).assetsPublished, false);
});
test('refresh discovers stable promotion; rate limit marks retained metadata stale', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let result = response({ ...release(), prerelease: true });
  const controller = new ReleaseController(null, () => {}, async (url, options) => { assert.equal(url, RELEASE_API); assert.equal(options.credentials, 'omit'); return result; });
  await controller.refresh(); assert.equal(controller.state.status, 'error'); assert.equal(controller.state.candidate, null);
  result = response(release()); await controller.refresh(); assert.equal(controller.state.candidate.tag, 'v0.3.0');
  result = response({}, 429); await controller.refresh(); assert.equal(controller.state.stale, true); assert.match(controller.state.error, /rate limit/);
  t.mock.timers.tick(POLL_MS + 1);
  result = response({}, 404); await controller.refresh(); assert.equal(controller.state.status, 'missing'); assert.equal(controller.state.candidate, null); controller.dispose();
});
test('actual polling updates same controller without restart', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let tag = 'v0.3.0';
  const controller = new ReleaseController(null, () => {}, async () => response(release(tag)));
  controller.start(); await new Promise(resolve => setImmediate(resolve));
  tag = 'v0.4.0'; t.mock.timers.tick(POLL_MS); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.state.candidate.tag, 'v0.4.0'); controller.dispose();
});
test('poll and manual refresh honor retry/reset backoff; promotion appears after delay', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  let calls = 0;
  const controller = new ReleaseController(null, () => {}, async () => {
    calls++;
    return calls < 2 ? new Response('{}', { status: 429, headers: { 'Retry-After': '900', 'X-RateLimit-Reset': '2200' } }) : response(release('v0.4.0'));
  });
  controller.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.state.retryAt, new Date(2_200_000).toISOString());
  t.mock.timers.tick(POLL_MS); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  await controller.refresh(); assert.equal(calls, 1);
  t.mock.timers.tick(POLL_MS); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  await controller.refresh(); assert.equal(calls, 1);
  t.mock.timers.tick(2 * POLL_MS); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(controller.state.candidate.tag, 'v0.4.0');
  assert.equal(controller.state.retryAt, null); controller.dispose();
});
test('policy persists and unavailable community stays honest; storage failure visible', () => {
  const saved = new Map([[SOURCE_KEY, 'community']]);
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const first = new ReleaseController(storage, () => {}); assert.equal(first.state.preference, 'community');
  first.chooseOfficial(); assert.equal(new ReleaseController(storage, () => {}).state.preference, 'official');
  const broken = new ReleaseController({ getItem() { throw Error(); }, setItem() { throw Error(); } }, () => {});
  assert.equal(broken.state.persistenceError, true); broken.chooseOfficial(); assert.equal(broken.state.persistenceError, true);
});
test('overlap and disposal cannot admit late metadata', async () => {
  let finish; let calls = 0;
  const controller = new ReleaseController(null, () => {}, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const request = controller.refresh(); await controller.refresh(); assert.equal(calls, 1);
  controller.dispose(); finish(response(release())); await request; assert.equal(controller.state.candidate, null);
});

test('Manager stable identity is repository-specific and requires all expected published asset metadata', async () => {
  const { MANAGER_ASSETS } = await import('../src/releases.ts');
  const own = { ...release('v0.4.0'), html_url: 'https://github.com/s116821/ReMarkableBuddiesManager/releases/tag/v0.4.0',
    assets: MANAGER_ASSETS.map(name => ({ name, state: 'uploaded', size: 12,
      browser_download_url: `https://github.com/s116821/ReMarkableBuddiesManager/releases/download/v0.4.0/${name}` })) };
  assert.equal(decodeCandidate(own, 'manager').assetsPublished, true);
  assert.throws(() => decodeCandidate(own));
  assert.throws(() => decodeCandidate(release(), 'manager'));
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.4.0-rc.1' }]) assert.throws(() => decodeCandidate({ ...own, ...patch }, 'manager'));
  assert.equal(decodeCandidate({ ...own, assets: own.assets.slice(1) }, 'manager').assetsPublished, false);
  const bad = structuredClone(own); bad.assets[0].browser_download_url = 'https://other.invalid/file.zip';
  assert.equal(decodeCandidate(bad, 'manager').assetsPublished, false);
});
test('Manager discovery refresh/backoff/failure stays independent from Buddy preference and cancellation', async () => {
  const { MANAGER_RELEASE_API, MANAGER_ASSETS } = await import('../src/releases.ts');
  let ownTag = 'v0.4.0', ownFailure = false, ownCalls = 0;
  const own = () => ({ tag_name: ownTag, html_url: `https://github.com/s116821/ReMarkableBuddiesManager/releases/tag/${ownTag}`,
    published_at: '2026-10-12T12:00:00Z', draft: false, prerelease: false,
    assets: MANAGER_ASSETS.map(name => ({ name, state: 'uploaded', size: 12,
      browser_download_url: `https://github.com/s116821/ReMarkableBuddiesManager/releases/download/${ownTag}/${name}` })) });
  const store = { getItem: () => 'community', setItem: () => { throw new Error('Manager must not write Buddy preference'); } };
  const manager = new ReleaseController(store, () => {}, async url => {
    assert.equal(url, MANAGER_RELEASE_API); ownCalls++;
    return ownFailure ? new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }) : response(own());
  }, 'manager');
  const buddy = new ReleaseController(store, () => {}, async url => { assert.equal(url, RELEASE_API); return response(release()); });
  try {
    assert.equal(manager.state.preference, 'official');
    assert.equal(manager.state.persistenceError, false);
    assert.equal(buddy.state.preference, 'community');
    manager.chooseOfficial();
    await Promise.all([manager.refresh(), buddy.refresh()]);
    ownTag = 'v0.5.0'; await manager.refresh();
    assert.equal(manager.state.candidate.tag, ownTag);
    assert.equal(buddy.state.candidate.tag, 'v0.3.0');
    ownFailure = true; await manager.refresh();
    assert.equal(manager.state.stale, true);
    const count = ownCalls; await manager.refresh(); assert.equal(ownCalls, count);
    await buddy.refresh(); assert.equal(buddy.state.status, 'ready');
  } finally { manager.dispose(); buddy.dispose(); }
});
