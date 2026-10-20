import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-manager-bundle.py', import.meta.url));
// Trusted, explicitly selected host interpreter; no archive-supplied executable.
export async function verifyManagerBundles({ python, directory, tag, sha, signal }) {
  if (typeof python !== 'string' || !isAbsolute(python)) throw new Error('verifier-unconfigured');
  const executable = await realpath(python);
  if (!(await lstat(executable)).isFile()) throw new Error('verifier-unconfigured');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-I', '-S', '-B', SCRIPT, directory, tag, sha], { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8' } });
    let output = ''; let bytes = 0; let stderrBytes = 0; let oversized = false; let expired = false; let failed = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 30000);
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const count = data => { bytes += data.length; if (bytes > 8192) { oversized = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', data => { count(data); if (!oversized) output += data.toString('utf8'); });
    child.stderr.on('data', data => { stderrBytes += data.length; count(data); });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason);
      if (expired) return reject(new Error('verifier-timeout'));
      if (failed || oversized || stderrBytes || code !== 0) return reject(new Error('verifier-refused'));
      // Exact fixed response; don't pass subprocess paths or diagnostics through.
      if (output !== '{"ok":true,"embeddedIdentityVerified":true,"archivesExtracted":false,"payloadExecuted":false}\n') return reject(new Error('verifier-refused'));
      resolve();
    });
  });
}
