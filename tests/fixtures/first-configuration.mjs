import {tablet as observedTablet} from './owned-report.mjs';

export const tablet = Object.freeze({...observedTablet, service: Object.freeze({...observedTablet.service})});
export const target = ({connection_id, boot_id} = tablet) => ({connection_id, boot_id});
export const invocation = count => '00000000-0000-4000-8000-' + String(count).padStart(12, '0');
export const producer = (operation, state) => ({operation, report_version: 1, state});
export const noDispatch = {dispatch: 'not-dispatched', observation: null, report: null, executable_sha256: null};

export function firstConfigurationFixture(observer = {lastObservation: structuredClone(tablet)}) {
  const state = {available: true, existing: false, executable: 'd'.repeat(64), exists: false, lost: false, calls: [], hold: null};
  const admit = function (sample) {
    if (state.existing) return null;
    if (!state.available) return {};
    return {target: structuredClone(sample), package_sha256: 'c'.repeat(64),
      quiescence_id: invocation(9), configuration_protocol: 1};
  };
  const run = async function (request, owner) {
    if (!owner.current() || owner.signal.aborted) return noDispatch;
    state.calls.push({request, signal: owner.signal});
    const sample = structuredClone(this.lastObservation);
    if (state.hold) await state.hold.promise;
    const create = request.selector.startsWith('create-');
    const existing = request.selector.endsWith('existing-default');
    if (existing && create && request.expected_executable_sha256 !== state.executable) return noDispatch;
    const outcome = state.exists ? 'present' : create ? 'created' : 'missing';
    if (create) state.exists = true;
    return {dispatch: 'possible', observation: sample, report: state.lost ? null : producer(request.selector, outcome), executable_sha256: existing ? state.executable : null};
  };
  Object.assign(observer, {firstConfigurationAdmission: admit, runFirstConfiguration: run});
  return {observer, state};
}

export function personalizationAfterFirstSave(state, observation, request) {
  if (!state.exists) throw Error('The fixture has no saved configuration');
  const digest = 'c'.repeat(64);
  const isRead = request.operation === 'inspect';
  if (!isRead && request.expected_config_sha256 !== digest) throw Error('Saved revision required');
  if (request.operation === 'set') state.preference = {schema_version: 1, enabled: request.enabled, text: request.text};
  return {
    contract_version: 1, status: 'observed', observation,
    personalization: {status: 'reported', outcome: isRead ? 'read-only' : 'verified', report: {
      report_version: 1, operation: request.operation, status: 'ok', disk_reload_verified: true,
      runtime_activation: isRead ? 'unverified' : 'restart-required', config_sha256: digest,
      personalization: state.preference ?? {schema_version: 1, enabled: false, text: ''},
    }},
  };
}
