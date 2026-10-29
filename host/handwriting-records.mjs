import { randomBytes, randomUUID } from 'node:crypto';
import { MaintenanceIO } from './maintenance-io.mjs';
import { validateResult } from './observation-protocol.mjs';
import { strictJson } from './strict-json.mjs';
import { parseHandwritingRequest, parseHandwritingResult, handwritingContext } from './handwriting-records-protocol.mjs';
import { parseHandwritingRaw, handwritingHash, handwritingRevision, handwritingView, handwritingDiagnostics } from './handwriting-records-private.mjs';
const same = (a, b) => a && b && a.connection_id === b.connection_id && a.boot_id === b.boot_id;
export class HandwritingRecordsHost {
    #ready = null;
    #records = new Map();
    #active = null;
    #epoch = 0;
    #issued = new WeakMap();
    #fences = new Map();
    constructor({ observer, io = new MaintenanceIO(), beforeIO = () => { }, now = () => performance.now(), reference = () => randomBytes(32).toString('hex'), uuid = randomUUID, budgetMs = 13000 } = {}) { if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 13000)
        throw Error('Handwriting budget refused'); Object.assign(this, { observer, io, beforeIO, now, reference, uuid, budgetMs }); }
    #wipe(s) { clearTimeout(s.timer); s.packet?.fill(0); s.preview?.fill(0); s.packet = null; s.preview = null; s.hash = null; s.previewHash = null; }
    #arm(s, duration) { clearTimeout(s.timer); s.deadline = this.now() + duration; s.timer = setTimeout(() => { if (this.#ready === s) {
        this.#ready = null;
        this.#epoch++;
    } this.#wipe(s); }, duration); s.timer.unref?.(); }
    #expire() { if (this.#ready && this.now() >= this.#ready.deadline) {
        this.#wipe(this.#ready);
        this.#ready = null;
        this.#epoch++;
    } for (const s of this.#records.values())
        if (s.packet && this.now() >= s.deadline)
            this.#wipe(s); for (const [k, t] of this.#fences)
        if (this.now() >= t)
            this.#fences.delete(k); }
    #rows() { return [...this.#records.values()].map(s => ({ reference: s.reference, connection_id: s.sample.connection_id, boot_id: s.sample.boot_id, original_outcome: s.outcome, expired: !s.packet || this.now() >= s.deadline })); }
    context(q) { return handwritingContext(q, this.#records.get(q.reference)?.outcome ?? null); }
    #value(q, state, s = null, { view = null, diagnostics = null, check = null, original = s?.outcome ?? null } = {}) { const observed = !!view || !!diagnostics; const v = { contract_version: 1, status: observed ? 'observed' : 'unconfigured', observation: observed ? structuredClone(s.sample) : null, handwriting_records: { state, reference: s?.reference ?? q.reference ?? null, invocation: q.invocation ?? null, view, original_outcome: original, check_outcome: check, diagnostics, retained: this.#rows() } }; this.#issued.set(v, this.#epoch); return v; }
    assertCurrent(v) { this.#expire(); if (this.#issued.get(v) !== this.#epoch || v.handwriting_records.state === 'prepared' && this.#ready?.reference !== v.handwriting_records.reference)
        throw Error('Handwriting result invalidated'); return v; }
    invalidate() { this.#epoch++; if (this.#ready) {
        this.#wipe(this.#ready);
        this.#ready = null;
    } const a = this.#active; if (a) {
        for (const b of a.buffers)
            b.fill(0);
        a.buffers.length = 0;
        this.io.release(a.token);
    } this.#active = null; }
    #key(q) { return `${q.connection_id}:${q.boot_id}:${q.reference ?? 'none'}:${q.invocation}`; }
    #fenced(q) { return this.#fences.has(this.#key(q)) || this.#fences.has(this.#key({ ...q, reference: null })); }
    #current(a) { return this.#active === a && a.epoch === this.#epoch && this.io.owns(a.token) && this.now() < a.deadline && same(a.s.sample, this.observer.lastObservation); }
    #packet(s) { if (!s.packet || this.now() >= s.deadline || handwritingHash(s.packet) !== s.hash)
        throw Error('Handwriting original unavailable'); return strictJson(s.packet); }
    async request(value) { const q = parseHandwritingRequest(value); value = null; this.#expire(); const context = this.context(q); let v; try {
        if (q.action === 'retained')
            v = this.#value(q, 'idle');
        else if (q.action === 'cancel')
            v = this.#cancel(q);
        else if (!same(q, this.observer.lastObservation))
            v = this.#value(q, 'unavailable');
        else
            v = await this.#execute(q);
        return this.assertCurrent(await parseHandwritingResult(v, context, validateResult));
    }
    finally {
        if ('query_text' in q)
            q.query_text = null;
    } }
    async #execute(q) {
        const initial = ['query', 'inspect', 'prepare-remove'].includes(q.action);
        let s = initial ? null : q.action === 'confirm-remove' ? this.#ready : this.#records.get(q.reference);
        if (!initial && (!s || s.reference !== q.reference || !same(s.sample, q) || !s.packet || this.now() >= s.deadline || q.action === 'confirm-remove' && s.possible))
            return this.#value(q, q.action === 'check-remove' && this.#records.has(q.reference) ? 'expired' : 'unavailable', q.action === 'check-remove' ? s : null);
        if (q.action === 'prepare-remove' && this.#records.size >= 8)
            return this.#value(q, 'capacity');
        if (this.#fenced(q))
            return this.#value(q, 'invalidated');
        if (s && (s.ledger.has(q.invocation) || q.action === 'check-remove' && s.checks >= 32))
            return this.#value(q, 'unavailable', s);
        const started = this.now(), token = this.io.acquire('handwriting-records', s?.reference ?? q.invocation, q.action);
        if (!token)
            return this.#value(q, 'busy', s);
        let a, timer;
        try {
            if (initial) {
                this.invalidate();
                s = { reference: null, sample: structuredClone(this.observer.lastObservation), packet: null, preview: null, outcome: null, possible: false, ledger: new Set(), checks: 0, deadline: started + this.budgetMs, creator: q.invocation };
            }
            else if (this.#ready && this.#ready !== s) {
                this.#wipe(this.#ready);
                this.#ready = null;
            }
            this.beforeIO();
            if (this.#fenced(q))
                return this.#value(q, 'invalidated');
            s.ledger.add(q.invocation);
            if (q.action === 'check-remove')
                s.checks++;
            a = { s, q, token, epoch: this.#epoch, deadline: Math.min(started + this.budgetMs, s.deadline), buffers: [] };
            this.#active = a;
            const work = async () => {
                let body;
                if (initial)
                    body = q.action === 'query' ? { handwriting_version: 1, command: 'query', profile: q.profile, query_text: q.query_text, max_matches: 8, max_encoded_bytes: 65536 } : { handwriting_version: 1, command: 'inspect', profile: q.profile, correction: q.correction };
                else {
                    body = this.#packet(s);
                    if (q.action === 'confirm-remove') {
                        if (!s.preview || handwritingHash(s.preview) !== s.previewHash)
                            throw Error('Handwriting preview refused');
                        s.preview.fill(0);
                        s.preview = null;
                        s.previewHash = null;
                        s.possible = true;
                        s.outcome = 'unknown';
                        this.#ready = null;
                        this.#records.set(s.reference, s);
                        this.#arm(s, 1800000);
                    }
                    else {
                        const { profile, correction, operation } = body;
                        body = { handwriting_version: 1, command: 'status', profile, correction, operation };
                    }
                }
                const originalBody = initial ? body : this.#packet(s);
                const context = { ...originalBody, command: body.command, expected_revision: initial ? null : await handwritingRevision(originalBody.profile, originalBody.correction, originalBody.operation, originalBody.expected_heads) };
                if (!this.#current(a))
                    throw Error('Handwriting invalidated');
                const bytes = Buffer.from(JSON.stringify(body));
                a.buffers.push(bytes);
                const raw = await this.#raw(a, body.command, bytes);
                const r = await parseHandwritingRaw(raw, context);
                if (!this.#current(a))
                    throw Error('Handwriting stale');
                const diagnostics = handwritingDiagnostics(r);
                if (q.action === 'confirm-remove') {
                    s.outcome = r.status === 'complete' ? (r.historical ? 'historical-removal-observed' : 'removal-observed') : r.diagnostics.mutation_outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown';
                    return this.#value(q, s.outcome, s, { diagnostics });
                }
                if (q.action === 'check-remove') {
                    if (r.status === 'complete')
                        return this.#value(q, 'historical-removal-observed', s, { diagnostics, check: 'historical-removal-observed' });
                    if (['busy', 'unsupported'].includes(r.status))
                        return this.#value(q, r.status, s, { diagnostics });
                    return this.#value(q, 'unresolved', s, { diagnostics, check: 'unresolved' });
                }
                if (q.action === 'prepare-remove') {
                    if (r.status !== 'complete' || r.facts.length !== 1 || r.facts[0].state !== 'value' || r.facts[0].sample_availability !== 'available')
                        return this.#value(q, ['busy', 'unsupported', 'unavailable'].includes(r.status) ? r.status : 'not-removable', s, { diagnostics });
                    const view = handwritingView(r, body, 'confirmation');
                    s.reference = this.reference();
                    if (this.#records.has(s.reference))
                        throw Error('Handwriting reference collision');
                    s.packet = Buffer.from(JSON.stringify({ handwriting_version: 1, command: 'forget', profile: q.profile, correction: q.correction, operation: this.uuid(), expected_heads: [r.facts[0].revision] }));
                    s.hash = handwritingHash(s.packet);
                    s.preview = Buffer.from(JSON.stringify(view));
                    s.previewHash = handwritingHash(s.preview);
                    this.#ready = s;
                    this.#arm(s, 120000);
                    return this.#value(q, 'prepared', s, { view, diagnostics });
                }
                if (['complete', 'complete-empty', 'partial'].includes(r.status))
                    return this.#value(q, r.status === 'partial' ? 'partial' : q.action === 'query' ? 'queried' : 'inspected', s, { view: handwritingView(r, body, q.action), diagnostics });
                return this.#value(q, ['busy', 'unsupported'].includes(r.status) ? r.status : 'unavailable', s, { diagnostics });
            };
            return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { if (this.#active === a && this.io.owns(token)) {
                    this.invalidate();
                    this.observer.cancel();
                } reject(Error('Handwriting wait expired')); }, Math.max(1, a.deadline - this.now())); })]);
        }
        catch (e) {
            if (q.action === 'confirm-remove' && s?.possible)
                return this.#value(q, 'unknown', s);
            return this.#value(q, e.unsupported ? 'unsupported' : q.action === 'check-remove' ? 'unresolved' : 'unavailable', q.action === 'check-remove' ? s : null, q.action === 'check-remove' ? { check: 'unresolved' } : {});
        }
        finally {
            clearTimeout(timer);
            if (a) {
                for (const b of a.buffers)
                    b.fill(0);
                if (this.#active === a)
                    this.#active = null;
            }
            if (initial && this.#ready !== s)
                this.#wipe(s);
            this.io.release(token);
        }
    }
    async #raw(a, command, input) { const budget_ms = Math.min(12000, Math.floor(a.deadline - this.now())); const q = { command, input_base64: input.toString('base64'), budget_ms, connection_id: a.s.sample.connection_id, boot_id: a.s.sample.boot_id }; if (budget_ms < 1 || input.length > 16384 || Buffer.byteLength(JSON.stringify(q)) > 24576)
        throw Error('Handwriting input refused'); let v; try {
        v = await this.observer.run('handwriting-records', q);
    }
    finally {
        q.input_base64 = null;
    } if (!this.#current(a))
        throw Error('Handwriting result stale'); if (!v || Object.keys(v).sort().join() !== 'contract_version,handwriting_raw,observation,status' || Buffer.byteLength(JSON.stringify(v)) > 360448)
        throw Error('Handwriting transport refused'); validateResult({ contract_version: v.contract_version, status: v.status, observation: v.observation }); if (v.status !== 'observed' || !same(v.observation, a.s.sample) || !v.handwriting_raw || Object.keys(v.handwriting_raw).sort().join() !== 'status,stdout_base64')
        throw Error('Handwriting target unavailable'); const r = v.handwriting_raw; if (r.status === 'unsupported' && r.stdout_base64 === null) {
        const e = Error('Handwriting unsupported');
        e.unsupported = true;
        throw e;
    } if (r.status !== 'reported' || typeof r.stdout_base64 !== 'string')
        throw Error('Handwriting unavailable'); const raw = Buffer.from(r.stdout_base64, 'base64'); a.buffers.push(raw); if (raw.length > 262145 || raw.toString('base64') !== r.stdout_base64)
        throw Error('Handwriting report refused'); return raw; }
    #cancel(q) { const a = this.#active; if (a && same(a.s.sample, q) && a.q.invocation === q.invocation && (q.reference === null || a.s.reference === q.reference) && this.io.owns(a.token)) {
        if (a.q.action === 'check-remove') {
            this.invalidate();
            this.observer.cancel();
            return this.#value(q, 'invalidated');
        }
        const s = a.s, possible = s.possible;
        if (possible && s.outcome !== 'unknown')
            return this.#value(q, 'unavailable');
        this.invalidate();
        this.observer.cancel();
        return possible ? this.#value(q, 'unknown', s) : this.#value(q, 'not-dispatched');
    } const s = this.#ready; if (s && same(s.sample, q) && (s.reference === q.reference || q.reference === null && s.creator === q.invocation)) {
        this.#wipe(s);
        this.#ready = null;
        this.#epoch++;
        return this.#value(q, 'invalidated');
    } const old = this.#records.get(q.reference); if (old) {
        if (!same(old.sample, q) || !old.packet || old.ledger.has(q.invocation) || old.ledger.size >= 33)
            return this.#value(q, 'unavailable');
        old.ledger.add(q.invocation);
        return this.#value(q, 'not-dispatched');
    } const key = this.#key(q); if (!same(q, this.observer.lastObservation) || this.#fences.size >= 32 && !this.#fences.has(key))
        return this.#value(q, 'unavailable'); if (!this.#fences.has(key))
        this.#fences.set(key, this.now() + 14000); return this.#value(q, 'not-dispatched'); }
}
