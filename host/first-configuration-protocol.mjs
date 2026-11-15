export const FIRST_CONFIG_REQUEST_BYTES = 512;
export const FIRST_CONFIG_RESULT_BYTES = 8192;
const keys = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).sort().join() : '';
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const digest = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
export const uuid = value => typeof value === 'string' && value.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
export const sameTarget = (a, b) => !!a && !!b && a.connection_id === b.connection_id && a.boot_id === b.boot_id;

const currentStates = ['missing', 'present', 'blocked'];
const originalStates = ['created', 'present', 'blocked', 'unknown'];
const fail = () => { throw Error('First configuration frame refused'); };

export function parseFirstConfigRequest(value) {
  const fields = keys(value);
  if (bytes(value ?? null) > FIRST_CONFIG_REQUEST_BYTES) fail();
  if (value?.action === 'retained' && fields === 'action') return value;
  if (!digest(value?.connection_id) || !uuid(value?.boot_id)) fail();
  if (['review', 'check'].includes(value.action) && fields === 'action,boot_id,connection_id,invocation' &&
      uuid(value.invocation)) return value;
  if (fields !== 'action,boot_id,connection_id,invocation,reference') fail();
  if (value.action === 'create' && digest(value.reference) && uuid(value.invocation)) return value;
  if (value.action === 'cancel' && (value.reference === null || digest(value.reference)) &&
      (value.invocation === null ? digest(value.reference) : uuid(value.invocation))) return value;
  return fail();
}

export function parseFirstConfigResult(value, request) {
  if (keys(value) !== 'current,invocation,reference,retained,state,version' || value.version !== 1 ||
      value.invocation !== (request.invocation ?? null) ||
      !Array.isArray(value.retained) || value.retained.length > 8 ||
      bytes(value) > FIRST_CONFIG_RESULT_BYTES) fail();
  const {reference, current, state, retained} = value;
  const common = ['unavailable', 'busy', 'invalidated', 'capacity'];
  if (request.action === 'retained') {
    if (state !== 'none' || current !== null || reference !== null) fail();
  } else if (request.action === 'review' || request.action === 'check') {
    if (state === 'ready') {
      if (request.action !== 'review' || current !== 'missing' || !digest(reference)) fail();
    } else {
      if (reference !== null || !(common.includes(state) || ['checked', 'unknown'].includes(state))) fail();
      if (state === 'checked' ? !currentStates.includes(current) : current !== null) fail();
    }
  } else if (reference !== request.reference ||
      !(common.includes(state) || originalStates.includes(state)) || current !== null) fail();
  const references = new Set();
  for (const row of retained) {
    if (keys(row) !== 'boot_id,connection_id,outcome,reference' ||
        !digest(row.connection_id) || !uuid(row.boot_id) || !digest(row.reference) ||
        !originalStates.includes(row.outcome) || references.has(row.reference)) fail();
    references.add(row.reference);
  }
  return value;
}

export function parseFirstConfigProducerReport(value, selector) {
  if (keys(value) !== 'operation,report_version,state' || value.report_version !== 1 ||
      value.operation !== selector ||
      !(selector === 'check-initial' ? currentStates : originalStates).includes(value.state)) fail();
  return value.state;
}
