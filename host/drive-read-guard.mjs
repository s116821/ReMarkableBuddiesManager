import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('./drive-read-guard.py', import.meta.url));
const TIMEOUT = 5000;
const DIGEST = /^[0-9a-f]{64}$/;
const refused = () => Error('Protected Drive read authority unavailable');
const trustedPath = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;

export class DriveReadGuard {
  #child;
  #lifetime;
  #controller = new AbortController();
  #pending = null;
  #exited;
  #reply = '';
  #shutdown;

  static async open({python, root, clientDigest, grantDigest, signal, timeoutMs = TIMEOUT}) {
    if (!trustedPath(python) || !trustedPath(root) || typeof clientDigest !== 'string' ||
        typeof grantDigest !== 'string' || !DIGEST.test(clientDigest) || !DIGEST.test(grantDigest) ||
        !(signal instanceof AbortSignal) || signal.aborted) throw refused();
    const guard = new DriveReadGuard(python, root, signal);
    try {
      await guard.#send(JSON.stringify([clientDigest, grantDigest]) + '\n', timeoutMs);
      if (guard.signal.aborted) throw refused();
      return guard;
    } catch {
      await guard.close();
      throw refused();
    }
  }

  constructor(python, root, signal) {
    this.#lifetime = signal;
    this.#child = spawn(python, ['-I', '-B', script, root], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8'},
    });
    this.#exited = new Promise(resolve => this.#child.once('close', () => {
      this.#lifetime.removeEventListener('abort', this.#aborted);
      this.#invalidate();
      resolve();
    }));
    this.#child.on('error', this.#aborted);
    this.#child.stdin.on('error', this.#aborted);
    this.#child.stderr.on('data', this.#aborted);
    this.#child.stdout.on('data', bytes => this.#receive(bytes));
    signal.addEventListener('abort', this.#aborted, {once: true});
    if (signal.aborted) this.#aborted();
  }

  get signal() { return this.#controller.signal; }

  // Diagnostics for synthetic throughput tests only. Never a public API value.
  get pid() { return this.#child.pid; }

  #receive(bytes) {
    if (!this.#pending || bytes.length > 3 - this.#reply.length) {
      this.#aborted();
      return;
    }
    this.#reply += bytes.toString('latin1');
    if (!'ok\n'.startsWith(this.#reply)) {
      this.#aborted();
    } else if (this.#reply === 'ok\n') {
      this.#reply = '';
      this.#finish(true);
    }
  }

  #finish(ok) {
    const pending = this.#pending;
    this.#pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', this.#aborted);
      if (ok) pending.resolve(true);
      else pending.reject(refused());
    }
  }

  #invalidate() {
    this.#controller.abort();
    this.#finish(false);
  }

  #aborted = () => { void this.close(); };

  #send(input, timeoutMs, signal) {
    if (this.signal.aborted || signal?.aborted || this.#pending ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(refused());

    return new Promise((resolve, reject) => {
      const timer = setTimeout(this.#aborted, Math.min(timeoutMs, TIMEOUT));
      this.#pending = {timer, resolve, reject, signal};
      signal?.addEventListener('abort', this.#aborted, {once: true});
      this.#child.stdin.write(input);
    });
  }

  async check({signal, timeoutMs = TIMEOUT} = {}) {
    try {
      await this.#send('check\n', timeoutMs, signal);
      if (this.signal.aborted || signal?.aborted) throw refused();
      return true;
    } catch {
      await this.close();
      throw refused();
    }
  }

  close() {
    if (!this.#shutdown) {
      // Capture whether a request must be interrupted before abort listeners
      // can synchronously call back into this method.
      const pending = this.#pending !== null;
      this.#shutdown = this.#exited;
      this.#invalidate();
      this.#child.stdin.end();
      if (pending) this.#child.kill();
      const kill = setTimeout(() => this.#child.kill(), TIMEOUT);
      void this.#exited.then(() => clearTimeout(kill));
    }
    return this.#shutdown;
  }
}
