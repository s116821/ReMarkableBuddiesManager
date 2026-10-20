import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseOwnedReport } from './owned-report.mjs';
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
    const value = await this.run('observe');
    this.lastObservation = value.status === 'observed' ? value.observation : null;
    return value;
  }
  async inspectOwned() {
    const expected = this.lastObservation;
    if (!expected) return { ...result('observation-unavailable'), inspection: null };
    const value = await this.run('inspect-owned');
    if (value.observation && (value.observation.boot_id !== expected.boot_id || value.observation.connection_id !== expected.connection_id)) {
      this.lastObservation = null;
      return { ...result('cable-lost'), inspection: null };
    }
    return value;
  }
  async run(action) {
    this.cancel();
    const refusal = status => action === 'observe' ? result(status) : { ...result(status), inspection: null };
    if (!['linux', 'win32'].includes(this.platform)) return refusal('unsupported-host');
    if (!this.config || !this.python || !path.isAbsolute(this.config) || !path.isAbsolute(this.python)) return refusal('unconfigured');
    const generation = this.generation;
    return new Promise(resolve => {
      const child = spawn(this.python, [this.script, ...(action === 'observe' ? [] : [action])], { stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', MANAGER_WIRED_CONFIG: this.config } });
      this.active = child;
      let output = '', expired = false, oversized = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, this.timeoutMs);
      child.stdout.on('data', data => {
        output += data.toString('utf8');
        if (Buffer.byteLength(output) > (action === 'observe' ? 8192 : 49152)) { oversized = true; child.kill('SIGKILL'); }
      });
      const finish = code => {
        clearTimeout(timer);
        if (this.active === child) this.active = null;
        if (generation !== this.generation) return resolve(refusal('cancelled'));
        if (expired) return resolve(refusal('timeout'));
        if (code !== 0 || oversized) return resolve(refusal('observation-unavailable'));
        try {
          const value = JSON.parse(output);
          if (action === 'observe') return resolve(validateResult(value));
          if (!value || Object.keys(value).sort().join() !== 'contract_version,inspection,observation,status') throw new Error('Invalid inspection');
          validateResult({ contract_version: value.contract_version, status: value.status, observation: value.observation });
          if (value.status !== 'observed') {
            if (value.inspection !== null) throw new Error('Invalid inspection');
          } else {
            const i = value.inspection;
            if (!i || Object.keys(i).sort().join() !== 'report,status' || !['reported', 'unsupported', 'unavailable'].includes(i.status)) throw new Error('Invalid inspection');
            if (i.status === 'reported') {
              try { i.report = parseOwnedReport(i.report); }
              catch (error) { i.status = error.message === 'Unsupported owned-data report' ? 'unsupported' : 'unavailable'; i.report = null; }
            } else if (i.report !== null) throw new Error('Invalid inspection');
          }
          resolve(value);
        } catch { resolve(refusal('observation-unavailable')); }
      };
      child.once('error', () => finish(-1));
      child.once('close', finish);
    });
  }
}
