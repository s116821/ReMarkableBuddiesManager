export type CapacitiesAction = 'status' | 'begin' | 'cancel' | 'reconcile';
export type CapacitiesStatus = 'unconfigured' | 'disconnected' | 'starting' | 'awaiting-consent' |
  'handing-off' | 'connected' | 'canceled' | 'expired' | 'denied' | 'authorization-failed' |
  'selection-changed' | 'not-dispatched' | 'staged' | 'reconcile-required' | 'unavailable';
export interface CapacitiesState { readonly contract_version: 1; readonly status: CapacitiesStatus }
export const CAPACITIES_ACTIONS: readonly CapacitiesAction[];
export function parseCapacitiesState(value: unknown): CapacitiesState;
export function parseCapacitiesAction(value: unknown): CapacitiesAction;
