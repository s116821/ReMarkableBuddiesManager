import {
  ISOLATED_BACKUP_REQUEST_BYTES, parseIsolatedBackupBridgeRequest, parseIsolatedBackupBridgeResult,
} from './isolated-backup-protocol.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parsePortableRequest, portableContext, parsePortableResult} from './portable-configuration-protocol.mjs';

const sameTarget = (sample, target) => sample?.connection_id === target.connection_id && sample?.boot_id === target.boot_id;

function admittedTarget(sample, request) {
  if (!sample || !sameTarget(sample, request) || !sample.model || !sample.firmware || sample.firmware_conflict ||
      !['armv7l', 'aarch64', 'armv6l'].includes(sample.architecture)) return null;
  validateResult({contract_version: 1, status: 'observed', observation: sample});
  return {connection_id: sample.connection_id, boot_id: sample.boot_id};
}

function previewReply({operation, reference}, status, preview = null, cleanupPending = false, retryable = false) {
  return {version: 1, operation, reference, status, retryable, preview, cleanupPending};
}

export class IsolatedBackupPreferences {
  #attempt;
  #closed = false;
  #disposal;
  #deliveries = new WeakMap();

  constructor({composition, isolatedBackup, portable, observer}) {
    Object.assign(this, {composition, isolatedBackup, portable, observer});
  }

  #forget(attempt) {
    attempt.selection.removeEventListener('abort', attempt.abortSelection);
    if (this.#attempt === attempt) this.#attempt = null;
  }

