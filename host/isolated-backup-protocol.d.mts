export const ISOLATED_BACKUP_REQUEST_BYTES: number;
export const ISOLATED_BACKUP_RESPONSE_BYTES: number;
export type IsolatedBackupRequest =
  | {version: 1; action: 'scan'}
  | {version: 1; action: 'select'; inspection: string; choice: string}
  | {version: 1; action: 'status' | 'cancel'; operation: string};
export type IsolatedBackupStatus = 'scanning' | 'selecting' | 'observed' | 'empty' | 'selected' |
  'unqualified' | 'unavailable' | 'invalid' | 'incomplete' | 'invalidated' | 'unsupported' | 'busy';
export interface IsolatedBackupRevision {
  reference: string;
  sha256: string;
  predecessorReference: string | null;
  newestObserved: boolean;
}
export interface IsolatedBackupSummary {backup: string; device: string; revisions: IsolatedBackupRevision[]}
export interface IsolatedBackupSelection {reference: string; backup: string; device: string; sha256: string}
export interface IsolatedBackupResult {
  version: 1;
  operation: string | null;
  status: IsolatedBackupStatus;
  backups: IsolatedBackupSummary[];
  selection: IsolatedBackupSelection | null;
}
export function parseIsolatedBackupJson(input: Uint8Array, limit: number): unknown;
export function parseIsolatedBackupRequest(value: unknown): IsolatedBackupRequest;
export function parseIsolatedBackupResult(value: unknown, request?: IsolatedBackupRequest): IsolatedBackupResult;
