export interface MemoryRequest { connection_id: string; boot_id: string; text: string }
export interface MemoryMatch { record: string; revision: string; fact: { key: { profile: string; fact: string; scope: { kind: 'global' } }; claim: string; value: string; subject: string; tags: string[]; provenance: { basis: string; description: string; conversation: string | null; turn: string | null; source: string | null }; confidence_basis_points: number; observed_ms: number; expires_ms: number | null } }
export interface MemoryDiagnostics { conflicted_keys: number; contradicted_claims: number; unsupported: number; expired: number; suppressed: number; budget_omitted: number; snapshot_unavailable: boolean }
export interface MemoryReport { report_version: 1; operation: 'query'; status: 'ok' | 'partial' | 'busy' | 'unavailable' | 'unsupported' | 'conflict' | 'invalid-input' | 'failed'; incomplete: boolean; data: { query_status: 'disabled' | 'complete-empty' | 'complete' | 'partial' | 'unavailable'; diagnostics: MemoryDiagnostics; context: { kind: 'associative-memory-data'; provenance_authority: 'author-asserted-not-source-verified'; facts: MemoryMatch[] } } | { current_heads: string[] } | null }
export const validMemoryText: (v: unknown) => boolean;
export const parseMemoryRequest: (v: unknown) => MemoryRequest;
export const parseMemoryReport: (v: unknown) => MemoryReport;
export const parseMemoryResult: (v: unknown, request: MemoryRequest, validateObservation: (value: unknown) => unknown) => unknown;
