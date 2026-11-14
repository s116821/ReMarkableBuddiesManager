import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {strictJson} from './strict-json.mjs';

const helper = fileURLToPath(new URL('./isolated-backup-staging.py', import.meta.url));
const unavailable = () => new Error('Private backup staging unavailable');
const STAGE_NAME = /^isolated-backup-[a-f0-9]{32}$/;
const TIMEOUT = 5000;
const READ_CHUNK = 64 * 1024;
const READ_RESPONSE = Math.ceil(READ_CHUNK / 3) * 4 + 64;
const cleanupUncertain = () => Object.assign(unavailable(), {cleanupPending: true});

function trustedPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
}

class StagingProcess {
  #child;
  #pending = null;
  #stdout = Buffer.alloc(0);
  #closed = false;
  #exited;
  #stopping;

  constructor(python, parent, exclusions) {
    this.#child = spawn(python, ['-I', '-B', helper, parent, JSON.stringify(exclusions)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8'},
    });
    this.#exited = new Promise(resolve => {
      this.#child.once('close', (code, signal) => {
        this.#closed = true;
        this.#fail();
        resolve({code, signal});
      });
    });
    this.#child.on('error', () => { this.#closed = true; this.#fail(); });
    this.#child.stdin.on('error', () => this.#terminate());
    this.#child.stderr.on('data', () => this.#terminate());
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
  }

  #finish(error, value) {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  #fail() {
    this.#finish(unavailable());
  }

  #terminate() {
    this.#closed = true;
    this.#fail();
    this.#child.kill();
  }

  #receive(chunk) {
    if (!this.#pending || chunk.length + this.#stdout.length > this.#pending.responseLimit) {
      this.#terminate();
      return;
    }
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    const newline = this.#stdout.indexOf(10);
    if (newline < 0) return;
    let frame;
    try {
      if (newline !== this.#stdout.length - 1) throw unavailable();
      frame = strictJson(this.#stdout);
      if (frame?.ok === false && Object.keys(frame).length === 1) {
        this.#fail();
        return;
      }
      if (Object.keys(frame).sort().join() !== 'ok,value' || frame.ok !== true) throw unavailable();
    } catch {
      this.#terminate();
      return;
    } finally {
      this.#stdout = Buffer.alloc(0);
    }
    this.#finish(null, frame.value);
  }

  call(request, timeoutMs = TIMEOUT, responseLimit = 8192) {
    if (this.#closed || this.#pending) return Promise.reject(unavailable());
    const input = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(input) > 400000) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#terminate();
      }, Math.min(TIMEOUT, Math.max(1, timeoutMs)));
      this.#pending = {resolve, reject, timer, responseLimit};
      this.#child.stdin.write(input);
    });
  }

  async stop() {
    this.#stopping ??= Promise.resolve().then(async () => {
      this.#closed = true;
      this.#child.stdin.end();
      const timer = setTimeout(() => this.#child.kill(), TIMEOUT);
      try { return await this.#exited; }
      finally { clearTimeout(timer); }
    });
    return this.#stopping;
  }

  async joinClosed() {
    if (this.#closed) await this.#exited;
  }
}

export class IsolatedBackupStaging {
  #python;
  #parent;
  #exclusions;
  #active = null;

  constructor({python = null, parent = null, excludedRoots = []} = {}) {
    if (trustedPath(python) && trustedPath(parent) && Array.isArray(excludedRoots) &&
        excludedRoots.length > 0 && excludedRoots.length <= 16 && excludedRoots.every(trustedPath)) {
      this.#python = python;
      this.#parent = parent;
      this.#exclusions = [...excludedRoots];
    }
  }

  #start(bounds) {
    bounds.signal.throwIfAborted();
    if (!this.#python) throw unavailable();
    return new StagingProcess(this.#python, this.#parent, this.#exclusions);
  }

  async #probe(action, bounds) {
    const process = this.#start(bounds);
    try {
      const value = await process.call({action}, bounds.timeoutMs);
      bounds.signal.throwIfAborted();
      return value;
    } finally { await process.stop(); }
  }

