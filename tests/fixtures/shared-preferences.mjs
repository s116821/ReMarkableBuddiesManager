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
const frame = (selector, status, disposition, fields = {}) => ({
  report_version: 1, operation: selector, status, disposition, runtime_activation: 'unverified', ...fields
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
      if (outcome === 'invalid-input') return reported(frame(selector, 'invalid-input', 'not-dispatched'));
      if (outcome === 'joining') return reported(frame(selector, 'joining', 'not-admitted'));
      if (selector === 'inspect') {
        if (outcome === 'busy' || outcome === 'command-unsupported') {
          return reported(frame(selector, outcome === 'busy' ? 'busy' : 'unsupported', 'not-dispatched'));
        }
        const effective = {reader_enabled: true, writer_enabled: true, export_destination: 'mem',
          personalization_enabled: true, personalization_text_present: true,
          research_policy: 'required', origins};
        if (body.reveal_text || outcome === 'leaked-prompt') effective.personalization_text = privateText;
        const condition = outcome === 'selected' ? {...guard, selection: {
          kind: 'selected', aggregate_generation: uuid(5), accepted_base_sha256: 'd'.repeat(64),
          selection_sha256: 'e'.repeat(64), revision: uuid(6)
        }} : guard;
        return reported(frame(selector, 'ok', 'read-only', {guard: condition, view: effective}));
      }
      const original = {original_operation: body.operation, guard: body.guard,
        patch_sha256: selector === 'edit' ? digest(body.patch) : body.patch_sha256};
      if (outcome === 'busy' || outcome === 'conflict') return reported(frame(selector, outcome, 'not-dispatched', original));
      if (outcome === 'unknown') return reported(frame(selector, 'unavailable', 'unknown', original));
      if (outcome === 'lost') throw Error('Fixture lost output');
      if (outcome === 'hold') await new Promise(resolve => { held = resolve; });
      if (outcome === 'substituted') original.original_operation = uuid(98);
      if (outcome === 'substituted-guard') original.guard = {...original.guard, store_generation: uuid(98)};
      if (outcome === 'substituted-patch') original.patch_sha256 = 'f'.repeat(64);
      const disposition = outcome === 'no-change' || outcome === 'applied' ? outcome : 'local-committed';
      return reported(frame(selector, 'ok', disposition, original));
    }
  };
  return {calls, observer, set: state => { outcome = state; }, cancelCount: () => cancelled, release: () => held?.()};
}

export {target, patch, privateText};
