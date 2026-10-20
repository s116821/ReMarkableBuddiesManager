export interface SavedModeRequest { connection_id: string; boot_id: string }
export interface SavedModeSnapshot { kind: 'unconfigured' | 'local-only' | 'isolated-backup' | 'shared-group'; device: string | null; epoch: string | null; group: string | null; backup: string | null }
export interface SavedModeView { status: 'ok' | 'invalid-input' | 'unsupported' | 'unavailable' | 'busy' | 'conflict' | 'failed'; incomplete: boolean; snapshot: SavedModeSnapshot | null }
export const parseSavedModeRequest: (v: unknown) => SavedModeRequest;
export const parseSavedModeReport: (v: unknown) => SavedModeView;
export const parseSavedModeView: (v: unknown) => SavedModeView;
export const parseSavedModeResult: (v: unknown, request: SavedModeRequest, validateObservation: (v: unknown) => unknown) => unknown;
export const reduceSavedModeResult: (v: unknown, request: SavedModeRequest, validateObservation: (v: unknown) => unknown) => unknown;
