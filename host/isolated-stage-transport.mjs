// The host-private adapter for one original verified isolated backup.
import {createHash, randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {strictJson} from './strict-json.mjs';
import {restorePath} from './ordinary-restore-protocol.mjs';
import {validateResult} from './observation-protocol.mjs';

const MiB = 1024 * 1024;
const BACKUP = 'data/backup.json';
const PORTABLE = 'portable-configuration.json';
const MARKER = 'isolated-backup.json';
const DOMAIN = 'remarkable-buddies-restore-stage-inventory-v1\0';
const RECEIVE = 'receive-isolated-stage';
const CHECK = 'check-isolated-stage';
const RELEASE = 'release-isolated-stage';
const MAX_REPORT = 16384;
const attempts = new WeakMap();
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join() === keys;
const require = (value) => { if (!value) throw Error('Isolated destination unavailable'); };

export function originalStageAttempt(value) {
  return attempts.get(value);
}

function stageFailure(attempt, pending) {
  const error = Error('Isolated destination unavailable');
  if (pending) {
    error.cleanupPending = true;
    attempts.set(error, attempt);
  }
  return error;
}

function inventory(source) {
  const {files, components, inspection} = source;
  require(Array.isArray(files) && files.length >= 3 && files.length <= 4099);
  const names = new Map();
  let payload_bytes = 0;
  for (const file of files) {
    require(exact(file, 'bytes,name,sha256') && hash(file.sha256) && !names.has(file.name));
    const limit = file.name === BACKUP ? 8 * MiB : file.name === PORTABLE ? 128 * 1024 :
      file.name === MARKER ? MAX_REPORT : 256 * MiB;
    const object = ![BACKUP, PORTABLE, MARKER].includes(file.name);
    require(!object || file.name === 'data/objects/' + file.sha256);
    require(Number.isSafeInteger(file.bytes) && file.bytes >= Number(!object) && file.bytes <= limit);
    payload_bytes += file.bytes;
    require(payload_bytes <= 512 * MiB);
    names.set(file.name, Object.freeze({...file}));
  }
  const manifest = names.get(BACKUP), preferences = names.get(PORTABLE), marker = names.get(MARKER);
  require(manifest && preferences && marker && marker.sha256 === inspection?.markerSha256);
  for (const [member, selected] of [[manifest, components?.data], [preferences, components?.preferences]]) {
    require(member.sha256 === selected?.sha256 && member.bytes === selected.bytes);
  }
  const objectNames = [...names.keys()].filter(name => name.startsWith('data/objects/')).sort();
  const object_count = objectNames.length;
  const count = Buffer.alloc(4);
  count.writeUInt32BE(object_count);
  const digest = createHash('sha256').update(DOMAIN).update(count);
  const ordered = [BACKUP, ...objectNames, PORTABLE, MARKER].map(name => {
    const member = names.get(name);
    const descriptor = Buffer.alloc(40);
    descriptor.writeBigUInt64BE(BigInt(member.bytes));
    descriptor.write(member.sha256, 8, 32, 'hex');
    digest.update(descriptor);
    return {member, descriptor};
  });
  return {names, ordered, object_count, payload_bytes, inventory_sha256: digest.digest('hex'), marker_sha256: marker.sha256};
}

function readLine(bytes, limit) {
  require(Buffer.isBuffer(bytes) && bytes.length > 1 && bytes.length <= limit &&
    bytes.at(-1) === 10 && bytes.indexOf(10) === bytes.length - 1 &&
    !bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])));
  return strictJson(bytes);
}

function matchesReceipt(receipt, attempt) {
  return exact(receipt, 'boot_id,custody_sha256,inventory_sha256,marker_sha256,root,stage_id,version') &&
    receipt.version === 1 && receipt.stage_id === attempt.stage_id && receipt.boot_id === attempt.boot_id &&
    receipt.marker_sha256 === attempt.marker_sha256 && receipt.inventory_sha256 === attempt.inventory_sha256 &&
    hash(receipt.custody_sha256) && restorePath(receipt.root) && posix.normalize(receipt.root) === receipt.root &&
    receipt.root.endsWith('/.remarkable-buddies-restore-stage-v1/restore-v1-' + receipt.stage_id);
}

function response(result, selector, sample) {
  if (result?.dispatch === 'not-dispatched') return {dispatch: 'not-dispatched'};
  const value = readLine(result?.stdout, 24576);
  require(exact(value, 'contract_version,dispatch,observation,status,stdout_base64') &&
    ['possible', 'not-dispatched'].includes(value.dispatch));
  validateResult({contract_version: value.contract_version, status: value.status, observation: value.observation});
  if (value.status !== 'observed') {
    require(value.stdout_base64 === null);
    return {dispatch: value.dispatch};
  }
  require(value.dispatch === 'possible' && isDeepStrictEqual(sample, value.observation) &&
    typeof value.stdout_base64 === 'string' && value.stdout_base64.length <= Math.ceil(MAX_REPORT / 3) * 4);
  const bytes = Buffer.from(value.stdout_base64, 'base64');
  require(bytes.toString('base64') === value.stdout_base64);
  const report = readLine(bytes, MAX_REPORT);
  require(exact(report, 'activation_performed,data,incomplete,operation,report_version,status') &&
    report.report_version === 1 && report.operation === selector && report.activation_performed === false &&
    exact(report.data, 'receipt,settlement'));
  const {settlement, receipt} = report.data;
  const admissible = selector === RECEIVE ? {
    sealed: ['ok'], 'no-output': ['invalid-input', 'unavailable'], cleaned: ['failed'], unconfirmed: ['failed'],
  } : {
    [selector === CHECK ? 'verified' : 'released']: ['ok'], 'no-output': ['invalid-input'], unconfirmed: ['unavailable'],
  };
  require(Object.hasOwn(admissible, settlement) && admissible[settlement].includes(report.status) &&
    report.incomplete === ['failed', 'unavailable'].includes(report.status) &&
    (report.status === 'ok' ? result.wrote && receipt !== null : receipt === null));
  return {dispatch: 'possible', settlement, receipt};
}

