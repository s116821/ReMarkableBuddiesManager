import {strictJson} from './strict-json.mjs';
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
    const research=action==='research-settings';
    const management=action==='conversation-management';
    const cacheCleanup=action==='source-cache-cleanup';
    const conversation=action==='conversation-inventory';
    const cachePrivate=cacheCleanup||action==='source-cache-inventory'||conversation||management;
    const modelCredential=action==='model-credential';
    const credential=action==='credential-reference';
    const memorySettings=action==='memory-settings';
    const archive=action==='ordinary-export';
    const model = action === 'model-settings';
    const basic = action === 'basic-settings';
    const configuration = action === 'saved-configuration';
    const forget = action === 'memory-forget', detail = action === 'memory-inspection', saved = action === 'saved-mode', memory = action === 'memory-query', personal = action === 'personalization', runtime = action === 'runtime-identity';
    let launched = false;
    const refusal = status => cachePrivate ? {...result(status),[management?'conversation_management_raw':conversation?'conversation_inventory_raw':cacheCleanup?'source_cache_cleanup_raw':'source_cache_inventory_raw']:{status:'unavailable',stdout_base64:null}} : modelCredential ? {...result(status),model_credential_raw:{status:'unavailable',stdout_base64:null}} : credential ? {...result(status),credential_reference_raw:{status:'unavailable',stdout_base64:null}} : memorySettings ? {...result(status),memory_settings_raw:{status:'unavailable',stdout_base64:null}} : research ? {...result(status),research_settings_raw:{status:'unavailable',stdout_base64:null}} : archive ? {...result(status),export_raw:{status:'unavailable',stdout_base64:null}} : model ? {...result(status),model_raw:{status:'unavailable',stdout_base64:null}} : basic ? {...result(status),basic_raw:{status:'unavailable',stdout_base64:null}} : configuration ? {...result(status),saved_configuration:{status:'unavailable',view:null}} : forget ? { ...result(status), forget_raw: { status:'unavailable', stdout_base64:null } } : detail ? { ...result(status), memory_inspection: { status: 'unavailable', view: null } } : saved ? { ...result(status), saved_mode: { status: 'unavailable', view: null } } : memory ? { ...result(status), memory_query: { status: 'unavailable', report: null } } : runtime ? { ...result(status), runtime_identity: null } : personal ? { ...result(status), personalization: { status: 'unavailable', report: null, outcome: request.operation === 'inspect' ? 'read-only' : launched ? 'unknown' : 'not-dispatched' } } : action === 'observe' ? result(status) : { ...result(status), inspection: null };
    if((basic||model||archive||research||memorySettings||credential||modelCredential||cachePrivate)&&(!Number.isSafeInteger(request?.budget_ms)||request.budget_ms<1||request.budget_ms>12000))return refusal('observation-unavailable');
    if (!['linux', 'win32'].includes(this.platform)) return refusal('unsupported-host');
    if (!this.config || !this.python || !path.isAbsolute(this.config) || !path.isAbsolute(this.python)) return refusal('unconfigured');
    const generation = this.generation;
    return new Promise(resolve => {
      const script = cachePrivate ? path.join(path.dirname(this.script),management?'conversation_management_transport.py':conversation?'conversation_inventory_transport.py':cacheCleanup?'source_cache_cleanup_transport.py':'source_cache_inventory_transport.py') : modelCredential ? path.join(path.dirname(this.script),'model_credential_transport.py') : credential ? path.join(path.dirname(this.script),'credential_reference_transport.py') : memorySettings ? path.join(path.dirname(this.script),'memory_settings_transport.py') : research ? path.join(path.dirname(this.script),'research_settings_transport.py') : archive ? path.join(path.dirname(this.script), 'ordinary_export_transport.py') : model ? path.join(path.dirname(this.script), 'model_settings_transport.py') : basic ? path.join(path.dirname(this.script), 'basic_settings_transport.py') : configuration ? path.join(path.dirname(this.script), 'saved_configuration_transport.py') : forget ? path.join(path.dirname(this.script), 'memory_forget_transport.py') : detail ? path.join(path.dirname(this.script), 'memory_inspection_transport.py') : saved ? path.join(path.dirname(this.script), 'saved_mode_transport.py') : memory ? path.join(path.dirname(this.script), 'memory_query_transport.py') : runtime ? path.join(path.dirname(this.script), 'runtime_identity_transport.py') : personal ? path.join(path.dirname(this.script), 'personalization_transport.py') : this.script;
      const child = spawn(this.python, [script, ...(personal || runtime || memory || saved || detail || forget || configuration || basic || model || archive || research || memorySettings || credential || modelCredential || cachePrivate || action === 'observe' ? [] : [action])], { stdio: [personal || runtime || memory || saved || detail || forget || configuration || basic || model || archive || research || memorySettings || credential || modelCredential || cachePrivate ? 'pipe' : 'ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', MANAGER_WIRED_CONFIG: this.config } });
      this.active = child;
      child.once('spawn', () => { launched = true; });
      if (personal || runtime || memory || saved || detail || forget || configuration || basic || model || archive || research || memorySettings || credential || modelCredential || cachePrivate) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request)); }
      const chunks = []; let outputBytes = 0, expired = false, oversized = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, (basic||model||archive||research||memorySettings||credential||modelCredential||cachePrivate)?Math.min(this.timeoutMs,request.budget_ms):this.timeoutMs);
      child.stdout.on('data', data => {
        if((modelCredential||cachePrivate)&&(oversized||expired||generation!==this.generation||outputBytes+data.length>(management?49152:cachePrivate&&!cacheCleanup?16384:24576))){data.fill(0);oversized=true;child.kill('SIGKILL');return;}
        chunks.push(data); outputBytes += data.length;
        if (outputBytes > (management ? 49152 : cachePrivate&&!cacheCleanup ? 16384 : basic || model || archive || research || memorySettings || credential || modelCredential || cachePrivate ? 24576 : configuration ? 139264 : forget ? 360448 : detail ? 278528 : saved ? 32768 : personal || memory ? 139264 : runtime || action === 'observe' ? 8192 : 49152)) { oversized = true; child.kill('SIGKILL'); }
      });
      const finish = async code => {
        clearTimeout(timer);
        if (this.active === child) this.active = null;
        try {
        if (generation !== this.generation) return resolve(refusal('cancelled'));
        if (expired) return resolve(refusal('timeout'));
        if (code !== 0 || oversized) return resolve(refusal('observation-unavailable'));
          const input=Buffer.concat(chunks);let value;try{if(modelCredential||cachePrivate)strictJson(input);value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input));}finally{if(modelCredential||cachePrivate)input.fill(0);}
          if (action === 'observe') return resolve(validateResult(value));
          if (configuration) {
            const reduced=reduceSavedConfigurationResult(value,request,validateResult);
            return resolve(generation===this.generation?reduced:refusal('cancelled'));
          }
          if (basic || model || archive || research || memorySettings || credential || modelCredential || cachePrivate) {
            const rawKey=cachePrivate?(management?'conversation_management_raw':conversation?'conversation_inventory_raw':cacheCleanup?'source_cache_cleanup_raw':'source_cache_inventory_raw'):modelCredential?'model_credential_raw':credential?'credential_reference_raw':memorySettings?'memory_settings_raw':research?'research_settings_raw':archive?'export_raw':model?'model_raw':'basic_raw',wanted=cachePrivate?(management?'contract_version,conversation_management_raw,observation,status':conversation?'contract_version,conversation_inventory_raw,observation,status':cacheCleanup?'contract_version,observation,source_cache_cleanup_raw,status':'contract_version,observation,source_cache_inventory_raw,status'):modelCredential?'contract_version,model_credential_raw,observation,status':credential?'contract_version,credential_reference_raw,observation,status':memorySettings?'contract_version,memory_settings_raw,observation,status':research?'contract_version,observation,research_settings_raw,status':archive?'contract_version,export_raw,observation,status':model?'contract_version,model_raw,observation,status':'basic_raw,contract_version,observation,status';
            if(Object.keys(value).sort().join()!==wanted)throw Error('Private response refused');
            validateResult({contract_version:value.contract_version,status:value.status,observation:value.observation});
            const q=value[rawKey];if(!q||Object.keys(q).sort().join()!=='status,stdout_base64'||!['reported','unsupported','unavailable'].includes(q.status)||(q.status==='reported'?value.status!=='observed'||typeof q.stdout_base64!=='string':q.stdout_base64!==null))throw Error('Private response refused');
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
        } catch { resolve(refusal('observation-unavailable')); }finally{if(modelCredential||cachePrivate){for(const chunk of chunks)chunk.fill(0);chunks.length=0;}}
      };
      child.once('error', () => finish(-1));
      child.once('close', finish);
    });
  }
}
