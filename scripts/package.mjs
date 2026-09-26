import { packager } from '@electron/packager';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';

const info = JSON.parse(readFileSync('electron/build-info.json', 'utf8'));
const platform = process.env.MANAGER_PACKAGE_PLATFORM ?? process.platform;
if (!['win32', 'linux'].includes(platform)) throw new Error('Foundation packages support Windows and Linux x64');
// Only the explicit runtime files enter the package; no source, .git or development dependencies.
mkdirSync('out/staging', { recursive: true });
cpSync('dist', 'out/staging/dist', { recursive: true });
cpSync('electron', 'out/staging/electron', { recursive: true });
writeFileSync('out/staging/package.json', JSON.stringify({ name: 'remarkable-buddies-manager', version: info.version, main: 'electron/main.cjs', author: 'ReMarkableBuddies contributors', license: 'GPL-3.0-only' }, null, 2));
cpSync('LICENSE', 'out/staging/LICENSE');
const paths = await packager({
  dir: 'out/staging', out: 'out/packages', name: 'ReMarkableBuddiesManager',
  platform, arch: 'x64', overwrite: true, prune: false,
  // Keep the dev identifier in ProductVersion/package.json, with numeric FileVersion.
  appVersion: info.version, buildVersion: info.version.split('-')[0],
  electronVersion: '44.4.5', asar: true,
});
console.log(JSON.stringify(paths));
