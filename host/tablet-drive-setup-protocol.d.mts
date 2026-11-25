import type {ObservationResult} from '../src/observation';
export type TabletDriveIdentity = {connection_id: string; boot_id: string};
export type TabletDriveSetupRequest = {action: 'retained'} | {action: 'cancel'; reference: string} |
  ({action: 'begin'; intent: 'connect' | 'remove'} & TabletDriveIdentity) |
  ({action: 'poll' | 'confirm' | 'check'; reference: string} & TabletDriveIdentity);
export type TabletDriveSetupState = 'none' | 'authorizing' | 'ready' | 'verified' | 'observed' | 'unchanged' |
  'unknown' | 'unresolved' | 'cancelled' | 'unavailable' | 'busy' | 'refused' | 'expired' | 'capacity' | 'unsupported' | 'invalidated' | 'recovery-required';
export type TabletDriveRetained = TabletDriveIdentity & {reference: string; status_available: boolean};
export interface TabletDriveSetupView {
  state: TabletDriveSetupState; reference: string | null; intent: 'connect' | 'remove' | null;
  account: {label: string} | null; installed: boolean | null; mode: 'local-only' | 'isolated-backup' | null;
  authorizationUrl: string | null; retained: TabletDriveRetained[];
}
export interface TabletDriveSetupResult extends ObservationResult {tablet_drive: TabletDriveSetupView}
export function parseTabletDriveSetupRequest(value: unknown): TabletDriveSetupRequest;
export function parseTabletDriveSetupResult(value: unknown, request: TabletDriveSetupRequest): TabletDriveSetupResult;
