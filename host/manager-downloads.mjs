import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { quarantineManagerRelease } from './quarantine.mjs';
import { downloadState, parseDownloadRequest } from './manager-download-protocol.mjs';

export class ManagerDownloads {
  constructor({ parent = process.env.MANAGER_DOWNLOAD_PARENT, python = process.env.MANAGER_DOWNLOAD_PYTHON, consumer = quarantineManagerRelease } = {}) {
    this.parent = parent; this.python = python; this.consumer = consumer; this.state = downloadState(); this.active = null; this.disposed = false;
  }
  async setup() {
    for (const value of [this.parent,this.python]) if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value)) throw new Error('setup');
    if (await realpath(this.parent) !== this.parent || !(await lstat(this.parent)).isDirectory() || !(await lstat(await realpath(this.python))).isFile()) throw new Error('setup');
  }
  async request(value) {
    const q = parseDownloadRequest(value);
    if (q.action === 'cancel') {
      if (this.active && q.operation_id === this.active.id) { this.state = { ...this.state, status: 'cancelling' }; this.active.controller.abort(); }
      return { ...this.state };
    }
    if (q.action === 'status') {
      if (!this.state.operation_id && !this.active) {
        try { await this.setup(); if (!this.state.operation_id && !this.active) this.state = downloadState(this.disposed ? 'unconfigured' : 'idle'); }
        catch { if (!this.state.operation_id && !this.active) this.state = downloadState(); }
      }
      return { ...this.state };
    }
    if (this.active || this.disposed) throw new Error('Download start refused');
    // Reserve admission before any awaited setup so concurrent starts cannot race.
    const attempt = { controller: new AbortController(), id: null }; this.active = attempt;
    try { await this.setup(); } catch { if (this.active === attempt) this.active = null; this.state = downloadState(); return { ...this.state }; }
    if (attempt.controller.signal.aborted || this.disposed) { this.active = null; this.state = downloadState(); return { ...this.state }; }
    const id = randomBytes(32).toString('hex'); attempt.id = id;
    this.state = { ...downloadState('downloading'), operation_id: id, tag: q.tag, folder: `manager-download-${id}` };
    const initial = { ...this.state };
    attempt.promise = this.run(attempt, initial);
    return initial;
  }
  async run(attempt, initial) {
    let output;
    try { output = await this.consumer({ tag: initial.tag, directory: join(this.parent, initial.folder), python: this.python, signal: attempt.controller.signal }); }
    catch { output = { ok: false }; }
    if (this.active !== attempt) return;
    const r = output?.receipt;
    // The fixed consumer owns cryptographic checks; this checks its receipt identity/limits, not a new verifier.
    const complete = output?.ok === true && r?.state === 'manager-bundles-quarantined' && r.repository === 's116821/ReMarkableBuddiesManager' && r.tag === initial.tag &&
      typeof r.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(r.sourceSha) && r.checksumAgreement === true && r.embeddedIdentityVerified === true &&
      r.updateEligible === false && r.apkInstallEligible === false && r.archivesExtracted === false && r.payloadSafetyVerified === false && r.signatureVerified === false && r.reuseRequiresReverification === true;
    // Successful receipt commits even when cancellation arrives after its atomic issuance.
    this.state = complete ? { ...initial, status: 'complete', source_sha: r.sourceSha } :
      { ...initial, status: attempt.controller.signal.aborted ? 'cancelled' : 'failed', error: attempt.controller.signal.aborted ? 'cancelled' : 'download-refused', incomplete: output?.incompleteQuarantine === true };
    this.active = null;
  }
  dispose() { this.disposed = true; this.active?.controller.abort(); }
}
