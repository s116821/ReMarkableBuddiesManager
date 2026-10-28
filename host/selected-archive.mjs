import { randomBytes } from 'node:crypto';
import { MaintenanceIO } from './maintenance-io.mjs';
import { validateResult } from './observation-protocol.mjs';
import { archivePath, parseArchiveRequest, archiveResponseContext, parseArchiveResult } from './selected-archive-protocol.mjs';
import { strictJson } from './strict-json.mjs';
import { archiveHash, parseArchiveRaw, ArchiveUnsupported } from './selected-archive-private.mjs';
const same = (a, b) => a && b && a.connection_id === b.connection_id && a.boot_id === b.boot_id;
export class SelectedArchiveHost {
  #ready = null; #records = new Map(); #active = null; #epoch = 0; #issued = new WeakMap(); #fences = new Map();
  constructor({ observer, io = new MaintenanceIO(), beforeIO = () => {}, now = () => performance.now(), reference = () => randomBytes(32).toString('hex'), budgetMs = 13000 } = {}) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 13000) throw Error('Archive budget refused');
    Object.assign(this, { observer, io, beforeIO, now, reference, budgetMs });
  }
  #wipe(s) { clearTimeout(s.timer); s.packet?.fill(0); s.packet = null; s.pathHash = null; }
  #arm(s, duration) {
    clearTimeout(s.timer); s.deadline = this.now() + duration;
    s.timer = setTimeout(() => { if (this.#ready === s) { this.#ready = null; this.#epoch++; } this.#wipe(s); }, duration); s.timer.unref?.();
  }
  #expire() {
    if (this.#ready && this.now() >= this.#ready.deadline) { this.#wipe(this.#ready); this.#ready = null; this.#epoch++; }
    for (const s of this.#records.values()) if (s.packet && this.now() >= s.deadline) this.#wipe(s);
    for (const [key, deadline] of this.#fences) if (this.now() >= deadline) this.#fences.delete(key);
  }
  #rows() { return [...this.#records.values()].map(s => ({ reference: s.reference, connection_id: s.sample.connection_id, boot_id: s.sample.boot_id, original_outcome: s.outcome, expired: !s.packet || this.now() >= s.deadline })); }
  context(q) { return archiveResponseContext(q, this.#records.get(q.reference)?.outcome ?? null); }
  #value(q, state, s = null, { summary = null, original = s?.outcome ?? null, check = null } = {}) {
    const observed = !!summary || state === 'ready';
    const v = { contract_version: 1, status: observed ? 'observed' : 'unconfigured', observation: observed ? structuredClone(s.sample) : null,
      selected_archive: { state, reference: s?.reference ?? q.reference ?? null, invocation: q.invocation ?? null, summary, original_outcome: original, check_outcome: check, retained: this.#rows() } };
    this.#issued.set(v, this.#epoch); return v;
  }
  assertCurrent(v) { this.#expire(); if (this.#issued.get(v) !== this.#epoch || v.selected_archive.state === 'ready' && this.#ready?.reference !== v.selected_archive.reference) throw Error('Archive result invalidated'); return v; }
  invalidate() {
    this.#epoch++;
    if (this.#ready) { this.#wipe(this.#ready); this.#ready = null; }
    const a = this.#active;
    if (a) { for (const b of a.buffers) b.fill(0); a.buffers.length = 0; this.io.release(a.token); }
    this.#active = null;
  }
  #key(q) { return `${q.connection_id}:${q.boot_id}:${q.reference ?? "none"}:${q.invocation}`; }
  #fenced(q) { return this.#fences.has(this.#key(q)) || this.#fences.has(this.#key({ ...q, reference: null })); }
  #current(a) { return this.#active === a && a.epoch === this.#epoch && this.io.owns(a.token) && this.now() < a.deadline && same(a.s.sample, this.observer.lastObservation); }
  #packet(s) {
    if (!s.packet || this.now() >= s.deadline || archiveHash(s.packet) !== s.packetHash) throw Error('Archive original unavailable');
    const body = strictJson(s.packet);
    if (!body || Object.keys(body).join() !== 'path' || !archivePath(body.path) || archiveHash(Buffer.from(body.path)) !== s.pathHash) throw Error('Archive original refused');
    return s.packet;
  }
  #new(q) {
    const packet = Buffer.from(JSON.stringify({ path: q.path }));
    const s = { reference: this.reference(), sample: structuredClone(this.observer.lastObservation), packet, packetHash: archiveHash(packet), pathHash: archiveHash(Buffer.from(q.path)), outcome: null, possible: false, ledger: new Map(), deadline: this.now() + 120000, creator: q.invocation, timer: null };
    if (this.#records.has(s.reference) || this.#ready?.reference === s.reference) { this.#wipe(s); throw Error('Archive reference refused'); }
    return s;
  }
  async request(value) {
    const q = parseArchiveRequest(value); value = null; this.#expire(); const context = this.context(q);
    try {
      let v;
      if (q.action === 'retained') v = this.#value(q, 'idle');
      else if (q.action === 'cancel') v = this.#cancel(q);
      else if (!same(q, this.observer.lastObservation)) v = this.#value(q, 'unavailable');
      else v = await this.#execute(q);
      return this.assertCurrent(parseArchiveResult(v, context, validateResult));
    } finally { if ('path' in q) q.path = null; }
  }
  async #execute(q) {
    const initial = ['inspect', 'prepare-export'].includes(q.action);
    let s = initial ? null : q.action === 'confirm-export' ? this.#ready : this.#records.get(q.reference);
    if (!initial && (!s || s.reference !== q.reference || !same(s.sample, q) || !s.packet || this.now() >= s.deadline || q.action === 'confirm-export' && s.possible)) return this.#value(q, 'unavailable');
    if (q.action === 'prepare-export' && this.#records.size >= 8) return this.#value(q, 'capacity');
    if (this.#fenced(q)) return this.#value(q, 'invalidated');
    if (s && (s.ledger.has(q.invocation) || s.ledger.size >= 32)) return this.#value(q, 'unavailable');
    const started = this.now();
    const token = this.io.acquire('selected-archive', s?.reference ?? q.invocation, q.action);
    if (!token) return this.#value(q, 'busy');
    let a, timer;
    try {
      if (initial) { this.invalidate(); s = this.#new(q); }
      else if (this.#ready && this.#ready !== s) { this.#wipe(this.#ready); this.#ready = null; }
      this.beforeIO();
      if (this.#fenced(q)) return this.#value(q, 'invalidated');
      s.ledger.set(q.invocation, 'active');
      if (q.action === 'prepare-export') { this.#ready = s; this.#arm(s, 120000); return this.#value(q, 'ready', s); }
      a = { s, q, token, epoch: this.#epoch, deadline: Math.min(started + this.budgetMs, s.deadline), buffers: [] }; this.#active = a;
      const work = async () => {
        const input = this.#packet(s);
        if (!this.#current(a)) throw Error('Archive invalidated');
        if (q.action === 'confirm-export') {
          s.possible = true; s.outcome = 'unknown'; this.#ready = null; this.#records.set(s.reference, s); this.#arm(s, 1800000);
        }
        const raw = await this.#raw(a, q.action === 'confirm-export' ? 'export-selected' : 'inspect', input);
        const r = parseArchiveRaw(raw, q.action === 'confirm-export' ? 'export-selected' : 'inspect');
        if (!this.#current(a)) throw Error('Archive invalidated');
        if (q.action === 'confirm-export') {
          s.outcome = r.status === 'ok' ? r.summary.complete_media ? 'exported' : 'partial-media' : r.status === 'failed' ? 'unknown' : 'not-dispatched';
          return this.#value(q, s.outcome, s, { summary: r.summary });
        }
        if (q.action === 'check-export') {
          if (r.status === 'ok') { const state = r.summary.complete_media ? 'archive-observed' : 'incomplete-media-observed'; return this.#value(q, state, s, { summary: r.summary, check: state }); }
          return this.#value(q, 'unresolved', s, { check: 'unresolved' });
        }
        return this.#value(q, r.status === 'ok' ? r.summary.complete_media ? 'inspected' : 'partial-media' : r.status, s, { summary: r.summary });
      };
      return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { if (this.#active === a && this.io.owns(token)) { this.invalidate(); this.observer.cancel(); } reject(Error('Archive wait expired')); }, Math.max(1, a.deadline - this.now())); })]);
    } catch (e) {
      if (q.action === 'confirm-export' && s?.possible) return this.#value(q, s.outcome === 'unknown' ? 'unknown' : 'unavailable', s);
      return this.#value(q, e instanceof ArchiveUnsupported ? 'unsupported' : 'unavailable', q.action === 'check-export' ? s : null);
    } finally {
      clearTimeout(timer); if (s?.ledger.get(q.invocation) === 'active') s.ledger.set(q.invocation, 'completed');
      if (a) { for (const b of a.buffers) b.fill(0); if (this.#active === a) this.#active = null; }
      if (q.action === 'inspect' && s) this.#wipe(s);
      if (q.action === 'prepare-export' && s && this.#ready !== s) this.#wipe(s);
      this.io.release(token);
    }
  }
  async #raw(a, selector, input) {
    const budget_ms = Math.min(12000, Math.floor(a.deadline - this.now()));
    const q = { selector, input_base64: input.toString('base64'), budget_ms, connection_id: a.s.sample.connection_id, boot_id: a.s.sample.boot_id };
    if (budget_ms < 1 || input.length > 16384 || Buffer.byteLength(JSON.stringify(q)) > 24576) throw Error('Archive envelope refused');
    let v; try { v = await this.observer.run('selected-archive', q); } finally { q.input_base64 = null; }
    if (!this.#current(a)) throw Error('Archive result stale');
    if (!v || Object.keys(v).sort().join() !== 'archive_raw,contract_version,observation,status' || Buffer.byteLength(JSON.stringify(v)) > 24576) throw Error('Archive transport refused');
    validateResult({ contract_version: v.contract_version, status: v.status, observation: v.observation });
    if (v.status !== 'observed' || !same(v.observation, a.s.sample) || !v.archive_raw || Object.keys(v.archive_raw).sort().join() !== 'status,stdout_base64') throw Error('Archive transport refused');
    const r = v.archive_raw;
    if (r.status === 'unsupported' && r.stdout_base64 === null) throw new ArchiveUnsupported();
    if (r.status !== 'reported' || typeof r.stdout_base64 !== 'string') throw Error('Archive unavailable');
    const raw = Buffer.from(r.stdout_base64, 'base64'); a.buffers.push(raw);
    if (raw.length > 16384 || raw.toString('base64') !== r.stdout_base64) throw Error('Archive report refused');
    return raw;
  }
  #cancel(q) {
    const a = this.#active;
    if (a && same(a.s.sample, q) && a.q.invocation === q.invocation && (q.reference === null || a.s.reference === q.reference) && this.io.owns(a.token)) {
      const s = a.s, possible = s.possible; if (possible && s.outcome !== 'unknown') return this.#value(q, 'unavailable'); this.invalidate(); this.observer.cancel();
      return possible ? this.#value(q, 'unknown', s) : this.#value(q, 'not-dispatched');
    }
    const s = this.#ready;
    if (s && s.reference === q.reference && same(s.sample, q) && s.creator === q.invocation) { this.#wipe(s); this.#ready = null; this.#epoch++; return this.#value(q, 'invalidated'); }
    const original = this.#records.get(q.reference) ?? (this.#ready?.reference === q.reference ? this.#ready : null);
    if (original) {
      if (!same(original.sample, q) || !original.packet || original.ledger.has(q.invocation) || original.ledger.size >= 32) return this.#value(q, 'unavailable');
      original.ledger.set(q.invocation, 'fenced');
      return this.#value(q, 'not-dispatched');
    }
    if (!same(q, this.observer.lastObservation) || this.#fences.size >= 32 && !this.#fences.has(this.#key(q))) return this.#value(q, 'unavailable');
    const key = this.#key(q); if (!this.#fences.has(key)) this.#fences.set(key, this.now() + 14000);
    return this.#value(q, 'not-dispatched');
  }
}
