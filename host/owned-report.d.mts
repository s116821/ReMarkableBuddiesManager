export interface FileUsage { files: number; apparent_bytes: number }
export interface DomainUsage { observed_record_files: number; observed_record_bytes: number; declared_media_bytes: number; present_referenced_media_bytes: number; missing_references: number; uninspected_references: number; size_mismatched_references: number; omitted_references: number }
interface OwnedDataAccounting {
  status: 'complete' | 'partial' | 'unavailable' | 'unsupported' | 'busy';
  owner_actor: string | null; current_generation: string | null;
  observed_files: number; observed_apparent_bytes: number; complete_apparent_bytes: number | null;
  storage: Partial<Record<string, FileUsage>>; observed_domains: Partial<Record<string, DomainUsage>>;
  domain_accounting_complete: boolean; cache_inspected: boolean; shared_media_files: number; shared_media_apparent_bytes: number;
  issues: Record<string, number>; byte_basis: string; reference_totals_additive: false; media_content_verified: false;
  logical_liveness_evaluated: false; credentials_inspected: false; native_documents_inspected: false;
  lease_identity_check: string; excluded_scopes: string[];
}
export type OwnedDataReport = OwnedDataAccounting & (
  { report_version: 1 } |
  { report_version: 2; current_generation_format: 1 | 2 | 3 | null; retained_generation_formats: (1 | 2 | 3)[] }
);
export const STORAGE_KINDS: string[];
export const DOMAINS: string[];
export const ISSUE_CODES: string[];
export const REPORT_STATUSES: string[];
export const DOMAIN_FIELDS: string[];
export function parseOwnedReport(value: unknown): OwnedDataReport;
