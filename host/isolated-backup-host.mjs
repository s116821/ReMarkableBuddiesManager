import {randomBytes} from 'node:crypto';
import {IsolatedBackupReader} from './isolated-backup-reader.mjs';
import {parseIsolatedBackupRequest, parseIsolatedBackupResult} from './isolated-backup-protocol.mjs';

const reply = (status, operation = null, backups = [], selection = null) => ({
  version: 1, status, operation, backups, selection,
});

export class IsolatedBackupHost {
  #driveAuth;
  #session = null;
  #scan = null;
  #selection = null;
  #active = null;
  #disposed = false;

  constructor({driveAuth}) {
    this.#driveAuth = driveAuth;
  }

  #discardSession() {
    const session = this.#session;
    this.#session = null;
    if (session) {
      session.authority?.removeEventListener('abort', session.invalidate);
      session.reader?.dispose();
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
  }

  #validateSession() {
    const session = this.#session;
    if (session?.binding && !session.binding.isCurrent() && this.#session === session) this.#clear();
    const selected = this.#selection;
    if (selected?.status === 'selected' && !session?.reader?.readSelection(selected.selection.reference)) {
      // An expired marker need not discard the current metadata inspection.
      if (this.#selection === selected) this.#selection = reply('invalidated', selected.operation);
    }
  }

  request(value) {
    const request = {...parseIsolatedBackupRequest(value)};
    this.#validateSession();
    const {action, operation} = request;
    if (action === 'status') {
      const state = [this.#scan, this.#selection].find(record => record?.operation === operation);
      return structuredClone(state ?? reply('invalidated', operation));
    }
    if (action === 'cancel') {
      // Once selection has started, the inspection remains context for that
      // selection but no longer owns its outstanding wait or result.
      const owner = this.#selection ?? this.#scan;
      if (owner?.operation === operation) this.#clear();
      return reply('invalidated', operation);
    }
    if (this.#disposed) return reply('invalidated');
    if (this.#active) return reply('busy');
    if (action === 'select' && (this.#scan?.status !== 'observed' ||
        request.inspection !== this.#scan.operation ||
        !this.#scan.backups.some(backup => backup.revisions.some(revision => revision.reference === request.choice)))) {
      return reply('invalidated');
    }

    const attempt = {id: randomBytes(32).toString('hex'), controller: new AbortController(), request};
    const initial = reply(action === 'scan' ? 'scanning' : 'selecting', attempt.id);
    if (action === 'scan') {
      this.#discardSession();
      this.#selection = null;
      this.#scan = initial;
    } else {
      this.#selection = initial;
    }
    this.#active = attempt;
    void this.#run(attempt);
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
      this.#validateSession();
      return this.#session === session && this.#selection === selected &&
        selected.status === 'selected' && !!session.reader.readSelection(reference);
    }});
  }

  // A new browser document drops the old view without replacing the auth owner.
  invalidate() {
    this.#clear();
  }

  dispose() {
    this.#disposed = true;
    this.#clear();
  }
}
