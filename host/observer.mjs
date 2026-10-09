import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const statuses = new Set(['unconfigured', 'unsupported-host', 'disconnected', 'untrusted', 'authentication-required', 'timeout', 'cancelled', 'cable-lost', 'observation-unavailable', 'observed']);
export const result = (status, observation = null) => ({ contract_version: 1, status, observation });
export function validateResult(value) {
  if (!value || value.contract_version !== 1 || !statuses.has(value.status) || Object.keys(value).sort().join() !== 'contract_version,observation,status') throw new Error('Invalid observation');
  if (value.status !== 'observed') {
    if (value.observation !== null) throw new Error('Invalid observation');
    return value;
  }
  const o = value.observation;
  if (!o || Object.keys(o).sort().join() !== 'architecture,boot_id,connection_id,firmware,firmware_conflict,installed_version,model,provenance,service' ||
      !/^[a-f0-9]{64}$/.test(o.connection_id) || !/^[a-f0-9-]{36}$/.test(o.boot_id) ||
      o.installed_version !== null || o.provenance !== 'unknown' || typeof o.firmware_conflict !== 'boolean') throw new Error('Invalid observation');
  for (const key of ['model', 'firmware', 'architecture']) if (o[key] !== null && (typeof o[key] !== 'string' || !/^[A-Za-z0-9 ._()+/-]{1,96}$/.test(o[key]))) throw new Error('Invalid observation');
  if (!o.service || Object.keys(o.service).sort().join() !== 'ActiveState,LoadState,SubState') throw new Error('Invalid observation');
  for (const value of Object.values(o.service)) if (value !== null && (typeof value !== 'string' || !/^[a-z-]{1,32}$/.test(value))) throw new Error('Invalid observation');
  return value;
}

// One host-controlled config/runtime; renderer calls never carry paths or commands.
export class WiredObserver {
  constructor({ config = process.env.MANAGER_WIRED_CONFIG, python = process.env.MANAGER_WIRED_PYTHON,
    script = fileURLToPath(new URL('./wired_observer.py', import.meta.url)), platform = process.platform, timeoutMs = 13000 } = {}) {
    this.config = config; this.python = python; this.script = script; this.platform = platform;
    this.active = null; this.generation = 0; this.timeoutMs = timeoutMs;
  }
  cancel() { this.generation++; this.active?.kill('SIGKILL'); return result('cancelled'); }
  async observe() {
    this.cancel();
    if (!['linux', 'win32'].includes(this.platform)) return result('unsupported-host');
    if (!this.config || !this.python || !path.isAbsolute(this.config) || !path.isAbsolute(this.python)) return result('unconfigured');
    const generation = this.generation;
    return new Promise(resolve => {
      const child = spawn(this.python, [this.script], { stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', MANAGER_WIRED_CONFIG: this.config } });
      this.active = child;
      let output = '', expired = false, oversized = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, this.timeoutMs);
      child.stdout.on('data', data => {
        output += data.toString('utf8');
        if (output.length > 8192) { oversized = true; child.kill('SIGKILL'); }
      });
      const finish = code => {
        clearTimeout(timer);
        if (this.active === child) this.active = null;
        if (generation !== this.generation) return resolve(result('cancelled'));
        if (expired) return resolve(result('timeout'));
        if (code !== 0 || oversized) return resolve(result('observation-unavailable'));
        try { resolve(validateResult(JSON.parse(output))); } catch { resolve(result('observation-unavailable')); }
      };
      child.once('error', () => finish(-1));
      child.once('close', finish);
    });
  }
}
