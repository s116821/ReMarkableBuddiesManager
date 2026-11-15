export type FirstConfigTarget = {connection_id: string; boot_id: string};
type Invocation = FirstConfigTarget & {invocation: string};
export type FirstConfigRequest =
  | {action: 'retained'}
  | ({action: 'review' | 'check'} & Invocation)
  | ({action: 'create'; reference: string} & Invocation)
  | ({action: 'cancel'; reference: string | null; invocation: string | null} & FirstConfigTarget);
export type FirstConfigOutcome = 'created' | 'present' | 'blocked' | 'unknown';
export type FirstConfigCurrent = 'missing' | 'present' | 'blocked';
export type FirstConfigOriginal = FirstConfigTarget & {reference: string; outcome: FirstConfigOutcome};
export interface FirstConfigResult {
  version: 1;
  state: FirstConfigOutcome | 'none' | 'ready' | 'checked' | 'unavailable' | 'busy' | 'invalidated' | 'capacity';
  reference: string | null;
  invocation: string | null;
  current: FirstConfigCurrent | null;
  retained: FirstConfigOriginal[];
}
export const sameTarget: (a: FirstConfigTarget | null, b: FirstConfigTarget | null) => boolean;
export const parseFirstConfigResult: (value: unknown, request: FirstConfigRequest) => FirstConfigResult;
