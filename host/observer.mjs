import { parseSavedConfigurationRequest, reduceSavedConfigurationResult } from './saved-configuration.mjs';
import { parseMemoryInspectionRequest, reduceMemoryInspectionResult } from './memory-inspection.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseMemoryRequest, parseMemoryResult } from './memory-query.mjs';
import { parseSavedModeRequest, reduceSavedModeResult } from './saved-mode.mjs';
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
  async memoryQuery(request) {
    parseMemoryRequest(request);
    const expected = this.lastObservation;
    if (!expected || expected.connection_id !== request.connection_id || expected.boot_id !== request.boot_id) return { ...result('observation-unavailable'), memory_query: { status: 'unavailable', report: null } };
    return this.run('memory-query', request);
  }
  async inspectMemory(request) {
    parseMemoryInspectionRequest(request);
    const expected = this.lastObservation;
    if (!expected || expected.connection_id !== request.connection_id || expected.boot_id !== request.boot_id) return { ...result('observation-unavailable'), memory_inspection: { status: 'unavailable', view: null } };
    return this.run('memory-inspection', request);
  }
  async inspectSavedConfiguration(request) {
    parseSavedConfigurationRequest(request);
    const expected=this.lastObservation;
    const refusal=status=>({...result(status),saved_configuration:{status:'unavailable',view:null}});
    if(!expected||expected.connection_id!==request.connection_id||expected.boot_id!==request.boot_id)return refusal('observation-unavailable');
    const pending=this.run('saved-configuration',request),generation=this.generation;
    const value=await pending;
    return generation===this.generation?value:refusal('cancelled');
  }
  async inspectSavedMode(request) {
    parseSavedModeRequest(request);
    const expected = this.lastObservation;
    if (!expected || expected.connection_id !== request.connection_id || expected.boot_id !== request.boot_id) return { ...result('observation-unavailable'), saved_mode: { status: 'unavailable', view: null } };
    return this.run('saved-mode', request);
  }
  async run(action, request) {
    this.cancel();
    const basic = action === 'basic-settings';
    const configuration = action === 'saved-configuration';
    const forget = action === 'memory-forget', detail = action === 'memory-inspection', saved = action === 'saved-mode', memory = action === 'memory-query', personal = action === 'personalization', runtime = action === 'runtime-identity';
    let launched = false;
    const refusal = status => basic ? {...result(status),basic_raw:{status:'unavailable',stdout_base64:null}} : configuration ? {...result(status),saved_configuration:{status:'unavailable',view:null}} : forget ? { ...result(status), forget_raw: { status:'unavailable', stdout_base64:null } } : detail ? { ...result(status), memory_inspection: { status: 'unavailable', view: null } } : saved ? { ...result(status), saved_mode: { status: 'unavailable', view: null } } : memory ? { ...result(status), memory_query: { status: 'unavailable', report: null } } : runtime ? { ...result(status), runtime_identity: null } : personal ? { ...result(status), personalization: { status: 'unavailable', report: null, outcome: request.operation === 'inspect' ? 'read-only' : launched ? 'unknown' : 'not-dispatched' } } : action === 'observe' ? result(status) : { ...result(status), inspection: null };
    if (!['linux', 'win32'].includes(this.platform)) return refusal('unsupported-host');
    if (!this.config || !this.python || !path.isAbsolute(this.config) || !path.isAbsolute(this.python)) return refusal('unconfigured');
    const generation = this.generation;
    return new Promise(resolve => {
      const script = basic ? path.join(path.dirname(this.script), 'basic_settings_transport.py') : configuration ? path.join(path.dirname(this.script), 'saved_configuration_transport.py') : forget ? path.join(path.dirname(this.script), 'memory_forget_transport.py') : detail ? path.join(path.dirname(this.script), 'memory_inspection_transport.py') : saved ? path.join(path.dirname(this.script), 'saved_mode_transport.py') : memory ? path.join(path.dirname(this.script), 'memory_query_transport.py') : runtime ? path.join(path.dirname(this.script), 'runtime_identity_transport.py') : personal ? path.join(path.dirname(this.script), 'personalization_transport.py') : this.script;
      const child = spawn(this.python, [script, ...(personal || runtime || memory || saved || detail || forget || configuration || basic || action === 'observe' ? [] : [action])], { stdio: [personal || runtime || memory || saved || detail || forget || configuration || basic ? 'pipe' : 'ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', MANAGER_WIRED_CONFIG: this.config } });
      this.active = child;
      child.once('spawn', () => { launched = true; });
      if (personal || runtime || memory || saved || detail || forget || configuration || basic) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request)); }
      const chunks = []; let outputBytes = 0, expired = false, oversized = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, this.timeoutMs);
      child.stdout.on('data', data => {
        chunks.push(data); outputBytes += data.length;
        if (outputBytes > (basic ? 24576 : configuration ? 139264 : forget ? 360448 : detail ? 278528 : saved ? 32768 : personal || memory ? 139264 : runtime || action === 'observe' ? 8192 : 49152)) { oversized = true; child.kill('SIGKILL'); }
      });
      const finish = async code => {
        clearTimeout(timer);
        if (this.active === child) this.active = null;
        if (generation !== this.generation) return resolve(refusal('cancelled'));
        if (expired) return resolve(refusal('timeout'));
        if (code !== 0 || oversized) return resolve(refusal('observation-unavailable'));
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (action === 'observe') return resolve(validateResult(value));
          if (configuration) {
            const reduced=reduceSavedConfigurationResult(value,request,validateResult);
            return resolve(generation===this.generation?reduced:refusal('cancelled'));
          }
          if (basic) {
            if(Object.keys(value).sort().join()!=='basic_raw,contract_version,observation,status')throw Error('Private response refused');
            validateResult({contract_version:value.contract_version,status:value.status,observation:value.observation});
            const q=value.basic_raw;if(!q||Object.keys(q).sort().join()!=='status,stdout_base64'||!['reported','unsupported','unavailable'].includes(q.status)||(q.status==='reported'?value.status!=='observed'||typeof q.stdout_base64!=='string':q.stdout_base64!==null))throw Error('Private response refused');
            if(value.status==='observed'&&(value.observation.connection_id!==request.connection_id||value.observation.boot_id!==request.boot_id))throw Error('Private identity refused');
            return resolve(value);
          }
          if (forget) {
            if (Object.keys(value).sort().join() !== 'contract_version,forget_raw,observation,status') throw Error('Private response refused');
            validateResult({ contract_version:value.contract_version,status:value.status,observation:value.observation });
            const q=value.forget_raw;
            if (!q || Object.keys(q).sort().join() !== 'status,stdout_base64' || !['reported','unsupported','unavailable'].includes(q.status) || (q.status==='reported' ? value.status!=='observed' || typeof q.stdout_base64!=='string' : q.stdout_base64!==null)) throw Error('Private response refused');
            if (value.status==='observed' && (value.observation.connection_id!==request.connection_id || value.observation.boot_id!==request.boot_id)) throw Error('Private identity refused');
            return resolve(value);
          }
          if (detail) {
            const reduced = await reduceMemoryInspectionResult(value, request, validateResult);
            return resolve(generation === this.generation ? reduced : refusal('cancelled'));
          }
          if (saved) return resolve(reduceSavedModeResult(value, request, validateResult));
          if (memory) {
            try { return resolve(parseMemoryResult(value, request, validateResult)); }
            catch (error) {
              if (error.message === 'Memory query report version unsupported' && value.status === 'observed') {
                value.memory_query = { status: 'unsupported', report: null };
                return resolve(parseMemoryResult(value, request, validateResult));
              }
              throw error;
            }
          }
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
