import {randomBytes} from 'node:crypto';
import {IsolatedBackupReader} from './isolated-backup-reader.mjs';
import {parseIsolatedBackupRequest, parseIsolatedBackupResult} from './isolated-backup-protocol.mjs';

const reply = (status, operation = null, backups = [], selection = null) => ({
  version: 1, status, operation, backups, selection,
});
const downloadReply = (operation, status, inspection = null, cleanupPending = false) => ({
  version: 1, operation, status, inspection, cleanupPending,
});

export class IsolatedBackupHost {
  #driveAuth;
  #session = null;
  #scan = null;
  #selection = null;
  #download = null;
  #downloadSelection;
  #releaseSelection;
  #active = null;
  #disposed = false;
  #pending = new Set();
  #disposal;

  constructor({driveAuth, downloadSelection, releaseSelection}) {
    this.#driveAuth = driveAuth;
    this.#downloadSelection = downloadSelection;
    this.#releaseSelection = releaseSelection;
  }

  #join(pending) {
    this.#pending.add(pending);
    const settled = () => this.#pending.delete(pending);
    void pending.then(settled, settled);
  }

  #discardSession() {
    const session = this.#session;
    this.#session = null;
    if (session) {
      session.authority?.removeEventListener('abort', session.invalidate);
      this.#join(session.reader.dispose());
      session.controller.abort();
    }
  }

  #clear(status = 'invalidated') {
    const active = this.#active;
    this.#active = null;
    this.#discardSession();
    if (this.#scan) this.#scan = reply(status, this.#scan.operation);
    if (this.#selection) this.#selection = reply(status, this.#selection.operation);
    if (active) active.controller.abort();
    this.#retireDownload();
  }

  #validateSession() {
    const session = this.#session;
    if (session?.binding && !session.binding.isCurrent() && this.#session === session) this.#clear();
    const selected = this.#selection;
    if (selected?.status === 'selected' && !session?.reader.isSelectionCurrent(selected.selection.reference)) {
      // An expired marker need not discard the current metadata inspection.
      if (this.#selection === selected) {
        this.#selection = reply('invalidated', selected.operation);
        this.#retireDownload();
      }
    }
  }

  #retireDownload() {
    const download = this.#download;
    if (!download || download.retirement) return download?.retirement;
    download.retirement = Promise.resolve().then(async () => {
      let cleanupPending = false;
      try {
        const result = await this.#releaseSelection?.(download.operation, download.reference);
        cleanupPending ||= result?.cleanupPending === true;
      } catch {
        cleanupPending = true;
      }
      await download.pending;
      download.result = downloadReply(download.operation, 'invalidated', null,
        cleanupPending || download.result.cleanupPending || download.cleanupPending);
      download.retired = true;
      return {...download.result};
    });
    this.#join(download.retirement);
    return download.retirement;
  }

  #startDownload(request) {
    const {operation, reference} = request;
    const selected = this.#selection;
    if (this.#disposed || selected?.status !== 'selected' ||
        selected.operation !== operation || selected.selection.reference !== reference) {
      return downloadReply(operation, 'invalidated');
    }
    const previous = this.#download;
    if (previous?.operation === operation) return downloadReply(operation, 'invalidated');
    if (this.#active || (previous && !previous.retired)) return downloadReply(operation, 'busy');
    const attempt = {operation, reference, cleanupPending: false, result: downloadReply(operation, 'downloading')};
    this.#download = attempt;
    attempt.pending = this.#runDownload(attempt);
    this.#join(attempt.pending);
    return {...attempt.result};
  }

  async #runDownload(attempt) {
    await Promise.resolve();
    if (attempt.retirement) return;
    try {
      const result = await this.#downloadSelection?.(attempt.operation, attempt.reference);
      if (result?.cleanupPending === true) attempt.cleanupPending = true;
      if (attempt.retirement) return;
      this.#validateSession();
      if (!attempt.retirement) {
        attempt.result = result ? parseIsolatedBackupResult(downloadReply(attempt.operation,
          result.status, result.inspection, result.cleanupPending)) :
          downloadReply(attempt.operation, 'unavailable');
      }
    } catch {
      if (!attempt.retirement) attempt.result = downloadReply(attempt.operation, 'unavailable', null, attempt.cleanupPending);
    }
  }

  request(value) {
    const request = {...parseIsolatedBackupRequest(value)};
    this.#validateSession();
    const {action, operation} = request;
    if (action === 'download') return this.#startDownload(request);
    const download = this.#download;
    if (action === 'status') {
      if (download?.operation === operation) return download.retirement?.then(result => ({...result})) ??
        structuredClone(download.result);
      const state = [this.#scan, this.#selection].find(record => record?.operation === operation);
      return structuredClone(state ?? reply('invalidated', operation));
    }
    if (action === 'cancel') {
      // Once selection has started, the inspection remains context for that
      // selection but no longer owns its outstanding wait or result.
      const owner = this.#selection ?? this.#scan;
      if (owner?.operation === operation) this.#clear();
      if (download?.operation === operation) return this.#retireDownload().then(result => ({...result}));
      return reply('invalidated', operation);
    }
    if (this.#disposed) return reply('invalidated');
    if (this.#active || (download?.result.status === 'downloading' && !download.retirement)) return reply('busy');
    if (action === 'select' && (this.#scan?.status !== 'observed' ||
        request.inspection !== this.#scan.operation ||
        !this.#scan.backups.some(backup => backup.revisions.some(revision => revision.reference === request.choice)))) {
      return reply('invalidated');
    }

    const attempt = {id: randomBytes(32).toString('hex'), controller: new AbortController(), request};
    const initial = reply(action === 'scan' ? 'scanning' : 'selecting', attempt.id);
    this.#retireDownload();
    if (action === 'scan') {
      this.#discardSession();
      this.#selection = null;
      this.#scan = initial;
    } else {
      this.#selection = initial;
    }
    this.#active = attempt;
    this.#join(this.#run(attempt));
    return structuredClone(initial);
  }

  async #run(attempt) {
    let result;
    try {
      // Return the operation reference before admitting any asynchronous work.
      await Promise.resolve();
      if (this.#active !== attempt) return;
      if (attempt.request.action === 'scan') {
        result = await this.#inspect(attempt);
      } else {
        const selected = await this.#session.reader.select(attempt.request.choice);
        result = reply(selected.status, attempt.id, [], selected.selection);
      }
      if (this.#active !== attempt) return;
      result = parseIsolatedBackupResult(result, attempt.request);
    } catch {
      if (this.#active !== attempt) return;
      result = reply('unavailable', attempt.id);
    }

    if (attempt.request.action === 'scan') {
      this.#scan = result;
      if (result.status !== 'observed' && result.status !== 'empty') this.#discardSession();
    } else {
      this.#selection = result;
      if (result.status !== 'selected') {
        this.#discardSession();
        this.#scan = reply('invalidated', this.#scan.operation);
      }
    }
    this.#active = null;
  }

  async #inspect(attempt) {
    const opened = this.#driveAuth.openBackupRead(attempt.controller.signal);
    if (opened.status !== 'qualified') return reply(opened.status, attempt.id);
    const {binding, signal: authority} = opened;
    const reader = new IsolatedBackupReader({binding});
    const session = {reader, binding, authority, controller: attempt.controller, invalidate: () => {
      if (this.#session === session) this.#clear();
    }};
    this.#session = session;
    authority.addEventListener('abort', session.invalidate, {once: true});
    if (authority.aborted) {
      this.#clear();
      return reply('invalidated', attempt.id);
    }
    const scan = await reader.inspect();
    return reply(scan.status, attempt.id, scan.backups);
  }

  // Future host-owned download orchestration uses this seam, never IPC.
  readSelection(operation, reference) {
    this.#validateSession();
    if (this.#selection?.status !== 'selected' || this.#selection.operation !== operation ||
        this.#selection.selection.reference !== reference) return null;
    return this.#session.reader.readSelection(reference);
  }

  // Host-only: download reuses both the original selection and its protected
  // read binding. No additional factory call, grant or marker is admitted.
  captureDownload(operation, reference) {
    const selection = this.readSelection(operation, reference);
    if (!selection) return null;
    const session = this.#session, selected = this.#selection;
    return Object.freeze({operation, reference, selection, binding: session.binding, current: () => {
      return !this.#disposed && this.#session === session && this.#selection === selected &&
        selected.status === 'selected' && !selection.signal.aborted && !session.authority.aborted;
    }});
  }

  // A new browser document drops the old view without replacing the auth owner.
  invalidate() {
    this.#clear();
  }

  dispose() {
    if (!this.#disposal) {
      this.#disposal = Promise.resolve().then(async () => { await Promise.allSettled(this.#pending); });
      this.#disposed = true;
      this.#clear();
    }
    return this.#disposal;
  }
}
