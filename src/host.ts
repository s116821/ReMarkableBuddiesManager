import type { PersonalizationRequest } from '../host/personalization.mjs';
import type { PersonalizationAdapter, PersonalizationResult } from './personalization';
import type { DriveAdapter } from './drive-auth';
import { parseDriveState, parseDriveBegin, unavailableDrive } from '../host/drive-protocol.mjs';
import type { InspectionAdapter, InspectionResult } from './owned-data';
import type { ObservationAdapter, ObservationResult } from './observation';
export interface ManagerHost extends ObservationAdapter, InspectionAdapter {
  readonly driveAuth?: DriveAdapter;
  readonly personalization?: PersonalizationAdapter['personalization'];
  readonly contract_version: 1;
  readonly kind: 'browser' | 'desktop';
  readonly transport: 'not-configured' | 'wired-maintenance';
}
declare global { interface Window { managerHost?: ManagerHost } }
async function helper(action: 'observe' | 'cancel' | 'inspect-owned'): Promise<ObservationResult | InspectionResult> {
  if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') return { contract_version: 1, status: 'unconfigured', observation: null };
  try {
    const response = await fetch('/manager-host', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(14000) });
    if (!response.ok) throw new Error('Helper unavailable');
    return await response.json() as ObservationResult;
  } catch { return { contract_version: 1, status: 'unconfigured', observation: null }; }
}
async function driveHelper(action: string, authorizationId?: string) {
  if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Drive helper unavailable');
  const response = await fetch('/manager-drive', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'revoke' ? { action, authorizationId } : { action }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Drive helper unavailable');
  const value: unknown = await response.json(); return action === 'begin' ? parseDriveBegin(value) : parseDriveState(value);
}
const browserDrive: DriveAdapter = {
  status: () => driveHelper('status') as ReturnType<DriveAdapter['status']>, begin: () => driveHelper('begin') as ReturnType<DriveAdapter['begin']>,
  check: () => driveHelper('check') as ReturnType<DriveAdapter['check']>, cancel: () => driveHelper('cancel') as ReturnType<DriveAdapter['cancel']>,
  disconnect: () => driveHelper('disconnect') as ReturnType<DriveAdapter['disconnect']>, revoke: id => driveHelper('revoke', id) as ReturnType<DriveAdapter['revoke']>,
};
export const unsupportedDrive: DriveAdapter = { status: async () => unavailableDrive(), begin: async () => ({ state: unavailableDrive(), authorizationUrl: null }),
  check: async () => unavailableDrive(), cancel: async () => unavailableDrive(), disconnect: async () => unavailableDrive(), revoke: async () => unavailableDrive() };
export function currentHost(): ManagerHost {
  return window.managerHost ?? Object.freeze({ driveAuth: browserDrive, contract_version: 1 as const, kind: 'browser' as const, transport: 'not-configured' as const,
    personalization: async (request: PersonalizationRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Personalization helper unavailable');
      const response = await fetch('/manager-personalization', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok) throw new Error('Personalization unavailable');
      return await response.json() as PersonalizationResult;
    },
    inspectOwned: () => helper('inspect-owned') as Promise<InspectionResult>,
    observe: () => helper('observe') as Promise<ObservationResult>, cancel: () => helper('cancel') as Promise<ObservationResult> });
}
