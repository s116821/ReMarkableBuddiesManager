// Renderer boundary: no OAuth parameters, tablet binding, or credential bytes.
export const CAPACITIES_ACTIONS = Object.freeze(['status', 'begin', 'cancel', 'reconcile']);
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
