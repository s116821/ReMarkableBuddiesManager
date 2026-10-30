// Host-only producer admission. No raw output or operation IDs enter the renderer.
import { createHash } from 'node:crypto';
import { handwritingJson, hwExact as exact, hwUuid as uuid, hwInt as int, hwValue, hwScalars, hwRefuse as refuse, handwritingRecordId, hwV5, failureCodes } from './handwriting-records-protocol.mjs';
export const handwritingHash = v => createHash('sha256').update(v).digest('hex');
export async function handwritingRevision(profile, correction, operation, heads) { const record = await handwritingRecordId(profile, correction), fp = handwritingHash(JSON.stringify(['handwriting-mutation-v1', 'forget', record, [...heads].sort(), null])); return hwV5(`urn:rmb:handwriting-revision:v1:${operation}:${fp}`); }
export async function parseHandwritingRaw(raw, context) {
    if (raw.length > 262145 || raw.length === 0 || raw.at(-1) !== 10 || raw.filter(b => b === 10).length !== 1 || raw[0] === 239 && raw[1] === 187 && raw[2] === 191)
        refuse();
    const r = handwritingJson(raw);
    hwScalars(r);
    if (r?.handwriting_version !== 1) {
        const e = Error('Handwriting version unsupported');
        e.unsupported = true;
        throw e;
    }
    if (!exact(r, 'handwriting_version command status failure operation transaction record historical facts diagnostics') || !['query', 'inspect', 'forget', 'status'].includes(r.command) || context.command && r.command !== context.command || !['complete', 'complete-empty', 'partial', 'busy', 'unavailable', 'unsupported', 'invalid-input', 'conflict', 'failed'].includes(r.status) || !(r.failure === null || failureCodes.includes(r.failure)) || typeof r.historical !== 'boolean' || !Array.isArray(r.facts) || r.facts.length > 16)
        refuse();
    if (r.command === 'query' && raw.length > 65536)
        refuse();
    const read = ['query', 'inspect'].includes(r.command), key = r.command === 'query' ? null : await handwritingRecordId(context.profile, context.correction);
    if (r.record !== key || r.operation !== (read ? null : context.operation) || !(r.transaction === null || uuid(r.transaction)) || read && (r.historical || r.transaction !== null))
        refuse();
    const d = r.diagnostics;
    if (!exact(d, 'scanned matched omitted conflicted unsupported missing_media mutation_outcome') || !['scanned', 'matched', 'omitted', 'conflicted', 'unsupported', 'missing_media'].every(k => int(d[k])) || !['not-requested', 'not-dispatched', 'observed', 'unknown'].includes(d.mutation_outcome) || read && d.mutation_outcome !== 'not-requested')
        refuse();
    const seen = new Set();
    for (const f of r.facts) {
        if (!exact(f, 'record revision parents head conflicted state value sample_availability') || !uuid(f.record) || !uuid(f.revision) || !Array.isArray(f.parents) || f.parents.length > 4096 || !f.parents.every(uuid) || new Set(f.parents).size !== f.parents.length || f.parents.includes(f.revision) || !(f.head === null || typeof f.head === 'boolean') || !(f.conflicted === null || typeof f.conflicted === 'boolean') || !['value', 'tombstone', 'unsupported'].includes(f.state) || !['available', 'unavailable', 'not-examined', 'not-applicable'].includes(f.sample_availability) || seen.has(f.record + ':' + f.revision))
            refuse();
        seen.add(f.record + ':' + f.revision);
        if (f.state === 'value') {
            hwValue(f.value);
            if (f.value.profile !== context.profile || key !== null && f.value.correction !== context.correction || f.record !== await handwritingRecordId(f.value.profile, f.value.correction) || f.sample_availability === 'not-applicable')
                refuse();
        }
        else if (f.value !== null || f.sample_availability !== (f.state === 'tombstone' ? 'not-applicable' : 'not-examined'))
            refuse();
        if (key !== null && f.record !== key)
            refuse();
    }
    const failureStatus = r.failure === null ? null : ['unsupported-mode', 'unsupported-record', 'invalid-version'].includes(r.failure) ? 'unsupported' : r.failure === 'ownership-busy' ? 'busy' : ['heads-conflict', 'operation-conflict', 'immutable-change'].includes(r.failure) ? 'conflict' : ['store-unavailable', 'media-unavailable', 'output-limit'].includes(r.failure) ? 'unavailable' : ['commit-unknown', 'storage-failure'].includes(r.failure) ? 'failed' : 'invalid-input';
    if (failureStatus !== null && r.status !== failureStatus)
        refuse();
    const success = ['complete', 'complete-empty', 'partial'].includes(r.status);
    if (success && r.failure !== null || !success && r.failure === null)
        refuse();
    if (['complete', 'complete-empty'].includes(r.status) && ['omitted', 'conflicted', 'unsupported', 'missing_media'].some(k => d[k] > 0))
        refuse();
    if (read) {
        if (r.command === 'query') {
            if (r.facts.length > 8 || new Set(r.facts.map(f => f.record)).size !== r.facts.length || r.facts.some((f, i) => f.state !== 'value' || f.sample_availability !== 'available' || f.head !== true || f.conflicted !== false || i > 0 && r.facts[i - 1].record >= f.record) || r.status === 'complete' && r.facts.length === 0 || r.status === 'complete-empty' && (r.facts.length !== 0 || d.matched !== 0) || r.status === 'partial' && !['omitted', 'conflicted', 'unsupported', 'missing_media'].some(k => d[k] > 0))
                refuse();
        }
        else {
            for (const f of r.facts)
                if (f.head !== true || f.conflicted !== (r.facts.length > 1))
                    refuse();
            if (r.status === 'complete-empty' && r.facts.length || r.status === 'complete' && (r.facts.length !== 1 || r.facts.some(f => f.state === 'unsupported' || f.state === 'value' && f.sample_availability !== 'available')) || r.status === 'partial' && !['conflicted', 'unsupported', 'missing_media'].some(k => d[k] > 0) && !r.facts.some(f => f.state === 'value' && f.sample_availability === 'not-examined'))
                refuse();
        }
        if (!success && r.facts.length && !(r.command === 'inspect' && r.status === 'unsupported' && r.failure === 'unsupported-record' && r.facts.every(f => f.state === 'unsupported')))
            refuse();
    }
    else if (r.command === 'forget') {
        if (r.status === 'complete') {
            if (d.mutation_outcome !== 'observed' || r.facts.length !== 1 || r.historical !== (r.transaction === null))
                refuse();
            await tombstone(r, context);
        }
        else if (r.status === 'failed' && r.failure === 'commit-unknown') {
            if (r.facts.length || r.transaction !== null || r.historical || d.mutation_outcome !== 'unknown')
                refuse();
        }
        else if (!['invalid-input', 'unsupported', 'busy', 'unavailable', 'conflict', 'failed'].includes(r.status) || r.facts.length || r.transaction !== null || r.historical || d.mutation_outcome !== 'not-dispatched')
            refuse();
    }
    else {
        if (r.transaction !== null)
            refuse();
        if (r.status === 'complete') {
            if (!r.historical || d.mutation_outcome !== 'observed' || r.facts.length !== 1)
                refuse();
            await tombstone(r, context);
        }
        else if (r.status === 'complete-empty') {
            if (r.historical || r.facts.length || d.mutation_outcome !== 'unknown')
                refuse();
        }
        else if (!['invalid-input', 'unsupported', 'busy', 'unavailable', 'conflict', 'failed'].includes(r.status) || r.historical || r.facts.length || d.mutation_outcome !== 'unknown')
            refuse();
    }
    return r;
}
async function tombstone(r, c) { const f = r.facts[0], revision = c.expected_revision ?? await handwritingRevision(c.profile, c.correction, c.operation, c.expected_heads); if (f.state !== 'tombstone' || f.revision !== revision || JSON.stringify(f.parents) !== JSON.stringify(c.expected_heads) || f.head !== (r.historical ? null : true) || f.conflicted !== (r.historical ? null : false))
    refuse(); }
export function handwritingDiagnostics(r) { const { status, failure, diagnostics: { scanned, matched, omitted, conflicted, unsupported, missing_media } } = r; return { status, failure, scanned, matched, omitted, conflicted, unsupported, missing_media }; }
export function handwritingView(r, q, kind) { return { kind, profile: q.profile, correction: q.command === 'query' ? null : q.correction, heads: r.facts.map(f => { let content = null; if (f.value) {
        content = structuredClone(f.value);
        delete content.kind;
        delete content.profile;
    } return { record: f.record, revision: f.revision, parents: [...f.parents], state: f.state, conflicted: f.conflicted, content, sample_availability: f.sample_availability }; }), partial: r.status === 'partial' }; }
