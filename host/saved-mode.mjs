const keys = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join() : '';
const uuid = v => typeof v === 'string' && v.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const digest = v => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
const statuses = ['ok', 'invalid-input', 'unsupported', 'unavailable', 'busy', 'conflict', 'failed'];
const refuse = () => { throw new Error('Saved mode response refused'); };

export function parseSavedModeRequest(v) {
  if (keys(v) !== 'boot_id,connection_id' || !uuid(v.boot_id) || !digest(v.connection_id)) throw new Error('Saved mode input refused');
  return v;
}

// The privileged host consumes the raw backend report; no raw report leaves it.
export function parseSavedModeReport(v) {
  if (!v || !Number.isSafeInteger(v.report_version) || v.report_version < 1) refuse();
  if (v.report_version !== 1) throw new Error('Saved mode report version unsupported');
  if (keys(v) !== 'activation_performed,data,incomplete,operation,report_version,status' || v.operation !== 'inspect' ||
      v.activation_performed !== false || typeof v.incomplete !== 'boolean' || !statuses.includes(v.status) ||
      new TextEncoder().encode(JSON.stringify(v)).length + 1 > 16384) refuse();
  if (v.status !== 'ok') {
    if (v.data !== null) refuse();
    return { status: v.status, incomplete: v.incomplete, snapshot: null };
  }
  if (v.incomplete || keys(v.data) !== 'current_snapshot,receipt,receipt_status' || v.data.receipt !== null || v.data.receipt_status !== null) refuse();
  const s = v.data.current_snapshot;
  if (keys(s) !== 'device,epoch,mode,token' || keys(s.token) !== 'actor,sha256' || !uuid(s.token.actor) || !digest(s.token.sha256)) refuse();
  const snapshot = { kind: 'unconfigured', device: s.device, epoch: s.epoch, group: null, backup: null };
  if (s.mode === null) {
    if (s.device !== null || s.epoch !== null) refuse();
  } else {
    if (!uuid(s.device) || !uuid(s.epoch)) refuse();
    const m = s.mode;
    if (m?.kind === 'local-only') {
      if (keys(m) !== 'kind') refuse();
    } else if (m?.kind === 'isolated-backup') {
      if (keys(m) !== 'backup,binding_sha256,kind' || !uuid(m.backup) || !digest(m.binding_sha256)) refuse();
      snapshot.backup = m.backup;
    } else if (m?.kind === 'shared-group') {
      if (keys(m) !== 'binding_sha256,group,kind,root_id' || !uuid(m.group) || !digest(m.binding_sha256) ||
          typeof m.root_id !== 'string' || m.root_id.length < 1 || m.root_id.length > 256 || /[^A-Za-z0-9_-]/.test(m.root_id)) refuse();
      snapshot.group = m.group;
    } else refuse();
    snapshot.kind = m.kind;
  }
  return { status: 'ok', incomplete: false, snapshot };
}

export function parseSavedModeView(v) {
  if (keys(v) !== 'incomplete,snapshot,status' || !statuses.includes(v.status) || typeof v.incomplete !== 'boolean') refuse();
  if (v.status !== 'ok') { if (v.snapshot !== null) refuse(); return v; }
  const s = v.snapshot;
  if (v.incomplete || keys(s) !== 'backup,device,epoch,group,kind') refuse();
  if (s.kind === 'unconfigured') {
    if ([s.device, s.epoch, s.group, s.backup].some(v => v !== null)) refuse();
  } else {
    if (!uuid(s.device) || !uuid(s.epoch)) refuse();
    if (s.kind === 'local-only') { if (s.group !== null || s.backup !== null) refuse(); }
    else if (s.kind === 'isolated-backup') { if (!uuid(s.backup) || s.group !== null) refuse(); }
    else if (s.kind === 'shared-group') { if (!uuid(s.group) || s.backup !== null) refuse(); }
    else refuse();
  }
  return v;
}

function observation(v, request, validateObservation) {
  parseSavedModeRequest(request);
  if (keys(v) !== 'contract_version,observation,saved_mode,status') refuse();
  validateObservation({ contract_version: v.contract_version, status: v.status, observation: v.observation });
  if (v.status === 'observed' && (v.observation.connection_id !== request.connection_id || v.observation.boot_id !== request.boot_id)) refuse();
}

export function parseSavedModeResult(v, request, validateObservation) {
  observation(v, request, validateObservation);
  const q = v.saved_mode;
  if (keys(q) !== 'status,view' || !['reported', 'unsupported', 'unavailable'].includes(q.status)) refuse();
  if (q.status === 'reported') { if (v.status !== 'observed') refuse(); parseSavedModeView(q.view); }
  else if (q.view !== null) refuse();
  return v;
}

export function reduceSavedModeResult(v, request, validateObservation) {
  observation(v, request, validateObservation);
  const q = v.saved_mode;
  if (keys(q) !== 'report,status' || !['reported', 'unsupported', 'unavailable'].includes(q.status)) refuse();
  let status = q.status, view = null;
  if (status === 'reported') {
    if (v.status !== 'observed') refuse();
    try { view = parseSavedModeReport(q.report); }
    catch (error) {
      if (error.message !== 'Saved mode report version unsupported') throw error;
      status = 'unsupported';
    }
  } else if (q.report !== null) refuse();
  return parseSavedModeResult({ contract_version: v.contract_version, status: v.status,
    observation: v.observation, saved_mode: { status, view } }, request, validateObservation);
}
