import { copyFileSync } from 'node:fs';

copyFileSync('dist/manager/3rdpartylicenses.txt', 'dist/manager/browser/3rdpartylicenses.txt');
copyFileSync('LICENSE', 'dist/manager/browser/LICENSE.txt');
