export type ReleaseStream = 'buddy' | 'manager';
const REPOSITORIES = Object.freeze({ buddy: 's116821/ReMarkableBuddies', manager: 's116821/ReMarkableBuddiesManager' });
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORIES.buddy}/releases/latest`;
export const MANAGER_RELEASE_API = `https://api.github.com/repos/${REPOSITORIES.manager}/releases/latest`;
export const MANAGER_ASSETS = Object.freeze(['manager-browser.zip', 'manager-linux-x64.zip', 'manager-win32-x64.zip', 'provenance.json']);
export const SOURCE_KEY = 'remarkable-buddies-manager.release-source';
export const POLL_MS = 5 * 60_000;
export type ReleaseSource = 'official' | 'community';
export interface Candidate { tag: string; publishedAt: string; assetsPublished: boolean }
export interface ReleaseState {
  preference: ReleaseSource; persistenceError: boolean;
  status: 'idle' | 'checking' | 'ready' | 'missing' | 'error';
  candidate: Candidate | null; checkedAt: string | null; stale: boolean; error: string | null; retryAt: string | null;
}
export const INSTALL_BLOCKERS = Object.freeze([
  'Connect and verify a supported tablet.',
  'Verify a signed Buddy APK, exact source/SDK provenance and package ownership.',
]);
export function decodeCandidate(value: unknown, stream: ReleaseStream = 'buddy'): Candidate {
  if (!Object.hasOwn(REPOSITORIES, stream)) throw new Error('Unsupported release stream.');
  const repository = REPOSITORIES[stream];
  if (!value || typeof value !== 'object') throw new Error('Invalid release metadata.');
  const r = value as Record<string, unknown>;
  if (r.draft !== false || r.prerelease !== false || typeof r.tag_name !== 'string' ||
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(r.tag_name) ||
      r.html_url !== `https://github.com/${repository}/releases/tag/${r.tag_name}` ||
      typeof r.published_at !== 'string' || !Number.isFinite(Date.parse(r.published_at)) || !Array.isArray(r.assets)) {
    throw new Error('Release identity is not a published official stable tag.');
  }
  const assetsPublished = r.assets.length > 0 && r.assets.every((asset: unknown) => {
    if (!asset || typeof asset !== 'object') return false;
    const a = asset as Record<string, unknown>;
    return typeof a.name === 'string' && a.state === 'uploaded' && typeof a.size === 'number' &&
      Number.isSafeInteger(a.size) && a.size > 0 &&
      a.browser_download_url === `https://github.com/${repository}/releases/download/${r.tag_name}/${a.name}`;
  });
  const expectedAssets = stream !== 'manager' || MANAGER_ASSETS.every(name => r.assets instanceof Array && r.assets.some((a: unknown) => !!a && typeof a === 'object' && (a as Record<string, unknown>).name === name));
  return { tag: r.tag_name, publishedAt: r.published_at, assetsPublished: assetsPublished && expectedAssets };
}

// Read-only metadata and app policy. No tablet, package mutations or qualifying verifier.
export class ReleaseController {
  state: ReleaseState;
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private fetcher: typeof fetch;
  private changed: (state: ReleaseState) => void;
  private request: AbortController | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private retryNotBefore = 0;
  private readonly stream: ReleaseStream;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null, changed: (state: ReleaseState) => void, fetcher: typeof fetch = (...args) => fetch(...args), stream: ReleaseStream = 'buddy') {
    if (!Object.hasOwn(REPOSITORIES, stream)) throw new Error('Unsupported release stream.');
    this.stream = stream; this.storage = stream === 'buddy' ? storage : null; this.changed = changed; this.fetcher = fetcher;
    let preference: ReleaseSource = 'official'; let persistenceError = stream === 'buddy' && !storage;
    try { if (this.storage?.getItem(SOURCE_KEY) === 'community') preference = 'community'; }
    catch { persistenceError = true; }
    this.state = { preference, persistenceError, status: 'idle', candidate: null, checkedAt: null, stale: false, error: null, retryAt: null };
  }
  private update(patch: Partial<ReleaseState>) {
    this.state = { ...this.state, ...patch }; this.changed(this.state);
  }
  chooseOfficial() {
    if (this.stream !== 'buddy') return;
    // Community cannot be chosen until listing; retain previously saved policy honestly.
    let persistenceError = !this.storage;
    try { this.storage?.setItem(SOURCE_KEY, 'official'); } catch { persistenceError = true; }
    this.update({ preference: 'official', persistenceError });
  }
  start() {
    if (this.disposed || this.poll) return;
    void this.refresh();
    this.poll = setInterval(() => { void this.refresh(); }, POLL_MS);
  }
  async refresh() {
    if (this.disposed || this.request || Date.now() < this.retryNotBefore) return;
    const request = new AbortController(); this.request = request;
    const timeout = setTimeout(() => request.abort(), 15_000);
    this.update({ status: 'checking', error: null });
    try {
      const response = await this.fetcher(this.stream === 'buddy' ? RELEASE_API : MANAGER_RELEASE_API, { signal: request.signal, credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (request.signal.aborted) throw new Error('cancelled');
      if (response.status === 404) {
        this.retryNotBefore = 0;
        this.update({ status: 'missing', candidate: null, checkedAt: new Date().toISOString(), stale: false, retryAt: null }); return;
      }
      if (response.status === 403 || response.status === 429) {
        const now = Date.now(); const after = response.headers.get('Retry-After');
        const reset = response.headers.get('X-RateLimit-Reset');
        const afterTime = after && /^\d+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after ?? '');
        const resetTime = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
        const future = [afterTime, resetTime].filter(time => Number.isFinite(time) && time > now && time <= 8.64e15);
        this.retryNotBefore = future.length ? Math.max(...future) : now + POLL_MS;
        this.update({ retryAt: new Date(this.retryNotBefore).toISOString() });
        throw new Error(response.status === 429 || response.headers.get('X-RateLimit-Remaining') === '0' || after ? 'rate-limit' : 'unavailable');
      }
      if (!response.ok) throw new Error('unavailable');
      const candidate = decodeCandidate(await response.json(), this.stream);
      if (request.signal.aborted) throw new Error('cancelled');
      this.retryNotBefore = 0;
      this.update({ status: 'ready', candidate, checkedAt: new Date().toISOString(), stale: false, retryAt: null });
    } catch (error) {
      if (!this.disposed) this.update({ status: 'error', stale: !!this.state.candidate,
        error: error instanceof Error && error.message === 'rate-limit' ? 'GitHub rate limit reached. Try again later.' :
          request.signal.aborted ? 'Release check timed out. Try again.' : this.stream === 'manager' ? 'Official Manager release metadata could not be verified. Try again.' : 'Official release metadata could not be verified. Try again.' });
    } finally { clearTimeout(timeout); this.request = null; }
  }
  dispose() { this.disposed = true; this.request?.abort(); if (this.poll) clearInterval(this.poll); }
}
