export type Target = {connection_id: string; boot_id: string};
export type RetainedPreference = Target & {reference: string};
export type PreferencePatch = {
  portable_configuration_version: 1;
  settings: {
    product_settings?: {reader_enabled?: boolean; writer_enabled?: boolean; export_destination?: 'mem'|'disabled'} | null;
    personalization?: {enabled?: boolean; text?: string};
    research_policy?: 'required'|'disabled'|null;
  };
};
export type SharedPreferenceRequest =
  | (Target & {action: 'inspect'; reveal_text: boolean})
  | (Target & {action: 'edit'; reference: string; patch: PreferencePatch})
  | (Target & {action: 'status'; reference: string})
  | {action: 'retained'}
  | {action: 'cancel'; reference: string};
type State = 'idle'|'ready'|'joining'|'unresolved'|'invalidated'|'capacity'|'no-change'|
  'local-selected'|'applied'|'superseded'|'unsupported'|'unavailable'|'busy'|'conflict'|'not-dispatched'|'unknown';
export interface EffectivePreferences {
  reader_enabled: boolean;
  writer_enabled: boolean;
  export_destination: 'mem'|'disabled';
  research_policy: 'required'|'disabled';
  personalization_enabled: boolean;
  personalization_text_present: boolean;
  personalization_text: string|null;
  origins: Record<'reader_enabled'|'writer_enabled'|'export_destination'|'research_policy'|
    'personalization_enabled'|'personalization_text', 'shared'|'local'|'default'>;
}
export interface SharedPreferenceResult {
  state: State;
  reference: string|null;
  view: {group: string; disposition: 'established-absent'|'local-selected'|'applied'|'superseded'; effective: EffectivePreferences}|null;
  retained: RetainedPreference[];
}
type Context = {action: SharedPreferenceRequest['action']; reference?: string; reveal_text?: boolean};
export const FRAME_LIMIT: number;
export function parseSharedPreferenceRequest(value: unknown): SharedPreferenceRequest;
export function parseSharedPreferenceResult(value: unknown, context: Context): SharedPreferenceResult;
export function sharedPreferenceContext(value: SharedPreferenceRequest): Context;
export function sameTarget(a: Target|null, b: Target|null): boolean;