function createHandle(observer, sample, names, attempt, receipt) {
  const input_base64 = Buffer.from(JSON.stringify(receipt)).toString('base64');
  const {connection_id, boot_id, marker_sha256} = attempt;
  const originalFiles = files => Array.isArray(files) && files.length === names.size &&
    new Set(files.map(file => file?.name)).size === names.size &&
    files.every(file => isDeepStrictEqual(file, names.get(file?.name)));
  const reconcile = async (selector, bounds) => {
    try {
      if (!bounds.current() || bounds.signal.aborted || bounds.remainingMs() < 1 ||
        !isDeepStrictEqual(sample, observer.lastObservation)) return false;
      const raw = await observer.runIsolatedStage({selector, connection_id, boot_id, input_base64}, bounds);
      const reply = response(raw, selector, sample);
      return bounds.current() && !bounds.signal.aborted && bounds.remainingMs() >= 1 &&
        reply.settlement === (selector === CHECK ? 'verified' : 'released') &&
        isDeepStrictEqual(reply.receipt, receipt);
    } catch { return false; }
  };
  let checking = false, retirement;
  const handle = Object.freeze({
    root: receipt.root,
    async assertOwned(bounds) {
      if (checking || retirement || bounds.connection_id !== connection_id || bounds.boot_id !== boot_id ||
        bounds.markerSha256 !== marker_sha256 || !originalFiles(bounds.files)) return false;
      checking = true;
      try { return await reconcile(CHECK, bounds); }
      finally { checking = false; }
    },
    release(withLease) {
      return retirement ??= Promise.resolve().then(() => checking || typeof withLease !== 'function' ?
        false : withLease(bounds => reconcile(RELEASE, bounds))).catch(() => false);
    },
  });
  attempts.set(handle, attempt);
  return handle;
}

export function createIsolatedStageDestination(observer) {
  return async source => {
    require(typeof observer?.runIsolatedStage === 'function' && typeof source.readFile === 'function');
    const {signal, remainingMs, current, sample, connection_id, boot_id, operation, reference} = source;
    require(typeof remainingMs === 'function' && typeof current === 'function' && current() &&
      signal instanceof AbortSignal && !signal.aborted && hash(operation) && hash(reference) &&
      hash(connection_id) && uuid(boot_id) && sample?.connection_id === connection_id && sample?.boot_id === boot_id);
    const {names, ordered, object_count, payload_bytes, inventory_sha256, marker_sha256} = inventory(source);
    const stage_id = randomUUID();
    const attempt = Object.freeze({operation, reference, connection_id, boot_id, stage_id, marker_sha256, inventory_sha256});
    const header = {version: 1, stage_id, boot_id, marker_sha256, inventory_sha256, object_count, payload_bytes};
    const options = {signal, remainingMs, current};
    if (!current() || signal.aborted || remainingMs() < 1 ||
      !isDeepStrictEqual(sample, observer.lastObservation)) throw stageFailure(attempt, false);
    let value;
    try {
      const raw = await observer.runIsolatedStage({selector: RECEIVE, connection_id, boot_id, header}, options,
        async (write, writerSignal, writerRemaining) => {
          for (const {member, descriptor} of ordered) {
            await write(descriptor);
            let sent = 0;
            await source.readFile(member.name, async chunk => {
              require(chunk instanceof Uint8Array && chunk.byteLength > 0 &&
                chunk.byteLength <= 64 * 1024 && chunk.byteLength <= member.bytes - sent);
              await write(chunk);
              sent += chunk.byteLength;
            }, {signal: writerSignal, remainingMs: writerRemaining});
            require(sent === member.bytes);
          }
        });
      value = response(raw, RECEIVE, sample);
    } catch {
      throw stageFailure(attempt, true);
    }
    if (value.dispatch === 'not-dispatched') throw stageFailure(attempt, false);
    if (!current() || signal.aborted || remainingMs() < 1) throw stageFailure(attempt, true);
    if (value.settlement === 'no-output' || value.settlement === 'cleaned') throw stageFailure(attempt, false);
    if (value.settlement !== 'sealed' || !matchesReceipt(value.receipt, attempt)) throw stageFailure(attempt, true);
    return createHandle(observer, sample, names, attempt, Object.freeze(value.receipt));
  };
}
