import {tablet as observedTablet} from './owned-report.mjs';

export const tablet = Object.freeze({...observedTablet, service: Object.freeze({...observedTablet.service})});
export const target = ({connection_id, boot_id} = tablet) => ({connection_id, boot_id});
export const invocation = count => '00000000-0000-4000-8000-' + String(count).padStart(12, '0');
export const producer = (operation, state) => ({operation, report_version: 1, state});
export const noDispatch = {dispatch: 'not-dispatched', observation: null, report: null};

export function firstConfigurationFixture(observer = {lastObservation: structuredClone(tablet)}) {
  const state = {available: true, exists: false, lost: false, calls: [], hold: null};
  const admit = function (sample) {
    if (!state.available) return null;
    return {target: structuredClone(sample), package_sha256: 'c'.repeat(64),
      quiescence_id: invocation(9), configuration_protocol: 1};
  };
  const run = async function (request, owner) {
    if (!owner.current() || owner.signal.aborted) return noDispatch;
    state.calls.push({request, signal: owner.signal});
    const sample = structuredClone(this.lastObservation);
    if (state.hold) await state.hold.promise;
    const create = request.selector === 'create-initial';
    const outcome = state.exists ? 'present' : create ? 'created' : 'missing';
    if (create) state.exists = true;
    return {dispatch: 'possible', observation: sample, report: state.lost ? null : producer(request.selector, outcome)};
  };
  Object.assign(observer, {firstConfigurationAdmission: admit, runFirstConfiguration: run});
  return {observer, state};
}
