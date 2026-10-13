import { packager } from '@electron/packager';
import { build } from 'esbuild';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';

const info = JSON.parse(readFileSync('electron/build-info.json', 'utf8'));
const platform = process.env.MANAGER_PACKAGE_PLATFORM ?? process.platform;
if (!['win32', 'linux'].includes(platform)) throw new Error('Foundation packages support Windows and Linux x64');
// Only the explicit runtime files enter the package; no source, .git or development dependencies.
mkdirSync('out/staging', { recursive: true });
cpSync('dist', 'out/staging/dist', { recursive: true });
cpSync('electron', 'out/staging/electron', { recursive: true });
writeFileSync('out/staging/package.json', JSON.stringify({ name: 'remarkable-buddies-manager', version: info.version, main: 'electron/main.cjs', author: 'ReMarkableBuddies contributors', license: 'GPL-3.0-only' }, null, 2));
cpSync('LICENSE', 'out/staging/LICENSE');
rmSync('out/host', { recursive: true, force: true });
cpSync('host', 'out/host', { recursive: true, filter: file => !file.includes('__pycache__') && !file.endsWith('.pyc') });
// Bundle the pinned maintained OAuth client into the Node host runtime, never the renderer.
// Built-in imports stay external; matching dependency LICENSE/NOTICE files accompany it.
const bundled = await build({ entryPoints: ['host/drive-auth.mjs'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: 'out/host/drive-auth.mjs', legalComments: 'eof', metafile: true,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
const modules = new Map();
for (const file of Object.keys(bundled.metafile.inputs)) {
  if (!file.startsWith('node_modules/')) continue;
  let directory = path.dirname(file);
  while (directory.startsWith('node_modules/')) {
    try { const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name && metadata.version) { modules.set(directory, metadata); break; } } catch { /* Walk to actual package root. */ }
    directory = path.dirname(directory);
  }
}
mkdirSync('out/host/third-party', { recursive: true });
for (const [directory, metadata] of modules) {
  const destination = path.join('out/host/third-party', metadata.name.replaceAll('/', '_')); mkdirSync(destination, { recursive: true });
  let found = false;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENSE-MIT', 'LICENSE.markdown', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'licence', 'NOTICE', 'NOTICE.txt']) {
    try { cpSync(path.join(directory, filename), path.join(destination, filename)); if (/licen[cs]e/i.test(filename)) found = true; } catch { /* Try each normal upstream notice filename. */ }
  }
  if (!found && metadata.license === 'MIT') {
    // Some npm artifacts carry their full matching grant in README rather than LICENSE.
    try { const readme = readFileSync(path.join(directory, 'README.md'), 'utf8');
      if (readme.includes('Permission is hereby granted, free of charge') && readme.includes('The above copyright notice') && readme.includes('THE SOFTWARE IS PROVIDED')) {
        cpSync(path.join(directory, 'README.md'), path.join(destination, 'README.md')); found = true;
      }
    } catch { /* Missing/unknown grants still fail packaging. */ }
  }
  if (!found) throw new Error(`Missing runtime license for ${metadata.name}`);
}
writeFileSync('out/host/third-party/dependencies.json', JSON.stringify([...modules.values()].map(({ name, version, license }) => ({ name, version, license })), null, 2));
const paths = await packager({
  dir: 'out/staging', out: 'out/packages', name: 'ReMarkableBuddiesManager',
  platform, arch: 'x64', overwrite: true, prune: false,
  // Keep the dev identifier in ProductVersion/package.json, with numeric FileVersion.
  appVersion: info.version, buildVersion: info.version.split('-')[0],
  electronVersion: '44.4.5', asar: true, extraResource: ['out/host'],
});
console.log(JSON.stringify(paths));
