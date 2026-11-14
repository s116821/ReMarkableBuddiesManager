import {createHash, randomBytes} from 'node:crypto';
import {strictJson} from './strict-json.mjs';

const PAGE_ENTRIES = 100;
const TOTAL_ENTRIES = 4096;
const TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DATA_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PREFERENCES_BYTES = 128 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_CALLS = 128;
const TIMEOUT_MS = 60000;
const SELECTION_MS = 120000;
const ROOT_FIELDS = 'backup,buddy_isolated,device,grant,kind,root';
const MARKER_FIELDS = 'backup,buddy_isolated,kind,predecessor,root,sha256';
const FILE_FIELDS = 'appProperties,id,mimeType,size,spaces,trashed';
const opaque = () => randomBytes(32).toString('hex');
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
const json = bytes => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('invalid');
  try { return strictJson(bytes); } catch { fail('invalid'); }
};
class ReaderFailure extends Error {}
function fail(status) {
  throw new ReaderFailure(status);
}

function metadata(value, kind, root = null) {
  if (keys(value) !== FILE_FIELDS || !id(value.id) || value.trashed !== false ||
      value.mimeType !== 'application/octet-stream' || !Array.isArray(value.spaces) ||
      value.spaces.length !== 1 || value.spaces[0] !== 'appDataFolder') fail('invalid');

  const properties = value.appProperties;
  if (keys(properties) !== (kind === 'root' ? ROOT_FIELDS : MARKER_FIELDS) ||
      properties.buddy_isolated !== '1' || properties.kind !== kind || !uuid(properties.backup) ||
      !Object.entries(properties).every(([key, member]) => typeof member === 'string' &&
        Buffer.byteLength(key) + Buffer.byteLength(member) <= 124)) fail('invalid');

  if (kind === 'root') {
    if (properties.root !== value.id || !uuid(properties.device) || !digest(properties.grant) || value.size !== '0') fail('invalid');
    return {id: value.id, backup: properties.backup, device: properties.device, grant: properties.grant};
  }
  if (properties.root !== root.id || properties.backup !== root.backup || !id(properties.predecessor) ||
      !digest(properties.sha256) || typeof value.size !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value.size) ||
      Number(value.size) > MAX_MARKER_BYTES) fail('invalid');
  return {id: value.id, predecessor: properties.predecessor, sha256: properties.sha256, bytes: Number(value.size)};
}

function orderedRevisions(root, markers) {
  const children = new Map();
  for (const marker of markers) {
    if (children.has(marker.predecessor)) fail('invalid');
    children.set(marker.predecessor, marker);
  }
  const chain = [];
  let position = root.id;
  while (children.has(position)) {
    const marker = children.get(position);
    chain.push(marker);
    children.delete(position);
    position = marker.id;
  }
  // Anything unreachable from the root is a disconnected chain or cycle.
  if (children.size) fail('invalid');
  return chain;
}

function markerComponents(raw, expected) {
  if (raw.length !== expected.bytes || createHash('sha256').update(raw).digest('hex') !== expected.sha256) fail('invalid');
  const marker = json(raw);
  if (keys(marker) !== 'data_backup,isolated_backup_version,portable_configuration') fail('invalid');

  // JSON.parse turns 1.0, 1e0 and rounded decimals into integers. Buddy's
  // unsigned fields require integer tokens. Ignore string contents here.
  const tokens = new TextDecoder().decode(raw).match(/"(?:[^"\\]|\\[\s\S])*"|-?[0-9][0-9.eE+-]*/g);
  const numbers = tokens.filter(token => token[0] !== '"');
  if (numbers.length !== 3 || numbers.some(token => !/^[1-9][0-9]*$/.test(token))) fail('invalid');
  if (!Number.isInteger(marker.isolated_backup_version) || marker.isolated_backup_version < 1 ||
      marker.isolated_backup_version > 0xffffffff) fail('invalid');
  if (marker.isolated_backup_version !== 1) fail('unsupported');

  for (const [reference, limit] of [[marker.data_backup, MAX_DATA_MANIFEST_BYTES],
    [marker.portable_configuration, MAX_PREFERENCES_BYTES]]) {
    if (keys(reference) !== 'bytes,sha256' || !Number.isSafeInteger(reference.bytes) ||
        reference.bytes < 1 || reference.bytes > limit || !digest(reference.sha256)) fail('invalid');
  }
  return {data: marker.data_backup, preferences: marker.portable_configuration};
}

