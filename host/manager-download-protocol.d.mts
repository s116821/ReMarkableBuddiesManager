export interface DownloadState { report_version: 1; status: 'unconfigured'|'idle'|'downloading'|'cancelling'|'complete'|'cancelled'|'failed'; operation_id: string|null; tag: string|null; source_sha: string|null; folder: string|null; incomplete: boolean; update_eligible: false; error: 'download-refused'|'setup-unavailable'|'cancelled'|null }
export type DownloadRequest = { action: 'status' } | { action: 'start'; tag: string } | { action: 'cancel'; operation_id: string };
export function downloadState(status?: DownloadState['status']): DownloadState;
export function parseDownloadState(v: unknown): DownloadState;
export function parseDownloadRequest(v: unknown): DownloadRequest;
export function validDownloadTag(v: unknown): boolean;
