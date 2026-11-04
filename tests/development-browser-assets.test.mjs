import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stageDevelopmentBrowserAssets} from './fixtures/development-browser-assets.mjs';

test('development Electron assets include static and deferred chunks and restore exact production bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-asset-staging-'));
  const source = path.join(root, 'development');
  const destination = path.join(root, 'browser');
  try {
    await mkdir(path.join(source, 'lazy'), {recursive: true});
    await mkdir(destination);
    await writeFile(path.join(source, 'main.mjs'), "import {value} from './chunk.mjs'; export default async () => value + (await import('./lazy/stop.mjs')).value;");
    await writeFile(path.join(source, 'chunk.mjs'), 'export const value = 3;');
    await writeFile(path.join(source, 'lazy/stop.mjs'), 'export const value = 4;');
    const production = Buffer.from([0, 255, 13, 10, 42]);
    await writeFile(path.join(destination, 'main.mjs'), production);
    await writeFile(path.join(destination, 'production-only.txt'), 'keep');
    const restore = await stageDevelopmentBrowserAssets({source, destination});
    try {
      const module = await import(pathToFileURL(path.join(destination, 'main.mjs')).href);
      assert.equal(await module.default(), 7);
      assert.deepEqual((await readdir(destination)).sort(), ['chunk.mjs', 'lazy', 'main.mjs']);
    } finally {
      await restore();
    }
    assert.deepEqual((await readdir(destination)).sort(), ['main.mjs', 'production-only.txt']);
    assert.deepEqual(await readFile(path.join(destination, 'main.mjs')), production);
    assert.equal(await readFile(path.join(destination, 'production-only.txt'), 'utf8'), 'keep');
    assert.deepEqual((await readdir(root)).sort(), ['browser', 'development']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('failed development staging leaves production intact without a scratch directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-asset-staging-'));
  const destination = path.join(root, 'browser');
  try {
    await mkdir(destination);
    await writeFile(path.join(destination, 'index.html'), 'production');
    await assert.rejects(stageDevelopmentBrowserAssets({source: path.join(root, 'missing'), destination}));
    assert.equal(await readFile(path.join(destination, 'index.html'), 'utf8'), 'production');
    assert.deepEqual(await readdir(root), ['browser']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
