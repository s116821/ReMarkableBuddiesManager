import { downloadState, parseDownloadState, validDownloadTag } from '../host/manager-download-protocol.mjs';
import type { DownloadRequest, DownloadState } from '../host/manager-download-protocol.mjs';
export interface DownloadAdapter { request(q: DownloadRequest): Promise<unknown> }
export class DownloadController {
  state = downloadState(); unknown = false; busy = false;
  private pendingCancel: DownloadRequest|null = null;
  private generation = 0; private disposed = false; private timer: ReturnType<typeof setTimeout>|null = null;
  private adapter: DownloadAdapter;
  private changed: (s: DownloadState, unknown: boolean) => void;
  constructor(adapter: DownloadAdapter, changed: (s: DownloadState, unknown: boolean) => void) { this.adapter = adapter; this.changed = changed; }
  async request(q: DownloadRequest) {
    if (this.disposed || (q.action === 'start' && !validDownloadTag(q.tag))) return;
    if (this.busy) {
      // Preserve one explicit current-operation cancellation across a pending poll.
      if (q.action === 'cancel' && q.operation_id === this.state.operation_id && ['downloading','cancelling'].includes(this.state.status)) {
        this.pendingCancel = q; this.state = { ...this.state, status: 'cancelling' }; this.changed(this.state, this.unknown);
      }
      return;
    }
    const generation = ++this.generation; this.busy = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      const result = parseDownloadState(await this.adapter.request(q));
      if (this.disposed || generation !== this.generation) return;
      if (q.action === 'cancel' && result.operation_id !== q.operation_id) throw new Error('Changed download');
      if (q.action === 'start' && result.operation_id && result.tag !== q.tag) throw new Error('Changed download');
      if (q.action === 'status' && this.state.operation_id && ['downloading','cancelling'].includes(this.state.status) && result.operation_id !== this.state.operation_id) throw new Error('Changed download');
      this.state = result; this.unknown = false;
    } catch { if (!this.disposed && generation === this.generation) { this.state = downloadState(); this.unknown = true; } }
    finally {
      if (!this.disposed && generation === this.generation) {
        this.busy = false; this.changed(this.state,this.unknown);
        const cancel = this.pendingCancel; this.pendingCancel = null;
        if (cancel) await this.request(cancel);
        else if (['downloading','cancelling'].includes(this.state.status)) this.timer = setTimeout(()=>{void this.request({action:'status'});},1000);
      }
    }
  }
  dispose() { this.disposed = true; this.pendingCancel = null; this.generation++; if (this.timer) clearTimeout(this.timer); }
}
