import {cp, mkdtemp, rename, rm} from 'node:fs/promises';
import path from 'node:path';

// Electron authorizes the fixed production URL. Stage the entire development
// output there, including split chunks, then restore the original directory.
export async function stageDevelopmentBrowserAssets({
  source = path.resolve('test-results/development/browser'),
  destination = path.resolve('dist/manager/browser'),
} = {}) {
  const folder = await mkdtemp(path.join(path.dirname(destination), '.development-host-'));
  const original = path.join(folder, 'original');
  const staged = path.join(folder, 'staged');
  let originalMoved = false;
  let developmentMoved = false;
  const restore = async () => {
    if (developmentMoved) {
      await rm(destination, {recursive: true});
      developmentMoved = false;
    }
    if (originalMoved) {
      await rename(original, destination);
      originalMoved = false;
    }
    await rm(folder, {recursive: true, force: true});
  };
  try {
    await cp(source, staged, {recursive: true, errorOnExist: true, force: false});
    await rename(destination, original);
    originalMoved = true;
    await rename(staged, destination);
    developmentMoved = true;
    return restore;
  } catch (error) {
    await restore();
    throw error;
  }
}
