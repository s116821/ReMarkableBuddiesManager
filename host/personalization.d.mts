export type PersonalizationOperation = 'inspect' | 'set' | 'disable' | 'clear';
export interface PersonalizationValue { schema_version: 1; enabled: boolean; text: string }
export interface PersonalizationRequest { operation: PersonalizationOperation; connection_id: string; boot_id: string; expected_config_sha256?: string; enabled?: boolean; text?: string }
export interface PersonalizationReport { report_version: 1; operation: PersonalizationOperation; status: 'ok' | 'invalid-input' | 'unavailable' | 'unsupported' | 'busy' | 'conflict' | 'failed'; disk_reload_verified: boolean; runtime_activation: 'unverified' | 'restart-required'; config_sha256: string | null; personalization: PersonalizationValue | null }
export const PERSONALIZATION_OPERATIONS: readonly PersonalizationOperation[];
export const validText: (value: unknown) => boolean;
export const parsePersonalizationRequest: (value: unknown) => PersonalizationRequest;
export const parsePersonalizationReport: (value: unknown, operation: PersonalizationOperation) => PersonalizationReport;
export const parsePersonalizationResult: (value: unknown, request: PersonalizationRequest, validateObservation: (value: unknown) => unknown) => unknown;
