import type {PortableResult} from './portable-configuration-protocol.mjs';
import type {RestoreResult} from './ordinary-restore-protocol.mjs';

export const ISOLATED_BACKUP_REQUEST_BYTES: number;
export const ISOLATED_BACKUP_RESPONSE_BYTES: number;
export const BACKUP_PREFERENCES_RESPONSE_BYTES: number;
export type IsolatedBackupRequest =
  | {version: 1; action: 'scan'}
  | {version: 1; action: 'select'; inspection: string; choice: string}
  | {version: 1; action: 'download'; operation: string; reference: string}
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
export interface IsolatedBackupBrowseResult {
  version: 1;
  operation: string | null;
  status: IsolatedBackupStatus;
  backups: IsolatedBackupSummary[];
  selection: IsolatedBackupSelection | null;
}
export type IsolatedBackupDownloadStatus = 'downloading' | 'verified' | 'unavailable' | 'invalid' | 'incomplete' |
  'invalidated' | 'insufficient-space' | 'verification-failed' | 'busy';
export interface IsolatedBackupInspection {
  markerSha256: string;
  manifests: number;
  objects: number;
  completeMedia: boolean;
  declaredSettings: number;
}
export interface IsolatedBackupDownloadResult {
  version: 1;
  operation: string;
  status: IsolatedBackupDownloadStatus;
  inspection: IsolatedBackupInspection | null;
  cleanupPending: boolean;
}
export type IsolatedBackupResult = IsolatedBackupBrowseResult | IsolatedBackupDownloadResult;
export interface BackupPreferencesRequest {
  version: 1;
  action: 'preview-preferences';
  operation: string;
  reference: string;
  connection_id: string;
  boot_id: string;
}
export interface BackupPreferencesResult {
  version: 1;
  operation: string;
  reference: string;
  status: 'ready' | 'no-change' | 'busy' | 'invalidated' | 'capacity' | 'unsupported' | 'not-dispatched' | 'unavailable';
  retryable: boolean;
  preview: PortableResult | null;
  cleanupPending: boolean;
}
export type BackupRestoreRequest = Omit<BackupPreferencesRequest, 'action'> & {
  action: 'preview-restore'; invocation: string;
};
export type BackupRestoreResult = Omit<BackupPreferencesResult, 'status' | 'preview'> & {
  invocation: string;
  status: 'ready' | 'busy' | 'capacity' | 'invalidated' | 'unavailable';
  preview: RestoreResult | null;
};
export type IsolatedBackupBridgeRequest = IsolatedBackupRequest | BackupPreferencesRequest | BackupRestoreRequest;
export type IsolatedBackupBridgeResult = IsolatedBackupResult | BackupPreferencesResult | BackupRestoreResult;
export function parseIsolatedBackupBridgeRequest(value: unknown): IsolatedBackupBridgeRequest;
export function parseIsolatedBackupBridgeResult(value: unknown, request: IsolatedBackupBridgeRequest): IsolatedBackupBridgeResult;
export function parseBackupPreferencesResult(value: unknown, request: BackupPreferencesRequest): BackupPreferencesResult;
export function parseBackupRestoreResult(value: unknown, request: BackupRestoreRequest): BackupRestoreResult;
export function parseIsolatedBackupJson(input: Uint8Array, limit: number): unknown;
export function parseIsolatedBackupRequest(value: unknown): IsolatedBackupRequest;
export function parseIsolatedBackupResult(value: unknown, request?: IsolatedBackupRequest): IsolatedBackupResult;