function scanStatus(status, backups = []) {
  return {status, backups};
}

function selectionStatus(status, selection = null) {
  return {status, selection};
}

/**
 * Private host reader. The constructor's qualified binding represents one
 * protected read generation and exposes only isCurrent(), list(),
 * readMetadata() and readMarker(). Read methods return bounded UTF-8 bytes
 * and must honor their signal and maxBytes before buffering a response.
 * A missing production binding deliberately makes the reader unqualified.
 */
export class IsolatedBackupReader {
  #binding;
  #now;
  #timeoutMs;
  #active = null;
  #inspection = null;
  #selected = null;
  #disposed = false;

  constructor({binding = null, now = () => performance.now(), timeoutMs = TIMEOUT_MS} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid backup reader timeout');
    this.#binding = binding;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  cancel() {
    const previous = this.#active;
    this.#active = null;
    this.#inspection = null;
    this.#clearSelection();
    previous?.controller.abort(new ReaderFailure('invalidated'));
  }

  dispose() {
    this.#disposed = true;
    this.cancel();
  }

  #clearSelection() {
    const previous = this.#selected;
    this.#selected = null;
    if (previous) {
      clearTimeout(previous.timer);
      previous.raw.fill(0);
      previous.controller.abort();
    }
  }

  #current() {
    if (this.#disposed) return false;
    try { return this.#binding?.isCurrent() === true; } catch { return false; }
  }

  #check(work) {
    if (work.controller.signal.aborted) throw work.controller.signal.reason;
    if (this.#active !== work || !this.#current()) fail('invalidated');
    if (this.#now() >= work.deadline) fail('incomplete');
  }

  // At most one in-flight operation uses a binding. A scan supersedes the old
  // scan or selection, including when a binding does not resolve promptly.
  async #execute(handler, publish, status) {
    const controller = new AbortController();
    const work = {controller, deadline: this.#now() + this.#timeoutMs, calls: 0, bytes: 0, entries: 0};
    this.#active = work;
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, {once: true});
    });
    const timer = setTimeout(() => controller.abort(new ReaderFailure('incomplete')), this.#timeoutMs);
    try {
      this.#check(work);
      const value = await Promise.race([handler(work), stopped]);
      this.#check(work);
      return publish(value);
    } catch (error) {
      let failure = error;
      try { this.#check(work); } catch (cause) { failure = cause; }
      if (this.#active === work) this.cancel();
      return status(failure instanceof ReaderFailure ? failure.message : 'unavailable');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (this.#active === work) this.#active = null;
    }
  }

  async #read(work, method, query, bound = TOTAL_BYTES) {
    this.#check(work);
    const maxBytes = Math.min(bound, TOTAL_BYTES - work.bytes);
    if (work.calls >= MAX_CALLS || maxBytes < 1) fail('incomplete');
    work.calls++;
    const result = await this.#binding[method]({...query, maxBytes, signal: work.controller.signal,
      timeoutMs: Math.max(1, Math.ceil(work.deadline - this.#now()))});
    this.#check(work);
    if (!(result instanceof Uint8Array) || result.byteLength === 0) fail('invalid');
    if (result.byteLength > maxBytes) fail(maxBytes < bound || method !== 'readMarker' ? 'incomplete' : 'invalid');
    work.bytes += result.byteLength;
    return Buffer.from(result);
  }

  async #list(work, kind, root, ids) {
    const files = [];
    const seen = new Set();
    let pageToken = null;
    do {
      const value = json(await this.#read(work, 'list', {kind, rootId: root?.id ?? null, pageToken, maxEntries: PAGE_ENTRIES}));
      if (!['files,incompleteSearch', 'files,incompleteSearch,nextPageToken'].includes(keys(value)) ||
          !Array.isArray(value.files) || typeof value.incompleteSearch !== 'boolean') fail('invalid');
      if (value.incompleteSearch || value.files.length > PAGE_ENTRIES ||
          work.entries + value.files.length > TOTAL_ENTRIES) fail('incomplete');
      work.entries += value.files.length;
      for (const entry of value.files) {
        const file = metadata(entry, kind, root);
        if (ids.has(file.id)) fail('invalid');
        ids.add(file.id);
        files.push(file);
      }
      pageToken = null;
      if (Object.hasOwn(value, 'nextPageToken')) {
        pageToken = value.nextPageToken;
        if (typeof pageToken !== 'string' || pageToken.length === 0 || Buffer.byteLength(pageToken) > 2048 ||
            /[\u0000-\u001f\u007f]/.test(pageToken) || seen.has(pageToken)) fail('invalid');
        seen.add(pageToken);
      }
    } while (pageToken !== null);
    return files;
  }

  async inspect() {
    this.cancel();
    if (this.#disposed) return scanStatus('invalidated');
    if (!this.#binding) return scanStatus('unqualified');
    if (!this.#current()) return scanStatus('unavailable');
    return this.#execute(async work => {
      const ids = new Set(), backups = new Set(), choices = new Map(), view = [];
      const roots = await this.#list(work, 'root', null, ids);
      for (const root of roots) {
        if (backups.has(root.backup)) fail('invalid');
        backups.add(root.backup);
        const markers = await this.#list(work, 'marker', root, ids);
        const chain = orderedRevisions(root, markers);
        let predecessorReference = null;
        const revisions = chain.map((marker, index) => {
          const reference = opaque();
          choices.set(reference, {root, marker});
          const revision = {reference, sha256: marker.sha256, predecessorReference,
            newestObserved: index === chain.length - 1};
          predecessorReference = reference;
          return revision;
        });
        view.push({backup: root.backup, device: root.device, revisions});
      }
      return {choices, view};
    }, ({choices, view}) => {
      this.#inspection = {choices};
      return scanStatus(choices.size ? 'observed' : 'empty', view);
    }, scanStatus);
  }

  async select(reference) {
    if (!this.#current()) {
      this.cancel();
      return selectionStatus('invalidated');
    }
    if (this.#active) return selectionStatus('busy');
    const choice = digest(reference) && this.#inspection?.choices.get(reference);
    if (!choice) return selectionStatus('invalidated');

    this.#clearSelection();
    const {root, marker} = choice;
    return this.#execute(async work => {
      const observedRoot = metadata(json(await this.#read(work, 'readMetadata', {kind: 'root', id: root.id})), 'root');
      if (observedRoot.id !== root.id || observedRoot.backup !== root.backup ||
          observedRoot.device !== root.device || observedRoot.grant !== root.grant) fail('invalid');
      const observedMarker = metadata(json(await this.#read(work, 'readMetadata', {kind: 'marker', id: marker.id})), 'marker', root);
      if (observedMarker.id !== marker.id || observedMarker.predecessor !== marker.predecessor ||
          observedMarker.bytes !== marker.bytes || observedMarker.sha256 !== marker.sha256) fail('invalid');
      const raw = await this.#read(work, 'readMarker', {id: marker.id}, MAX_MARKER_BYTES);
      return {raw, components: markerComponents(raw, marker)};
    }, ({raw, components}) => {
      const handle = opaque();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        if (this.#selected?.handle === handle) this.#clearSelection();
      }, SELECTION_MS);
      timer.unref?.();
      this.#selected = {handle, controller, timer, expires: this.#now() + SELECTION_MS, root, marker, raw, components};
      return selectionStatus('selected', {reference: handle, backup: root.backup, device: root.device, sha256: marker.sha256});
    }, selectionStatus);
  }

  // Host-only future download seam. Callers must revalidate selection and
  // protected authority around their own reads, and honor invalidation.
  readSelection(reference) {
    if (!this.#current()) {
      this.cancel();
      return null;
    }
    const selected = this.#selected;
    if (selected && this.#now() >= selected.expires) this.#clearSelection();
    if (!this.#selected || reference !== selected.handle) return null;
    return {
      root: {...selected.root}, marker: {...selected.marker}, components: structuredClone(selected.components),
      markerBytes: Buffer.from(selected.raw), signal: selected.controller.signal,
    };
  }
}
