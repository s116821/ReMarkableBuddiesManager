import type { ObservationAdapter, ObservationResult } from './observation';
export interface ManagerHost extends ObservationAdapter {
  readonly contract_version: 1;
  readonly kind: 'browser' | 'desktop';
  readonly transport: 'not-configured' | 'wired-read-only';
}
declare global { interface Window { managerHost?: ManagerHost } }
async function helper(action: 'observe' | 'cancel'): Promise<ObservationResult> {
  if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:') return { contract_version: 1, status: 'unconfigured', observation: null };
  try {
    const response = await fetch('/manager-host', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(14000) });
    if (!response.ok) throw new Error('Helper unavailable');
    return await response.json() as ObservationResult;
  } catch { return { contract_version: 1, status: 'unconfigured', observation: null }; }
}
export function currentHost(): ManagerHost {
  return window.managerHost ?? Object.freeze({ contract_version: 1 as const, kind: 'browser' as const, transport: 'not-configured' as const,
    observe: () => helper('observe'), cancel: () => helper('cancel') });
}
