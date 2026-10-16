import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class DriveStore {
  constructor({ root = process.env.MANAGER_DRIVE_AUTH_ROOT ?? path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? homedir() : process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'ReMarkableBuddiesManager', 'drive-auth'),
    python = process.env.MANAGER_DRIVE_PYTHON ?? process.env.MANAGER_WIRED_PYTHON,
    script = fileURLToPath(new URL('./drive_store.py', import.meta.url)) } = {}) { this.root = root; this.python = python; this.script = script; }
  operation(value) {
    if (!this.python || !path.isAbsolute(this.python) || !path.isAbsolute(this.root)) throw new Error('storage-unavailable');
    const input = JSON.stringify(value);
    if (Buffer.byteLength(input) > 49152) throw new Error('storage-unavailable');
    // No await between the final flow guard and atomic credential commit. Cancellation after
    // this bounded synchronous save is after commit; it is not an implicit disconnect/revoke.
    const result = spawnSync(this.python, ['-I', '-B', this.script, this.root], { input, encoding: 'utf8', timeout: 3000, maxBuffer: 65536,
      windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' } });
    if (result.status !== 0 || result.error || result.stderr || Buffer.byteLength(result.stdout ?? '') > 65536) throw new Error('storage-unavailable');
    const response = JSON.parse(result.stdout);
    if (response.error) throw new Error('storage-unavailable');
    return response;
  }
  client() { return this.operation({ operation: 'read-client' }); }
  grant() { return this.operation({ operation: 'read-grant' }); }
  save(value, client_digest, grant_digest) { return this.operation({ operation: 'save', value, client_digest, grant_digest }); }
  disconnect(client_digest, grant_digest) { return this.operation({ operation: 'disconnect', client_digest, grant_digest }); }
}