  #cancel(attempt) {
    if (attempt.cancellation) return attempt.cancellation;
    const {operation} = attempt.request;
    attempt.cancellation = Promise.resolve().then(async () => {
      try {
        const [result, preview] = await Promise.allSettled([
          Promise.resolve().then(() => this.isolatedBackup.request({version: 1, action: 'cancel', operation})),
          attempt.pending,
        ]);
        const cleanupPending = result.status === 'rejected' || preview.status === 'rejected' ||
          result.value?.cleanupPending === true || preview.value?.cleanupPending === true;
        return cleanupPending
          ? {version: 1, operation, status: 'invalidated', inspection: null, cleanupPending: true}
          : result.value;
      } finally {
        this.#forget(attempt);
      }
    });
    attempt.controller.abort();
    if (attempt.issued) this.portable.discardHandoffPreview(attempt.issued);
    return attempt.cancellation;
  }

  invalidate(document) {
    const attempt = this.#attempt;
    if (attempt?.document === document) return this.#cancel(attempt);
  }

  dispose() {
    if (!this.#disposal) {
      this.#closed = true;
      const attempt = this.#attempt;
      this.#disposal = attempt ? this.#cancel(attempt) : Promise.resolve();
    }
    return this.#disposal;
  }

  request(request, {document, callerCurrent, onAbandon}) {
    if (!callerCurrent()) throw Error('Backup inspection caller refused');
    if (request.action !== 'preview-preferences') {
      const attempt = this.#attempt;
      if (request.action === 'cancel' && attempt?.document === document &&
          attempt.request.operation === request.operation) return this.#cancel(attempt);
      return this.isolatedBackup.request(request);
    }
    if (this.#closed || !this.composition?.preferencesPreviewAvailable) return previewReply(request, 'unavailable');
    if (this.#attempt) return previewReply(request, 'busy');
    const {operation, reference} = request;
    const target = admittedTarget(this.observer.lastObservation, request);
    if (!target || !this.isolatedBackup.canHandoff(operation, reference)) return previewReply(request, 'invalidated');
    const selection = this.isolatedBackup.selectionSignal(operation, reference);
    if (!selection || selection.aborted) return previewReply(request, 'invalidated');

    const attempt = {request, document, selection, controller: new AbortController(), issued: null};
    this.#attempt = attempt;
    const current = () => !this.#closed && this.#attempt === attempt && !attempt.controller.signal.aborted &&
      callerCurrent() && sameTarget(this.observer.lastObservation, target) &&
      this.isolatedBackup.isSelectionCurrent(operation, reference);
    const releaseAttempt = () => {
      if (!attempt.cancellation) this.#forget(attempt);
    };
    attempt.abortSelection = () => { void this.#cancel(attempt); };
    selection.addEventListener('abort', attempt.abortSelection, {once: true});
    onAbandon?.(() => { if (this.#attempt === attempt) void this.#cancel(attempt); });

    attempt.pending = Promise.resolve().then(async () => {
      if (!current()) return previewReply(request, 'invalidated');
      const result = await this.composition.preparePreferences(operation, reference, {
        portable: this.portable, target, signal: attempt.controller.signal, current, releaseAttempt,
      });
      if (result.status === 'ready') attempt.issued = result.preview;
      if (!current()) {
        if (attempt.issued) this.portable.discardHandoffPreview(attempt.issued);
        void this.#cancel(attempt);
        return previewReply(request, 'invalidated', null, result.cleanupPending);
      }
      const retryable = result.status === 'busy' && !result.cleanupPending &&
        this.isolatedBackup.canHandoff(operation, reference);
      return previewReply(request, result.status, result.preview, result.cleanupPending, retryable);
    });
    return attempt.pending.then(async result => {
      if (!result.preview && !result.retryable) {
        // Join outside the preparation promise, since cancellation waits for it.
        const retired = await this.#cancel(attempt);
        return {...result, cleanupPending: result.cleanupPending || retired?.cleanupPending === true};
      }
      // Preserve the issued object and original custody until synchronous adapter publication.
      this.#deliveries.set(result, {attempt, current});
      return result;
    }, async error => {
      await this.#cancel(attempt);
      throw error;
    });
  }

  deliver(value, request, callerCurrent) {
    const delivery = this.#deliveries.get(value);
    this.#deliveries.delete(value);
    try {
      if (!callerCurrent()) throw Error('Backup inspection caller refused');
      const result = parseIsolatedBackupBridgeResult(value, request);
      if (delivery) {
        if (!delivery.current()) {
          throw Error('Backup preferences preview invalidated');
        }
        if (result.preview) this.portable.assertCurrent(result.preview);
      }
      if (delivery && result.status !== 'ready') this.#forget(delivery.attempt);
      return result;
    } catch (error) {
      if (delivery) void this.#cancel(delivery.attempt);
      throw error;
    }
  }
}

export function isManagerMainFrame(event, window, uiUrl, closing) {
  const frame = event.senderFrame;
  return !closing && !window.isDestroyed() && !!frame && event.sender === window.webContents &&
    frame === window.webContents.mainFrame && frame.url === uiUrl;
}

export function watchBackupDocument(window, invalidate) {
  let document = Symbol();
  const change = () => {
    const original = document;
    document = Symbol();
    invalidate(original);
  };
  window.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) change();
  });
  window.webContents.on('render-process-gone', change);
  return () => document;
}

export function registerIsolatedBackupHandler(ipcMain, authorized, document, preferences) {
  ipcMain.handle('manager:isolated-backup', async (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw Error('Backup inspection caller refused');
    const request = parseIsolatedBackupBridgeRequest(args[0]);
    if (Buffer.byteLength(JSON.stringify(request)) > ISOLATED_BACKUP_REQUEST_BYTES) throw Error('Backup inspection input refused');
    const original = document();
    const callerCurrent = () => original === document() && authorized(event, []);
    const value = await preferences.request(request, {document: original, callerCurrent});
    return preferences.deliver(value, request, callerCurrent);
  });
}

export function registerPortableConfigurationHandler(ipcMain, authorized, portable) {
  ipcMain.handle('manager:portableConfiguration', async (event, ...args) => {
    if (!authorized(event, []) || args.length !== 1) throw Error('Portable preferences caller refused');
    let request = parsePortableRequest(args[0]);
    args.length = 0;
    const context = portableContext(request), pending = portable.request(request);
    request = null;
    const value = parsePortableResult(await pending, context, validateResult);
    return portable.assertCurrent(value);
  });
}
