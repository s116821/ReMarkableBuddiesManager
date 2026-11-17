// Renderer boundary: no OAuth parameters, tablet binding, or credential bytes.
export const CAPACITIES_ACTIONS = Object.freeze(['status', 'begin', 'cancel', 'reconcile']);
export const CAPACITIES_CONNECTION_ACTIONS = Object.freeze(['inspect-connection', 'disconnect']);
const connectionStates = new Set(['busy', 'unavailable', 'no-connection', 'active', 'local-disabled',
  'revoked', 'revocation-pending', 'reconcile-required', 'not-dispatched', 'selection-changed']);

export function validCapacitiesConnectionRef(value) {
  return typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value);
}

export function parseCapacitiesConnectionState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== 'connectionRef,contract_version,status'
      || value.contract_version !== 1 || !connectionStates.has(value.status)
      || (value.status === 'active' ? !validCapacitiesConnectionRef(value.connectionRef) : value.connectionRef !== null)) {
    throw Error('Capacities connection refused');
  }
  return Object.freeze({contract_version: 1, status: value.status, connectionRef: value.connectionRef});
}

const states = new Set(['unconfigured', 'disconnected', 'starting', 'awaiting-consent',
  'handing-off', 'connected', 'canceled', 'expired', 'denied', 'authorization-failed',
  'selection-changed', 'not-dispatched', 'staged', 'reconcile-required', 'unavailable']);

export function parseCapacitiesState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== 'contract_version,status'
      || value.contract_version !== 1 || !states.has(value.status)) {
    throw Error('Capacities state refused');
  }
  return Object.freeze({contract_version: 1, status: value.status});
}

export function parseCapacitiesAction(value) {
  if (typeof value !== 'string' || !CAPACITIES_ACTIONS.includes(value)) {
    throw Error('Capacities action refused');
  }
  return value;
}
