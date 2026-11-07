import {
  parseSharedPreferenceRequest, parseSharedPreferenceResult, sharedPreferenceContext,
  type PreferencePatch, type SharedPreferenceRequest, type SharedPreferenceResult, type Target,
} from '../host/shared-preferences-protocol.mjs';

export type SharedPreferenceAdapter = (request: SharedPreferenceRequest) => Promise<SharedPreferenceResult>;
export type SharedPreferenceState = SharedPreferenceResult & {busy: boolean};

export class SharedPreferenceController {
  state: SharedPreferenceState = {state: 'idle', reference: null, view: null, retained: [], busy: false};
  private generation = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(private readonly changed: (state: SharedPreferenceState) => void) {}

  private publish(state: SharedPreferenceState) {
    clearTimeout(this.expiry);
    this.expiry = state.view ? setTimeout(() => this.clear(), 120000) : undefined;
    this.state = state;
    this.changed(state);
  }

  clear() {
    this.generation++;
    this.publish({...this.state, state: 'idle', reference: null, view: null, busy: false});
  }

  async run(adapter: SharedPreferenceAdapter, request: SharedPreferenceRequest | null,
            stillCurrent: () => boolean = () => true) {
    if (!request || (this.state.busy && request.action !== 'cancel')) return;
    const generation = ++this.generation;
    const context = sharedPreferenceContext(request);
    const retained = this.state.retained;
    this.publish({...this.state, view: null, busy: true});
    try {
      parseSharedPreferenceRequest(request);
      const pending = adapter(request);
      request = null;
      const value = parseSharedPreferenceResult(await pending, context);
      if (generation !== this.generation) return;
      if (!stillCurrent()) { this.clear(); return; }
      this.publish({...value, busy: false});
    } catch {
      if (generation !== this.generation) return;
      if (!stillCurrent()) { this.clear(); return; }
      this.publish({state: context.action === 'edit' ? 'unknown' : 'unavailable',
        reference: context.reference ?? null, view: null, retained, busy: false});
    }
  }
}

export function target(observation: Target): Target {
  return {connection_id: observation.connection_id, boot_id: observation.boot_id};
}

export function sharedPatch(form: FormData): PreferencePatch {
  const settings: PreferencePatch['settings'] = {};
  const product: NonNullable<PreferencePatch['settings']['product_settings']> = {};
  const boolean = (field: string) => {
    const value = form.get(field);
    return value === 'on' ? true : value === 'off' ? false : undefined;
  };
  const reader = boolean('reader'), writer = boolean('writer'), exportDestination = form.get('export');
  if (reader !== undefined) product.reader_enabled = reader;
  if (writer !== undefined) product.writer_enabled = writer;
  if (exportDestination === 'mem' || exportDestination === 'disabled') product.export_destination = exportDestination;
  if (form.has('product-null')) settings.product_settings = null;
  else if (Object.keys(product).length) settings.product_settings = product;
  const personalization: NonNullable<PreferencePatch['settings']['personalization']> = {};
  const enabled = boolean('personalization');
  if (enabled !== undefined) personalization.enabled = enabled;
  if (form.has('replace-text')) personalization.text = String(form.get('text') ?? '');
  if (Object.keys(personalization).length) settings.personalization = personalization;
  const research = form.get('research');
  if (research === 'required' || research === 'disabled') settings.research_policy = research;
  if (research === 'null') settings.research_policy = null;
  return {portable_configuration_version: 1, settings};
}
