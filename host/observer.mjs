import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseRuntimeIdentity } from './runtime-identity.mjs';
import { parseOwnedReport } from './owned-report.mjs';
import { parsePersonalizationRequest, parsePersonalizationResult } from './personalization.mjs';
import { fileURLToPath } from 'node:url';

import { result, validateResult } from './observation-protocol.mjs';
export { statuses, result, validateResult } from './observation-protocol.mjs';

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
  async inspectRuntime() {
    const expected = this.lastObservation;
    const refusal = status => ({ ...result(status), runtime_identity: null });
    if (!expected) return refusal('observation-unavailable');
    const value = await this.run('runtime-identity', { connection_id: expected.connection_id, boot_id: expected.boot_id });
    if (!value.observation || value.observation.connection_id !== expected.connection_id || value.observation.boot_id !== expected.boot_id) return refusal(value.status === 'observed' ? 'cable-lost' : value.status);
    return value;
  }
  async personalization(request) {
    parsePersonalizationRequest(request);
    const expected = this.lastObservation;
    const refusal = outcome => ({ ...result('observation-unavailable'), personalization: { status: 'unavailable', report: null, outcome } });
    if (!expected || expected.connection_id !== request.connection_id || expected.boot_id !== request.boot_id) return refusal('not-dispatched');
    const prior = this.personalizationSnapshot;
    if (request.operation !== 'inspect' && (!prior || prior.connection_id !== request.connection_id || prior.boot_id !== request.boot_id || prior.report.config_sha256 !== request.expected_config_sha256)) return refusal('not-dispatched');
    this.personalizationSnapshot = null;
    const value = await this.run('personalization', request);
    if (!value.observation || value.observation.boot_id !== expected.boot_id || value.observation.connection_id !== expected.connection_id) return refusal(request.operation === 'inspect' ? 'read-only' : value.personalization.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown');
    const report = value.personalization.report;
    if (report?.status === 'ok') {
      const observed = report.personalization;
      if ((request.operation === 'set' && (observed.text !== request.text || observed.enabled !== request.enabled)) ||
          (request.operation === 'disable' && (observed.enabled || observed.text !== prior.report.personalization.text)) ||
          (request.operation === 'clear' && (observed.enabled || observed.text !== ''))) return refusal('unknown');
      this.personalizationSnapshot = { connection_id: request.connection_id, boot_id: request.boot_id, report };
    }
    return value;
  }
  async run(action, request) {
    this.cancel();
    const personal = action === 'personalization', runtime = action === 'runtime-identity';
    let launched = false;
    const refusal = status => runtime ? { ...result(status), runtime_identity: null } : personal ? { ...result(status), personalization: { status: 'unavailable', report: null, outcome: request.operation === 'inspect' ? 'read-only' : launched ? 'unknown' : 'not-dispatched' } } : action === 'observe' ? result(status) : { ...result(status), inspection: null };
    if (!['linux', 'win32'].includes(this.platform)) return refusal('unsupported-host');
    if (!this.config || !this.python || !path.isAbsolute(this.config) || !path.isAbsolute(this.python)) return refusal('unconfigured');
    const generation = this.generation;
    return new Promise(resolve => {
      const script = runtime ? path.join(path.dirname(this.script), 'runtime_identity_transport.py') : personal ? path.join(path.dirname(this.script), 'personalization_transport.py') : this.script;
      const child = spawn(this.python, [script, ...(personal || runtime || action === 'observe' ? [] : [action])], { stdio: [personal || runtime ? 'pipe' : 'ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', MANAGER_WIRED_CONFIG: this.config } });
      this.active = child;
      child.once('spawn', () => { launched = true; });
      if (personal || runtime) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request)); }
      const chunks = []; let outputBytes = 0, expired = false, oversized = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, this.timeoutMs);
      child.stdout.on('data', data => {
        chunks.push(data); outputBytes += data.length;
        if (outputBytes > (personal ? 139264 : runtime || action === 'observe' ? 8192 : 49152)) { oversized = true; child.kill('SIGKILL'); }
      });
      const finish = code => {
        clearTimeout(timer);
        if (this.active === child) this.active = null;
        if (generation !== this.generation) return resolve(refusal('cancelled'));
        if (expired) return resolve(refusal('timeout'));
        if (code !== 0 || oversized) return resolve(refusal('observation-unavailable'));
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (action === 'observe') return resolve(validateResult(value));
          if (personal) return resolve(parsePersonalizationResult(value, request, validateResult));
          if (runtime) {
            if (Object.keys(value).sort().join() !== 'contract_version,observation,runtime_identity,status') throw new Error('Invalid runtime identity');
            validateResult({ contract_version: value.contract_version, status: value.status, observation: value.observation });
            if (value.status === 'observed') parseRuntimeIdentity(value.runtime_identity);
            else if (value.runtime_identity !== null) throw new Error('Invalid runtime identity');
            return resolve(value);
          }
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
