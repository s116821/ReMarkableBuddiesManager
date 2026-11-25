export type CapacitiesConnectionAction = 'inspect-connection' | 'disconnect';
export type CapacitiesConnectionStatus = 'busy' | 'unavailable' | 'no-connection' | 'active' |
  'local-disabled' | 'revoked' | 'revocation-pending' | 'reconcile-required' | 'not-dispatched' | 'selection-changed';
export interface CapacitiesConnectionState {
  readonly contract_version: 1;
  readonly status: CapacitiesConnectionStatus;
  readonly connectionRef: string | null;
}
export const CAPACITIES_CONNECTION_ACTIONS: readonly CapacitiesConnectionAction[];
export function validCapacitiesConnectionRef(value: unknown): value is string;
export function parseCapacitiesConnectionState(value: unknown): CapacitiesConnectionState;
export type CapacitiesAction = 'status' | 'begin' | 'cancel' | 'reconcile';
export type CapacitiesStatus = 'unconfigured' | 'disconnected' | 'starting' | 'awaiting-consent' |
  'handing-off' | 'connected' | 'canceled' | 'expired' | 'denied' | 'authorization-failed' |
  'selection-changed' | 'not-dispatched' | 'staged' | 'reconcile-required' | 'unavailable';
export interface CapacitiesState { readonly contract_version: 1; readonly status: CapacitiesStatus }
export const CAPACITIES_ACTIONS: readonly CapacitiesAction[];
export function parseCapacitiesState(value: unknown): CapacitiesState;
export function parseCapacitiesAction(value: unknown): CapacitiesAction;
