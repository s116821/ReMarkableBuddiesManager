import {
  parseIsolatedBackupResult, type IsolatedBackupRequest, type IsolatedBackupResult,
  type IsolatedBackupSelection, type IsolatedBackupStatus, type IsolatedBackupSummary,
} from '../host/isolated-backup-protocol.mjs';

export type IsolatedBackupAdapter = (request: IsolatedBackupRequest) => Promise<IsolatedBackupResult>;

const labels: Record<IsolatedBackupStatus, string> = {
  scanning: 'Checking for cloud backups…',
  selecting: 'Checking the selected revision…',
  observed: 'Choose a backup revision.',
  empty: 'No backup revisions were found in the verified Drive location.',
  selected: 'Backup revision selected. Download and restore are separate steps.',
  unqualified: 'Manager hasn’t verified access to Buddy’s backup location with this Drive connection.',
  unavailable: 'Could not check cloud backups. Check your Drive connection and try again.',
  invalid: 'Manager could not verify the backup information.',
  incomplete: 'The backup check was incomplete. Run a new scan to try again.',
  invalidated: 'The backup check was cancelled or expired. Run a new scan.',
  unsupported: 'This backup revision uses an unsupported format.',
  busy: 'Another backup check is still running.',
};

interface BackupView {
  busy: boolean;
  message: string;
  backups: IsolatedBackupSummary[];
  selected: IsolatedBackupSelection | null;
  selectedChoice: string | null;
}

interface Pending {
  request: Extract<IsolatedBackupRequest, {action: 'scan' | 'select'}>;
  operation: string | null;
  deadline: number;
  startedAt: number;
  expected?: {backup: string; device: string; sha256: string};
}

const idle = 'Scan for isolated Buddy backups.';
const lostReply = 'Manager lost the reply to this backup check. You can start a new scan.';
const maxWaitMs = 65000;
const selectionMs = 120000;

export class IsolatedBackupController {
  state: BackupView = {busy: false, message: idle, backups: [], selected: null, selectedChoice: null};
  private inspection: string | null = null;
  private owner: string | null = null;
  private waiting: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly adapter: IsolatedBackupAdapter;
  private readonly changed: (state: BackupView) => void;
  private readonly pollMs: number;

  constructor(adapter: IsolatedBackupAdapter, changed: (state: BackupView) => void, pollMs = 500) {
    this.adapter = adapter;
    this.changed = changed;
    this.pollMs = pollMs;
  }

  private publish(changes: Partial<BackupView>) {
    this.state = {...this.state, ...changes};
    this.changed(this.state);
  }

  private async cancelOperation(operation: string) {
    // An exact old operation cannot cancel its successor.
    try { await this.adapter({version: 1, action: 'cancel', operation}); }
    catch { /* Local view has already been invalidated. */ }
  }

  clear(message = idle) {
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    clearTimeout(this.watchdog);
    const operation = this.waiting?.operation ?? this.owner;
    this.waiting = null;
    this.owner = null;
    this.inspection = null;
    if (operation) void this.cancelOperation(operation);
    this.publish({busy: false, message, backups: [], selected: null, selectedChoice: null});
  }

  dispose() {
    this.disposed = true;
    this.clear();
  }

  scan() {
    if (this.disposed || this.state.busy) return;
    this.clear();
    return this.start({version: 1, action: 'scan'});
  }

  select(choice: string) {
    if (this.disposed || this.state.busy || !this.inspection) return;
    for (const backup of this.state.backups) {
      const revision = backup.revisions.find(row => row.reference === choice);
      if (revision) return this.start({version: 1, action: 'select', inspection: this.inspection, choice},
        {backup: backup.backup, device: backup.device, sha256: revision.sha256});
    }
  }

  private async start(request: Pending['request'], expected?: Pending['expected']) {
    clearTimeout(this.expiry);
    const startedAt = performance.now();
    const attempt: Pending = {request, expected, operation: null, startedAt, deadline: startedAt + maxWaitMs};
    this.waiting = attempt;
    this.watchdog = setTimeout(() => {
      if (this.waiting === attempt) this.clear(labels.incomplete);
    }, maxWaitMs);
    this.publish({busy: true, message: labels[request.action === 'scan' ? 'scanning' : 'selecting'],
      selected: null, selectedChoice: null});
    try {
      const response = parseIsolatedBackupResult(await this.adapter(request), request);
      if (this.waiting !== attempt) {
        if (response.operation) void this.cancelOperation(response.operation);
        return;
      }
      attempt.operation = response.operation;
      this.accept(attempt, response);
    } catch {
      if (this.waiting === attempt) this.clear(lostReply);
    }
  }

  private async poll(attempt: Pending, operation: string) {
    if (this.waiting !== attempt) return;
    try {
      const request = {version: 1, action: 'status', operation} as const;
      const response = parseIsolatedBackupResult(await this.adapter(request), request);
      if (this.waiting === attempt) this.accept(attempt, response);
    } catch {
      if (this.waiting === attempt) this.clear(lostReply);
    }
  }

  private accept(attempt: Pending, response: IsolatedBackupResult) {
    const {status, operation} = response;
    const scan = attempt.request.action === 'scan';
    if (performance.now() >= attempt.deadline) {
      this.clear(labels.incomplete);
      return;
    }
    if (scan ? ['selecting', 'selected'].includes(status) : ['scanning', 'observed', 'empty'].includes(status)) {
      this.clear(labels.invalid);
      return;
    }
    if (status === 'scanning' || status === 'selecting') {
      if (!operation) throw Error('Backup operation refused');
      this.owner = operation;
      this.timer = setTimeout(() => { void this.poll(attempt, operation); }, this.pollMs);
      return;
    }

    const selected = response.selection, expected = attempt.expected;
    if (status === 'selected' && (!selected || !expected || selected.backup !== expected.backup ||
        selected.device !== expected.device || selected.sha256 !== expected.sha256)) {
      this.clear(labels.invalid);
      return;
    }
    this.waiting = null;
    clearTimeout(this.watchdog);
    if (operation) this.owner = operation;

    if (status === 'observed' || status === 'empty') {
      this.inspection = operation;
      this.publish({busy: false, message: labels[status], backups: response.backups});
    } else if (status === 'selected' && attempt.request.action === 'select') {
      this.publish({busy: false, message: labels.selected, selected, selectedChoice: attempt.request.choice});
      // The host can create the handle before our status response arrives.
      // Start our expiry at submission so the UI never extends host custody.
      this.expiry = setTimeout(() => this.clear('The backup selection expired. Run a new scan.'),
        Math.max(0, attempt.startedAt + selectionMs - performance.now()));
    } else if (status === 'busy' && !scan) {
      this.publish({busy: false, message: labels.busy});
    } else {
      this.inspection = null;
      this.publish({busy: false, message: labels[status], backups: []});
    }
  }
}
