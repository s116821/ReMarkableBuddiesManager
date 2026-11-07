import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {portableCanonical} from '../../host/portable-configuration-protocol.mjs';

const uuid = value => `11111111-1111-4111-8111-${String(value).padStart(12, '0')}`;
const target = {connection_id: 'a'.repeat(64), boot_id: uuid(1)};
const observation = {...target, architecture: 'armv7l', firmware: '3.20', firmware_conflict: false,
  installed_version: null, model: 'reMarkable 2', provenance: 'unknown',
  service: {ActiveState: 'inactive', LoadState: 'loaded', SubState: 'dead'}};
const guard = {group: uuid(2), mode_epoch: uuid(3), store_generation: uuid(4),
  binding_sha256: 'b'.repeat(64), local_config_sha256: 'c'.repeat(64), selection: {kind: 'absent'}};
const privateText = 'Fixture private prompt β\n';
const patch = {portable_configuration_version: 1, settings: {
  product_settings: {writer_enabled: true}, research_policy: null, personalization: {text: privateText}
}};
const origins = Object.fromEntries([
  'reader_enabled', 'writer_enabled', 'export_destination', 'personalization_enabled',
  'personalization_text', 'research_policy'
].map(key => [key, 'local']));
const digest = value => createHash('sha256').update(portableCanonical(value)).digest('hex');
const frame = (selector, status, data = null) => ({
  report_version: 1, operation: selector, status, runtime_activation: 'unverified', data
});

export function fixture() {
  const calls = [];
  let outcome = 'unsupported', held, cancelled = 0;
  const observer = {
    lastObservation: observation,
    async observe() { return {contract_version: 1, status: 'observed', observation}; },
    cancel() { cancelled++; },
    async run(action, {selector, input_base64}) {
      assert.equal(action, 'shared-preferences');
      const body = JSON.parse(Buffer.from(input_base64, 'base64'));
      calls.push({selector, body});
      const reported = report => ({contract_version: 1, status: 'observed', observation,
        portable_configuration_raw: {status: 'reported',
          stdout_base64: Buffer.from(JSON.stringify(report) + '\n').toString('base64')}});
      if (outcome === 'unsupported') return {contract_version: 1, status: 'observed', observation,
        portable_configuration_raw: {status: 'unsupported', stdout_base64: null}};
      if (outcome === 'busy') return reported(frame(selector, 'busy'));
      if (selector === 'inspect') {
        const effective = {reader_enabled: true, writer_enabled: true, export_destination: 'mem',
          personalization_enabled: true, personalization_text_present: true,
          personalization_text: body.reveal_text ? privateText : null, research_policy: 'required', origins};
        return reported(frame(selector, 'ok', {disposition: 'established-absent', guard, effective}));
      }
      const original = {operation: body.operation, guard: body.guard,
        patch_sha256: selector === 'edit' ? digest(body.patch) : body.patch_sha256};
      if (outcome === 'conflict') return reported(frame(selector, 'conflict'));
      if (outcome === 'lost') throw Error('Fixture lost output');
      if (outcome === 'hold') await new Promise(resolve => { held = resolve; });
      if (outcome === 'substituted') original.operation = uuid(98);
      return reported(frame(selector, 'ok', {original, outcome: selector === 'edit' ? 'local-selected' : 'applied'}));
    }
  };
  return {calls, observer, set: state => { outcome = state; }, cancelCount: () => cancelled, release: () => held?.()};
}

export {target, guard, patch, privateText, digest};
