import { hwUuid, hwText, parseHandwritingRequest, parseHandwritingResult, handwritingContext, type HandwritingRequest, type HandwritingResult, type HandwritingRetained, type HandwritingState, type HandwritingOutcome } from '../host/handwriting-records-protocol.mjs';
import { validateResult } from '../host/observation-protocol.mjs';
import { displayModelText, spliceModelText, reconcileModelText } from '../host/opaque-text.mjs';
import type { TabletObservation } from './observation';
export interface HandwritingAdapter {
    handwritingRecords(q: HandwritingRequest): Promise<HandwritingResult>;
}
export interface HandwritingUiState {
    profile: string;
    correction: string;
    query: string;
    busy: boolean;
    status: string;
    result: HandwritingState | null;
    retained: HandwritingRetained[];
}
type Field = 'profile' | 'correction' | 'query';
type Target = {
    connection_id: string;
    boot_id: string;
    invocation: string;
    reference: string | null;
};
const labels: Record<string, string> = { queried: 'Saved corrections checked. These records do not prove improved recognition.', inspected: 'Captured record inspected. Source links are caller assertions.', partial: 'Some records or samples could not be included. This is not a complete empty result.', prepared: 'Review this exact correction and confirm removal separately. Historical text and samples will remain.', 'not-removable': 'This record cannot be prepared for removal. Inspect its heads and media state.', unknown: 'The removal result is unknown. Check this original operation; do not repeat it.', 'removal-observed': 'Removal from active use was observed. Historical text, samples and backups remain.', 'historical-removal-observed': 'The original removal was found in retained history. Its current head may have changed.', unresolved: 'The original removal is still unconfirmed. Absence does not prove rollback.', 'not-dispatched': 'This removal was not dispatched.', busy: 'Another operation is running.', unsupported: 'The installed Buddy or its selected mode does not support this operation.', unavailable: 'Saved correction management is unavailable.', expired: 'The time limit for checking this original request has expired. No new request was sent.', capacity: 'This session already retains eight removal attempts. No new removal was prepared.', invalidated: 'The draft and displayed record details were cleared.' };
export class HandwritingRecordsController {
    state: HandwritingUiState = { profile: '', correction: '', query: '', busy: false, status: 'Enter an explicit profile UUID to inspect saved corrections.', result: null, retained: [] };
    private generation = 0;
    private active: Target | null = null;
    private activeMutation = false;
    private ready: Target | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private expiries = new Map<string, number>();
    private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly changed: (s: HandwritingUiState) => void;
    private readonly erase: () => void;
    private readonly now: () => number;
    private readonly uuid: () => string;
    constructor(changed: (s: HandwritingUiState) => void, erase: () => void = () => { }, now: () => number = () => performance.now(), uuid: () => string = () => crypto.randomUUID()) { this.changed = changed; this.erase = erase; this.now = now; this.uuid = uuid; }
    private publish(p: Partial<HandwritingUiState>) { this.state = { ...this.state, ...p }; this.changed(this.state); }
    text(field: Field) { return displayModelText(this.state[field]); }
    setField(field: Field, value: string) { if (this.state.busy)
        return false; if ([...value].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; }) || new TextEncoder().encode(value).length > (field === 'query' ? 2048 : 36)) {
        this.clear();
        return false;
    } clearTimeout(this.timer); this.ready = null; this.publish({ [field]: value, result: null }); return true; }
    input(field: Field, next: string) { try {
        this.setField(field, reconcileModelText(this.state[field], next));
    }
    catch {
        this.clear();
    } }
    paste(field: Field, start: number, end: number, text: string) { try {
        return this.setField(field, spliceModelText(this.state[field], start, end, text));
    }
    catch {
        this.clear();
        return false;
    } }
    valid(key = false) { return hwUuid(this.state.profile) && (!key || hwUuid(this.state.correction)) && (this.state.query.trim() === '' || hwText(this.state.query, 2048)); }
    private rows(rows: HandwritingRetained[]) { const all = new Map(this.state.retained.map(r => [r.reference, r])); for (const r of rows)
        all.set(r.reference, { ...r, expired: r.expired || (this.expiries.get(r.reference) ?? Infinity) <= this.now() }); return [...all.values()]; }
    private expire(ref: string) { if (this.expiries.has(ref))
        return; this.expiries.set(ref, this.now() + 1800000); const t = setTimeout(() => { this.expiryTimers.delete(ref); this.publish({ retained: this.state.retained.map(r => r.reference === ref ? { ...r, expired: true } : r) }); }, 1800000); this.expiryTimers.set(ref, t); (t as unknown as {
        unref?: () => void;
    }).unref?.(); }
    canCheck(r: HandwritingRetained) { return !r.expired && (this.expiries.get(r.reference) ?? Infinity) > this.now(); }
    canPrepare() { const r = this.state.result; return !this.state.busy && r?.state === 'inspected' && r.view?.heads.length === 1 && r.view.heads[0].state === 'value' && r.view.heads[0].sample_availability === 'available'; }
    clear() { this.generation++; clearTimeout(this.timer); this.active = null; this.activeMutation = false; this.ready = null; this.erase(); this.publish({ profile: '', correction: '', query: '', busy: false, result: null, status: labels['invalidated'] }); }
    dispose() { this.clear(); for (const t of this.expiryTimers.values())
        clearTimeout(t); this.expiryTimers.clear(); }
    async retained(a: HandwritingAdapter) { const g = this.generation; try {
        const r = await parseHandwritingResult(await a.handwritingRecords({ action: 'retained' }), { action: 'retained' }, validateResult);
        if (g === this.generation)
            this.publish({ retained: this.rows(r.handwriting_records.retained) });
    }
    catch { /* No reconstruction from metadata. */ } }
    async query(a: HandwritingAdapter, t: TabletObservation, pause: () => Promise<boolean>) { if (this.valid() && !this.state.busy)
        await this.run(a, t, { action: 'query', profile: this.state.profile, query_text: this.state.query.trim() === '' ? null : this.state.query }, pause); }
    async inspect(a: HandwritingAdapter, t: TabletObservation, pause: () => Promise<boolean>, key?: {
        profile: string;
        correction: string;
    }) { if (!this.state.busy && (key || this.valid(true)))
        await this.run(a, t, { action: 'inspect', profile: key?.profile ?? this.state.profile, correction: key?.correction ?? this.state.correction }, pause); }
    async prepare(a: HandwritingAdapter, t: TabletObservation, pause: () => Promise<boolean>) { const v = this.state.result?.view; if (this.canPrepare() && v?.correction)
        await this.run(a, t, { action: 'prepare-remove', profile: v.profile, correction: v.correction }, pause); }
    async confirm(a: HandwritingAdapter, t: TabletObservation, pause: () => Promise<boolean>) { const r = this.state.result; if (!this.state.busy && r?.state === 'prepared' && r.reference)
        await this.run(a, t, { action: 'confirm-remove', reference: r.reference }, pause); }
    async check(a: HandwritingAdapter, t: TabletObservation, r: HandwritingRetained, pause: () => Promise<boolean>) { if (!this.state.busy && this.canCheck(r) && r.connection_id === t.connection_id && r.boot_id === t.boot_id)
        await this.run(a, t, { action: 'check-remove', reference: r.reference }, pause); }
    private async run(a: HandwritingAdapter, t: TabletObservation, body: object, pause: () => Promise<boolean>) {
        const identity = { connection_id: t.connection_id, boot_id: t.boot_id }, invocation = this.uuid(), g = ++this.generation, started = this.now();
        let q: HandwritingRequest | null = parseHandwritingRequest({ ...body, ...identity, invocation });
        const action = q.action, reference = 'reference' in q ? q.reference : null, original = this.state.retained.find(r => r.reference === reference), context = handwritingContext(q, original?.original_outcome ?? null);
        this.active = { ...identity, invocation, reference };
        this.activeMutation = action === 'confirm-remove';
        this.ready = null;
        clearTimeout(this.timer);
        this.erase();
        this.publish({ profile: '', correction: '', query: '', busy: true, result: null, status: action === 'confirm-remove' ? 'Removing this correction from active use...' : 'Checking saved correction records...' });
        let possible = false, timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([(async () => { if (!await pause() || g !== this.generation)
                    return null; if (action === 'confirm-remove' && reference) {
                    possible = true;
                    this.expire(reference);
                    this.publish({ retained: this.rows([{ ...identity, reference, original_outcome: 'unknown', expired: false }]) });
                } const pending = a.handwritingRecords(q!); q = null; const r = await pending; if (g !== this.generation)
                    return null; return parseHandwritingResult(r, context, validateResult); })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Handwriting wait expired')), 14000); })]);
            if (g !== this.generation)
                return;
            this.active = null;
            if (!result) {
                this.clear();
                return;
            }
            const r = result.handwriting_records;
            if (action === 'confirm-remove' && reference && ['busy', 'unavailable', 'invalidated'].includes(r.state) && !r.retained.some(row => row.reference === reference)) {
                clearTimeout(this.expiryTimers.get(reference));
                this.expiryTimers.delete(reference);
                this.expiries.delete(reference);
                this.publish({ retained: this.state.retained.filter(row => row.reference !== reference) });
            }
            this.publish({ busy: false, result: r, retained: this.rows(r.retained), status: labels[r.state] ?? labels['unavailable'] });
            if (r.state === 'prepared' && r.reference) {
                this.ready = { ...identity, invocation, reference: r.reference };
                this.timer = setTimeout(() => { if (g === this.generation)
                    this.clear(); }, Math.max(1, 120000 - (this.now() - started)));
            }
        }
        catch {
            if (g === this.generation) {
                this.generation++;
                this.active = null;
                this.publish({ busy: false, result: null, status: labels[possible ? 'unknown' : 'unavailable'] });
            }
        }
        finally {
            q = null;
            clearTimeout(timer);
        }
    }
    async stop(a: HandwritingAdapter) { const target = this.active ?? this.ready, read = this.active !== null && !this.activeMutation; this.clear(); const g = this.generation; if (!target)
        return; let timer: ReturnType<typeof setTimeout> | undefined; this.publish({ busy: true, status: 'Stopping this wait...' }); try {
        const q = parseHandwritingRequest({ action: 'cancel', ...target }), r = await Promise.race([a.handwritingRecords(q), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Stop expired')), 14000); })]);
        const v = await parseHandwritingResult(r, handwritingContext(q), validateResult);
        if (g === this.generation) {
            // A matching unconsumed preparation was revoked, rather than an
            // uncertain mutation rolled back. Keep real host originals intact.
            if (!read && target.reference && this.state.retained.some(row => row.reference === target.reference && row.original_outcome === 'unknown') && ['invalidated', 'not-dispatched'].includes(v.handwriting_records.state) && !v.handwriting_records.retained.some(row => row.reference === target.reference)) {
                clearTimeout(this.expiryTimers.get(target.reference));
                this.expiryTimers.delete(target.reference);
                this.expiries.delete(target.reference);
                this.publish({ retained: this.state.retained.filter(row => row.reference !== target.reference || row.original_outcome !== 'unknown') });
            }
            this.publish({ busy: false, result: v.handwriting_records, retained: this.rows(v.handwriting_records.retained), status: read ? 'Stopped waiting for records. Earlier removal history is unchanged.' : labels[v.handwriting_records.state] ?? labels['invalidated'] });
        }
    }
    catch {
        if (g === this.generation)
            this.publish({ busy: false, status: 'Wait stopped. A removal may still have completed; original history is kept.' });
    }
    finally {
        clearTimeout(timer);
    } }
}
export const handwritingAttemptMessage = (outcome: HandwritingOutcome) => labels[outcome] ?? labels['unknown'];
