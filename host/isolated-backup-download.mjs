import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {strictJson} from './strict-json.mjs';

const MiB = 1024 * 1024;
const MAX_MARKER = 16384;
const MAX_MANIFEST = 8 * MiB;
const MAX_PREFERENCES = 128 * 1024;
const MAX_OBJECT = 256 * MiB;
const MAX_ITEMS = 4096;
const MAX_STAGED = 512 * MiB;
const MAX_METADATA = 64 * MiB;
const MAX_CALLS = 16384;
const PAGE_ENTRIES = 100;
const CHUNK = 64 * 1024;
const FREE_FLOOR = 256 * MiB;
const MAX_WAIT = 120000;

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const providerId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reply = (status, inspection = null, cleanupPending = false) => ({status, inspection, cleanupPending});
class DownloadFailure extends Error {}
function require(ok, status = 'invalid') {
  if (!ok) throw new DownloadFailure(status);
}

function exact(value, ...fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function uint(value, limit, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && value <= limit;
}

function objectRef(value, limit, minimum = 0) {
  return exact(value, 'bytes', 'sha256') && uint(value.bytes, limit, minimum) && digest(value.sha256);
}

function parse(bytes) {
  require(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  try { return strictJson(bytes); } catch { throw new DownloadFailure('invalid'); }
}

function inventory(bytes) {
  parse(bytes); // Check valid UTF-8 and reject duplicate members.
  // JSON.parse rounds some noninteger tokens to integers. The Rust V1
  // version and transferred object lengths use unsigned integer tokens.
  const lexicalRefusals = new WeakSet();
  const manifest = JSON.parse(new TextDecoder().decode(bytes), function (key, value, context) {
    if ((key === 'format' || key === 'bytes') && typeof value === 'number' &&
        !/^(0|[1-9][0-9]*)$/.test(context.source)) lexicalRefusals.add(this);
    return value;
  });
  require(exact(manifest, 'format', 'manifests', 'objects', 'complete_media', 'config_snapshot') &&
    !lexicalRefusals.has(manifest) && manifest.format === 1 && manifest.config_snapshot === null &&
    typeof manifest.complete_media === 'boolean' &&
    Array.isArray(manifest.manifests) && uint(manifest.manifests.length, MAX_ITEMS, 1) &&
    Array.isArray(manifest.objects) && uint(manifest.objects.length, MAX_ITEMS));
  const seen = new Set();
  for (const ref of manifest.objects) {
    require(objectRef(ref, MAX_OBJECT) && !lexicalRefusals.has(ref) && !seen.has(ref.sha256));
    seen.add(ref.sha256);
  }
  return {objects: manifest.objects, manifests: manifest.manifests.length, completeMedia: manifest.complete_media};
}

function objectIdentity(value, root, ref) {
  const properties = {buddy_isolated: '1', kind: 'object', root: root.id, backup: root.backup, sha256: ref.sha256};
  require(exact(value, 'id', 'appProperties', 'size', 'mimeType', 'trashed', 'spaces') && providerId(value.id) &&
    value.trashed === false && value.mimeType === 'application/octet-stream' && value.size === String(ref.bytes) &&
    isDeepStrictEqual(value.spaces, ['appDataFolder']) && isDeepStrictEqual(value.appProperties, properties));
  return value.id;
}

function inspectReport(bytes, selected, manifest) {
  require(bytes instanceof Uint8Array && uint(bytes.byteLength, MAX_MARKER, 2) &&
    bytes.at(-1) === 10 && bytes.indexOf(10) === bytes.length - 1, 'verification-failed');
  let report;
  try { report = parse(bytes); } catch { throw new DownloadFailure('verification-failed'); }
  const data = report?.data, value = data?.isolated_package;
  const archive = value?.data;
  require(exact(report, 'report_version', 'operation', 'status', 'incomplete', 'activation_performed', 'data') &&
    report.report_version === 1 && report.operation === 'inspect-isolated' && report.status === 'ok' &&
    report.activation_performed === false && report.incomplete === !manifest.completeMedia &&
    exact(data, 'isolated_package') &&
    exact(value, 'marker_sha256', 'data_backup', 'portable_configuration', 'declared_settings', 'data') &&
    value.marker_sha256 === selected.marker.sha256 && isDeepStrictEqual(value.data_backup, selected.components.data) &&
    isDeepStrictEqual(value.portable_configuration, selected.components.preferences) &&
    uint(value.declared_settings, 3) &&
    exact(archive, 'format', 'manifests', 'objects', 'selected_scopes', 'selection_receipts',
      'complete_media', 'configuration_included') &&
    archive.format === 1 && archive.manifests === manifest.manifests && archive.objects === manifest.objects.length &&
    archive.selected_scopes === 0 && archive.selection_receipts === 0 && archive.configuration_included === false &&
    archive.complete_media === manifest.completeMedia, 'verification-failed');
  return {markerSha256: value.marker_sha256, manifests: archive.manifests, objects: archive.objects,
    completeMedia: archive.complete_media, declaredSettings: value.declared_settings};
}

function capture({operation, reference, selection}) {
  require(digest(operation) && digest(reference) && selection?.markerBytes instanceof Uint8Array &&
    uint(selection.markerBytes.length, MAX_MARKER, 1) && providerId(selection.root?.id) &&
    typeof selection.root.backup === 'string' &&
    /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(selection.root.backup) &&
    selection.root.backup !== '00000000-0000-0000-0000-000000000000' &&
    providerId(selection.marker?.id) && selection.signal instanceof AbortSignal &&
    selection.marker.bytes === selection.markerBytes.length && selection.marker.sha256 === hash(selection.markerBytes) &&
    objectRef(selection.components?.data, MAX_MANIFEST, 1) &&
    objectRef(selection.components?.preferences, MAX_PREFERENCES, 1), 'invalidated');
  return {...structuredClone({root: selection.root, marker: selection.marker, components: selection.components}),
    markerBytes: Buffer.from(selection.markerBytes), signal: selection.signal};
}

/**
 * Private orchestration only. The protected binding is from the same selection.
 * Providers honor signal/maxBytes and stream chunks <=64 KiB. An opened stream
 * must support bounded abort and joined close through its async iterator.
 *
 * Trusted staging exposes available(), freeBytes(), create(). A stage exposes
 * root, openExclusive(relativeName), assertOwned(exactRelativeFiles), release().
 * It owns canonical parent/privacy checks, directory and file identities,
 * exclusive allocation, completed membership, and checked nonrecursive teardown.
 * create() owns rollback if it throws before returning custody; release() must
 * reject on identity changes or uncleared residue. File handles expose
 * write(Uint8Array), sync(), close() (write consumes the full supplied chunk).
 *
 * The trusted verifier exposes available() and verify({root,markerSha256,
 * maxBytes,timeoutMs,signal}), checking executable provenance and capturing one
 * bounded raw Buddy report. Its promise settles after shutdown/join.
 */
export class IsolatedBackupDownload {
  #job = null;
  #lastRetirement = null;
  #disposed = false;
  #staging;
  #verifier;
  #now;

  constructor({staging = null, verifier = null, now = () => performance.now()} = {}) {
    this.#staging = staging;
    this.#verifier = verifier;
    this.#now = now;
  }

  #check(job) {
    const {selection, current, binding, controller, deadline} = job;
    require(!this.#disposed && this.#job === job && !controller.signal.aborted && !selection.signal.aborted &&
      binding.isCurrent() === true && current() === true, 'invalidated');
    require(this.#now() < deadline, 'incomplete');
  }

  #options(job, maxBytes) {
    this.#check(job);
    return {signal: job.controller.signal, maxBytes, timeoutMs: Math.max(1, Math.ceil(job.deadline - this.#now()))};
  }

  async #authority(job) {
    await job.binding.checkCurrent(this.#options(job, 0));
    this.#check(job);
  }

  async #call(job, method, args, maxBytes) {
    const options = this.#options(job, maxBytes);
    require(job.calls < MAX_CALLS, 'incomplete');
    job.calls++;
    return job.binding[method]({...args, ...options});
  }

  async #metadata(job, method, args) {
    require(job.metadata < MAX_METADATA, 'incomplete');
    const bytes = await this.#call(job, method, args, MAX_METADATA - job.metadata);
    this.#check(job);
    require(bytes instanceof Uint8Array && bytes.length > 0);
    require(bytes.length <= MAX_METADATA - job.metadata, 'incomplete');
    job.metadata += bytes.length;
    return parse(bytes);
  }

  async #locate(job, ref) {
    const root = job.selection.root;
    let pageToken = null, candidate = null;
    const pages = new Set();
    do {
      const page = await this.#metadata(job, 'listObject', {
        rootId: root.id, backup: root.backup, sha256: ref.sha256, pageToken, maxEntries: PAGE_ENTRIES,
      });
      require((exact(page, 'files', 'incompleteSearch') || exact(page, 'files', 'incompleteSearch', 'nextPageToken')) &&
        Array.isArray(page.files) && typeof page.incompleteSearch === 'boolean');
      require(!page.incompleteSearch && page.files.length <= PAGE_ENTRIES, 'incomplete');
      for (const file of page.files) {
        require(candidate === null);
        candidate = objectIdentity(file, root, ref);
      }
      pageToken = Object.hasOwn(page, 'nextPageToken') ? page.nextPageToken : null;
      if (Object.hasOwn(page, 'nextPageToken')) {
        require(typeof pageToken === 'string' && pageToken.length > 0 && Buffer.byteLength(pageToken) <= 2048 &&
          !/[\u0000-\u001f\u007f]/.test(pageToken) && !pages.has(pageToken));
        pages.add(pageToken);
      }
    } while (pageToken !== null);
    require(candidate !== null);
    const metadata = await this.#metadata(job, 'readObjectMetadata', {id: candidate});
    require(objectIdentity(metadata, root, ref) === candidate);
    return candidate;
  }

  async #space(job, remaining) {
    const free = await this.#staging.freeBytes(job.stage?.root ?? null, this.#options(job, 0));
    this.#check(job);
    require(uint(free, Number.MAX_SAFE_INTEGER) && free >= FREE_FLOOR + remaining, 'insufficient-space');
  }

  async #write(job, name, ref, stream, collect = false) {
    const chunks = [], digest = createHash('sha256');
    let count = 0, file;
    // The stream factory is entered inside the file lifetime. A refused file
    // admission therefore never leaves a just-opened remote response unread.
    try {
      this.#check(job);
      file = await job.stage.openExclusive(name, this.#options(job, ref.bytes));
      this.#check(job);
      const source = await stream();
      for await (const chunk of source) {
        try {
          this.#check(job);
          require(chunk instanceof Uint8Array && chunk.length > 0 && chunk.length <= CHUNK &&
            count + chunk.length <= ref.bytes);
          count += chunk.length;
          digest.update(chunk);
          if (collect) chunks.push(Buffer.from(chunk));
          await file.write(chunk);
        } catch (error) {
          // Unblock the producer before for-await joins its iterator on error.
          job.controller.abort();
          throw error;
        }
      }
      this.#check(job);
      require(count === ref.bytes && digest.digest('hex') === ref.sha256);
      await file.sync();
      this.#check(job);
    } finally {
      if (file) await file.close();
    }
    this.#check(job);
    job.files.push(Object.freeze({name, bytes: ref.bytes, sha256: ref.sha256}));
    job.written += ref.bytes;
    return collect ? Buffer.concat(chunks, count) : null;
  }

  async #downloadFile(job, name, ref, collect = false) {
    const id = await this.#locate(job, ref);
    return this.#write(job, name, ref, () => this.#call(job, 'streamObject', {id, sha256: ref.sha256}, ref.bytes), collect);
  }

  async download({operation, reference, selection, current, binding}) {
    if (this.#disposed) return reply('invalidated');
    if (this.#job) return reply('busy');
    if (!this.#staging || !this.#verifier) return reply('unavailable');
    let selected;
    try { selected = capture({operation, reference, selection}); }
    catch { return reply('invalidated'); }
    const job = {operation, reference, selection: selected, current, binding, controller: new AbortController(),
      deadline: this.#now() + MAX_WAIT, calls: 0, metadata: 0, written: 0, files: [], stage: null, inspection: null};
    this.#job = job;
    job.onAbort = () => { this.#cancel(job); };
    selected.signal.addEventListener('abort', job.onAbort, {once: true});
    job.timer = setTimeout(() => {
      job.timedOut = true;
      this.#cancel(job);
    }, MAX_WAIT);
    job.timer.unref();
    job.pending = this.#run(job);
    return job.pending;
  }

  async #run(job) {
    try {
      const {selection} = job;
      this.#check(job);
      require(['checkCurrent', 'listObject', 'readObjectMetadata', 'streamObject'].every(method => typeof job.binding[method] === 'function'),
        'unavailable');
      await this.#authority(job);
      require(await this.#verifier.available(this.#options(job, 0)) === true, 'unavailable');
      require(await this.#staging.available(this.#options(job, 0)) === true, 'unavailable');
      const {data, preferences} = selection.components;
      const selectedBytes = data.bytes + preferences.bytes + selection.markerBytes.length;
      await this.#space(job, selectedBytes);
      await this.#authority(job);
      job.stage = await this.#staging.create(this.#options(job, 0));
      await this.#authority(job);
      require(typeof job.stage?.root === 'string' && path.isAbsolute(job.stage.root) &&
        path.resolve(job.stage.root) === job.stage.root, 'unavailable');

      const manifest = inventory(await this.#downloadFile(job, 'data/backup.json', data, true));
      const total = selectedBytes + manifest.objects.reduce((size, ref) => size + ref.bytes, 0);
      require(total <= MAX_STAGED, 'incomplete');
      for (const ref of manifest.objects) {
        await this.#space(job, total - job.written);
        await this.#downloadFile(job, 'data/objects/' + ref.sha256, ref);
      }
      await this.#space(job, total - job.written);
      await this.#downloadFile(job, 'portable-configuration.json', preferences);
      await this.#space(job, total - job.written);
      await this.#write(job, 'isolated-backup.json', selection.marker, () => [selection.markerBytes]);

      require(await job.stage.assertOwned(job.files.map(file => file.name), this.#options(job, 0)) === true);
      await this.#authority(job);
      const result = await this.#verifier.verify({root: job.stage.root, markerSha256: selection.marker.sha256,
        ...this.#options(job, MAX_MARKER)});
      await this.#authority(job);
      const inspection = inspectReport(result, selection, manifest);
      require(await job.stage.assertOwned(job.files.map(file => file.name), this.#options(job, 0)) === true);
      await this.#authority(job);
      this.#check(job);
      job.inspection = inspection;
      return reply('verified', {...inspection});
    } catch (error) {
      // A stage factory may lose its child after directory creation but before
      // transferring custody. No stage object then exists to prove rollback.
      job.cleanupPending = error?.cleanupPending === true;
      if (!job.controller.signal.aborted && !job.selection.signal.aborted) {
        try { this.#check(job); } catch (changed) { error = changed; }
      }
      let status = error instanceof DownloadFailure ? error.message : 'unavailable';
      if (job.selection.signal.aborted) status = 'invalidated';
      else if (job.timedOut) status = 'incomplete';
      else if (job.cancelled) status = 'invalidated';
      return reply(status, null, await this.#retire(job));
    }
  }

  #cancel(job) {
    job.cancelled = true;
    job.controller.abort();
    // While active, #run joins the stream/verifier before retiring its stage.
    if (job.inspection && !job.handoff) void this.#retire(job);
  }

  #retire(job) {
    job.retiring ??= (async () => {
      clearTimeout(job.timer);
      job.selection.signal.removeEventListener('abort', job.onAbort);
      job.controller.abort();
      job.selection.markerBytes.fill(0);
      let residue = job.cleanupPending === true;
      try { if (job.stage) await job.stage.release(); }
      catch { residue = true; }
      // Keep only a reduced residue warning. No retry or recursive cleanup is
      // attempted on an identity-changed stage.
      if (this.#job === job) {
        this.#job = null;
        this.#lastRetirement = {operation: job.operation, reference: job.reference, residue};
      }
      return residue;
    })();
    return job.retiring;
  }

  // Host-only, one-shot handoff. The recipient must honor the original
  // signal and settle after all of its file access has stopped.
  async handoff(operation, reference, consume) {
    const job = this.#job;
    if (!job?.inspection || job.handoff || job.operation !== operation || job.reference !== reference) return reply('invalidated');
    try { this.#check(job); }
    catch { this.#cancel(job); return reply('invalidated', null, await this.#retire(job)); }
    job.handoff = Promise.resolve().then(async () => {
      let status = 'handed-off';
      try {
        this.#check(job);
        require(await job.stage.assertOwned(job.files.map(file => file.name), this.#options(job, 0)) === true);
        await this.#authority(job);
        const components = Object.freeze({
          data: Object.freeze({...job.selection.components.data}),
          preferences: Object.freeze({...job.selection.components.preferences}),
        });
        await consume({root: job.stage.root, inspection: {...job.inspection},
          files: Object.freeze([...job.files]), components, ...this.#options(job, 0)});
        require(await job.stage.assertOwned(job.files.map(file => file.name), this.#options(job, 0)) === true);
        await this.#authority(job);
        this.#check(job);
      } catch {
        status = job.controller.signal.aborted ? 'invalidated' : 'unavailable';
      }
      const cleanupPending = await this.#retire(job);
      if (status === 'handed-off' && (job.cancelled || job.selection.signal.aborted ||
          !job.current() || !job.binding.isCurrent() || this.#now() >= job.deadline)) status = 'invalidated';
      return reply(status, null, cleanupPending);
    });
    return job.handoff;
  }

  async release(operation, reference) {
    const job = this.#job;
    if (!job || job.operation !== operation || job.reference !== reference) {
      const original = this.#lastRetirement;
      return reply('invalidated', null, original?.operation === operation && original.reference === reference && original.residue);
    }
    this.#cancel(job);
    await job.pending;
    if (job.handoff) await job.handoff;
    return reply('invalidated', null, await this.#retire(job));
  }

  async dispose() {
    this.#disposed = true;
    const job = this.#job;
    return job ? this.release(job.operation, job.reference) : reply('invalidated', null, this.#lastRetirement?.residue === true);
  }
}
