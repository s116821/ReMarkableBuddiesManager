import path from 'node:path';
import { startHelper } from '../host/browser-helper.mjs';
const helper = await startHelper({ root: path.resolve('dist/manager/browser') });
console.log(`Open the local Manager: ${helper.origin}/preview/`);
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await helper.close(); process.exit(0); });
