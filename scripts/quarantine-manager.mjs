import { quarantineManagerRelease } from '../host/quarantine.mjs';

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--tag' || args[2] !== '--directory' || args[4] !== '--python') {
  console.error('Usage: node scripts/quarantine-manager.mjs --tag vMAJOR.MINOR.PATCH --directory NEW_ABSOLUTE_DIRECTORY --python TRUSTED_ABSOLUTE_PYTHON312');
  process.exitCode = 2;
} else {
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const result = await quarantineManagerRelease({ tag: args[1], directory: args[3], python: args[5], signal: controller.signal });
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
}