  async available(bounds) {
    if (this.#active) return false;
    try { return await this.#probe('probe', bounds) === true; }
    catch { return false; }
  }

  async freeBytes(root, bounds) {
    if (root === null) return this.#probe('free', bounds);
    if (!this.#active || root !== this.#active.root || this.#active.reader) throw unavailable();
    bounds.signal.throwIfAborted();
    return this.#active.process.call({action: 'free'}, bounds.timeoutMs);
  }

  async create(bounds) {
    if (this.#active) throw unavailable();
    const process = this.#start(bounds);
    const active = {process};
    this.#active = active;
    try {
      active.root = await process.call({action: 'create'}, bounds.timeoutMs);
      if (!trustedPath(active.root) || path.dirname(active.root) !== this.#parent ||
          !STAGE_NAME.test(path.basename(active.root))) throw unavailable();
      return {
        root: active.root,
        openExclusive: (name, options) => this.#open(active, name, options),
        assertOwned: (files, options) => this.#assert(active, files, options),
        readVerified: (member, files, bounds, write) => this.#read(active, member, files, bounds, write),
        release: () => this.#release(active),
      };
    } catch {
      // Only exit zero establishes that the broker ran its checked teardown.
      // A killed or failed broker may already have created an owned directory.
      let clean = false;
      try {
        const exit = await process.stop();
        clean = exit.code === 0 && exit.signal === null;
      } finally {
        if (this.#active === active) this.#active = null;
        if (!clean) throw cleanupUncertain();
      }
      throw unavailable();
    }
  }

  async #open(active, name, options) {
    if (this.#active !== active || active.file || active.reader || active.release) throw unavailable();
    options.signal.throwIfAborted();
    await active.process.call({action: 'open', name, maxBytes: options.maxBytes}, options.timeoutMs);
    let closed = false;
    const file = {
      async write(chunk) {
        if (closed || !(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength > 65536) throw unavailable();
        options.signal.throwIfAborted();
        await active.process.call({action: 'write', bytes: Buffer.from(chunk).toString('base64')});
      },
      async sync() {
        if (closed) throw unavailable();
        options.signal.throwIfAborted();
        await active.process.call({action: 'sync'});
      },
      async close() {
        if (closed) return;
        closed = true;
        try { await active.process.call({action: 'close'}); }
        finally { active.file = null; }
      },
    };
    active.file = file;
    return file;
  }

  async #assert(active, files, options) {
    if (this.#active !== active || active.file || active.reader || active.release) return false;
    options.signal.throwIfAborted();
    try { return await active.process.call({action: 'assert', files}, options.timeoutMs) === true; }
    catch { return false; }
  }

  async #read(active, member, files, bounds, write) {
    if (this.#active !== active || active.file || active.reader || active.release) throw unavailable();
    let opened = false, bytes = 0;
    const hash = createHash('sha256');
    active.reader = true;
    const call = (request, limit) => {
      const {signal, timeoutMs} = bounds();
      signal.throwIfAborted();
      return active.process.call(request, timeoutMs, limit);
    };
    try {
      if (await call({action: 'open-read', name: member.name, files}) !== true) throw unavailable();
      opened = true;
      for (;;) {
        const encoded = await call({action: 'read'}, READ_RESPONSE);
        if (encoded === null) {
          opened = false;
          break;
        }
        bounds().signal.throwIfAborted();
        if (typeof encoded !== 'string') throw unavailable();
        const chunk = Buffer.from(encoded, 'base64');
        if (!chunk.length || chunk.length > READ_CHUNK || chunk.toString('base64') !== encoded ||
            chunk.length > member.bytes - bytes) throw unavailable();
        bytes += chunk.length;
        hash.update(chunk);
        await write(chunk);
      }
      bounds().signal.throwIfAborted();
      if (bytes !== member.bytes || hash.digest('hex') !== member.sha256) throw unavailable();
    } finally {
      try {
        if (opened && await active.process.call({action: 'close-read'}) !== true) throw unavailable();
      } catch {
        // An unacknowledged close leaves the original file handle in doubt.
        await active.process.stop();
        throw cleanupUncertain();
      } finally {
        await active.process.joinClosed();
        active.reader = false;
      }
    }
  }

  async #release(active) {
    if (active.release) return active.release;
    if (this.#active !== active || active.file || active.reader) throw unavailable();
    active.release = (async () => {
      try { await active.process.call({action: 'release'}); }
      finally {
        await active.process.stop();
        if (this.#active === active) this.#active = null;
      }
    })();
    return active.release;
  }
}
