import type { MemoryMatch } from './memory-query.mjs';
export type MemoryKey = MemoryMatch['fact']['key'];
export interface MemoryInspectionRequest { connection_id: string; boot_id: string; key: MemoryKey }
export interface MemoryHead { record: string; revision: string; parents: string[]; operation: string; actor: string; kind: 'value' | 'tombstone'; fact: (Omit<MemoryMatch['fact'], 'expires_ms'> & { expires_ms?: number | null }) | null }
export interface MemoryInspectionView { status: 'ok' | 'partial' | 'busy' | 'unavailable' | 'unsupported' | 'conflict' | 'invalid-input' | 'failed'; incomplete: boolean; heads: MemoryHead[] | null }
export const parseMemoryInspectionRequest: (v: unknown) => MemoryInspectionRequest;
export const memoryRecordId: (v: MemoryKey) => Promise<string>;
export const parseMemoryInspectionReport: (v: unknown, request: MemoryInspectionRequest) => Promise<MemoryInspectionView>;
export const parseMemoryInspectionView: (v: unknown, request: MemoryInspectionRequest) => Promise<MemoryInspectionView>;
export const parseMemoryInspectionResult: (v: unknown, request: MemoryInspectionRequest, validate: (v: unknown) => unknown) => Promise<unknown>;
export const reduceMemoryInspectionResult: (v: unknown, request: MemoryInspectionRequest, validate: (v: unknown) => unknown) => Promise<unknown>;

export const parseMemoryFact: (value: unknown, requested: MemoryKey) => Omit<MemoryMatch['fact'], 'expires_ms'> & { expires_ms?: number | null };
