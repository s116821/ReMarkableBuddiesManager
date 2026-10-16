export interface DriveState {
  contract_version: 1;
  status: 'unconfigured' | 'disconnected' | 'connecting' | 'cached' | 'connected' | 'checking' | 'cancelled' | 'expired' | 'denied' | 'authorization-failed' | 'unavailable' | 'revoking' | 'revocation-unconfirmed';
  account: { label: string } | null;
  checkedAt: string | null;
  authorizationId: string | null;
  error: string | null;
  backupReady: false;
}
export interface DriveBegin { state: DriveState; authorizationUrl: string | null }
export const DRIVE_STATUSES: readonly string[];
export const DRIVE_ACTIONS: readonly string[];
export function parseDriveState(v: unknown): DriveState;
export function parseDriveBegin(v: unknown): DriveBegin;
export function unavailableDrive(): DriveState;
