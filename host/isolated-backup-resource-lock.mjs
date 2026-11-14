import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(new URL('./isolated-backup-resource-lock.py', import.meta.url));
const unavailable = () => Error('Windows oracle resource lock unavailable');

class ResourceLock {
  #child;
  #closed;
  #lost = new AbortController();
  #pending;
  #releasing = false;

  constructor(child) {
    this.#child = child;
    const lose = () => this.#lost.abort(unavailable());
    this.#closed = new Promise(resolve => {
      child.once('close', (code, signal) => {
        if (!this.#releasing || code !== 0 || signal !== null) lose();
        resolve();
      });
    });
    child.once('exit', () => { if (!this.#releasing) lose(); });
    child.on('error', lose);
    child.stdin.on('error', lose);
    child.stderr.on('error', lose);
    child.stderr.on('data', lose);
    child.stdout.on('error', lose);
    child.stdout.on('end', () => { if (!this.#releasing) lose(); });
    child.stdout.on('data', chunk => {
      const reply = this.#pending;
      if (!reply || chunk.length > reply.expected.length - reply.bytes.length) return lose();
      reply.bytes = Buffer.concat([reply.bytes, chunk]);
      if (!reply.bytes.equals(reply.expected.subarray(0, reply.bytes.length))) return lose();
      if (reply.bytes.length === reply.expected.length) {
        this.#pending = undefined;
        reply.resolve();
      }
    });
  }

  get signal() { return this.#lost.signal; }

  async #exchange(frame, signal, command) {
    const interrupted = AbortSignal.any([signal, this.signal]);
    if (interrupted.aborted || this.#pending || this.#releasing) throw unavailable();
    const {promise, resolve, reject} = Promise.withResolvers();
    this.#pending = {expected: Buffer.from(frame), bytes: Buffer.alloc(0), resolve};
    const abort = () => reject(unavailable());
    interrupted.addEventListener('abort', abort, {once: true});
    try {
      if (command) this.#child.stdin.write(command);
      await promise;
      if (interrupted.aborted) throw unavailable();
    } finally {
      interrupted.removeEventListener('abort', abort);
      this.#pending = undefined;
    }
  }

  ready(signal) { return this.#exchange('ready\n', signal); }
  confirm(signal) { return this.#exchange('confirmed\n', signal, 'confirm\n'); }

  async release() {
    this.#releasing = true;
    this.#child.stdin.end();
    // Cleanup can outlast the operation deadline. The Buddy child is already joined.
    const timer = setTimeout(() => {
      this.#lost.abort(unavailable());
      this.#child.kill('SIGKILL');
    }, 1000);
    try { await this.#closed; }
    finally { clearTimeout(timer); }
  }
}

export async function lockWindowsResources(root, python, signal, spawnLock = spawn) {
  if (signal.aborted || typeof python !== 'string' || !path.isAbsolute(python) ||
      path.resolve(python) !== python) throw unavailable();
  const env = process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {};
  const lock = new ResourceLock(spawnLock(python, ['-I', '-B', helper, root], {
    cwd: path.dirname(helper), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  try {
    await lock.ready(signal);
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}
