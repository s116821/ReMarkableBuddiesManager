import type { MemoryAdapter, MemoryResult } from './memory-query';
import type { DownloadAdapter } from './manager-downloads';
import type { RuntimeAdapter, RuntimeResult } from './runtime-identity';
import type { PersonalizationRequest } from '../host/personalization.mjs';
import type { PersonalizationAdapter, PersonalizationResult } from './personalization';
import type { DriveAdapter } from './drive-auth';
import { parseDriveState, parseDriveBegin, unavailableDrive } from '../host/drive-protocol.mjs';
import type { InspectionAdapter, InspectionResult } from './owned-data';
import type { ObservationAdapter, ObservationResult } from './observation';
export interface ManagerHost extends ObservationAdapter, InspectionAdapter {
  readonly memoryQuery?: MemoryAdapter['memoryQuery'];
  readonly downloads?: DownloadAdapter;
  readonly driveAuth?: DriveAdapter;
  readonly inspectRuntime?: RuntimeAdapter['inspectRuntime'];
  readonly personalization?: PersonalizationAdapter['personalization'];
  readonly contract_version: 1;
  readonly kind: 'browser' | 'desktop';
  readonly transport: 'not-configured' | 'wired-maintenance';
}
declare global { interface Window { managerHost?: ManagerHost } }
async function helper(action: 'observe' | 'cancel' | 'inspect-owned' | 'inspect-runtime'): Promise<ObservationResult | InspectionResult | RuntimeResult> {
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
  return window.managerHost ?? Object.freeze({ downloads: { request: async (q: import('../host/manager-download-protocol.mjs').DownloadRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Download host unavailable');
      const response = await fetch('/manager-download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q), signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.body) throw new Error('Download host unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > 2048) throw new Error('Download response refused'); chunks.push(result.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } }, driveAuth: browserDrive, contract_version: 1 as const, kind: 'browser' as const, transport: 'not-configured' as const,
    memoryQuery: async (request: import('../host/memory-query.mjs').MemoryRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Memory query helper unavailable');
      const response = await fetch('/manager-memory-query', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok || !response.body) throw new Error('Memory query unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.byteLength; if (bytes > 139264) throw new Error('Memory query response refused'); chunks.push(value.value); } } finally { await reader.cancel().catch(() => {}); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as MemoryResult;
    },
    personalization: async (request: PersonalizationRequest) => {
      if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') throw new Error('Personalization helper unavailable');
      const response = await fetch('/manager-personalization', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(14000) });
      if (!response.ok) throw new Error('Personalization unavailable');
      return await response.json() as PersonalizationResult;
    },
    inspectRuntime: () => helper('inspect-runtime') as Promise<RuntimeResult>,
    inspectOwned: () => helper('inspect-owned') as Promise<InspectionResult>,
    observe: () => helper('observe') as Promise<ObservationResult>, cancel: () => helper('cancel') as Promise<ObservationResult> });
}
