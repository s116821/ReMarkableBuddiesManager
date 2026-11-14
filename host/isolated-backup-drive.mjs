import {get as httpGet} from 'node:http';
import {get as httpsGet} from 'node:https';

const DRIVE_ORIGIN = 'https://www.googleapis.com';
const FILES = '/drive/v3/files';
const FILE_FIELDS = 'id,appProperties,size,mimeType,trashed,spaces';
const LIST_FIELDS = 'files(' + FILE_FIELDS + '),nextPageToken,incompleteSearch';
const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;
const MAX_METADATA = 64 * MiB;
const MAX_MARKER = 16 * 1024;
const MAX_OBJECT = 256 * MiB;
const MAX_TIMEOUT = 120000;

const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isBackup = value => typeof value === 'string' && value !== '00000000-0000-0000-0000-000000000000' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

function require(ok) {
  if (!ok) throw new Error('Drive backup read refused');
}

// A single GET with no redirect, retry, refresh or implicit response decompression.
async function* read(get, url, token, authority, query, limit) {
  const {maxBytes, timeoutMs, signal} = query;
  require(signal instanceof AbortSignal && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 &&
    timeoutMs <= MAX_TIMEOUT && Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= limit);
  const active = AbortSignal.any([authority, signal, AbortSignal.timeout(timeoutMs)]);
  require(!active.aborted);

  let request, closed;
  try {
    const response = await new Promise((resolve, reject) => {
      request = get(url, {agent: false, signal: active, headers: {
        Authorization: 'Bearer ' + token, 'Accept-Encoding': 'identity',
      }}, resolve);
      request.on('error', reject);
      closed = new Promise(resolveClose => request.once('close', () => {
        reject(new Error('Drive backup read refused'));
        resolveClose();
      }));
    });
    const declared = response.headers['content-length'];
    const encoding = response.headers['content-encoding'];
    require(response.statusCode === 200 && (encoding === undefined || encoding === 'identity') &&
      (declared === undefined || (/^\d+$/.test(declared) && Number(declared) <= maxBytes)));

    let count = 0;
    for await (const chunk of response) {
      count += chunk.length;
      require(!active.aborted && count <= maxBytes);
      for (let offset = 0; offset < chunk.length; offset += CHUNK) {
        require(!active.aborted);
        yield chunk.subarray(offset, offset + CHUNK);
      }
    }
    require(!active.aborted && response.complete && (declared === undefined || count === Number(declared)));
  } catch {
    throw new Error('Drive backup read refused');
  } finally {
    request?.destroy();
    await closed;
  }
}

async function bytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listParams(properties, {pageToken, maxEntries}) {
  require(Number.isSafeInteger(maxEntries) && maxEntries >= 1 && maxEntries <= 100);
  const filters = Object.entries(properties).map(([key, value]) =>
    "appProperties has { key='" + key + "' and value='" + value + "' }");
  const params = {spaces: 'appDataFolder', fields: LIST_FIELDS, pageSize: String(maxEntries),
    q: ['trashed = false', ...filters].join(' and ')};
  if (pageToken !== null) {
    require(typeof pageToken === 'string' && pageToken.length > 0 && Buffer.byteLength(pageToken) <= 2048 &&
      !/[\x00-\x1f\x7f]/.test(pageToken));
    params.pageToken = pageToken;
  }
  return params;
}

// Host-only transport for one captured DriveAuth grant. Authorization and
// namespace qualification belong to the caller. Only fixtures override origin.
export function createIsolatedBackupDrive({grant, signal: authority}, {origin = DRIVE_ORIGIN} = {}) {
  const token = grant?.tokens?.access_token;
  require(grant?.tokens?.token_type === 'Bearer' && typeof token === 'string' && token.length <= 16384 &&
    /^[\x21-\x7e]+$/.test(token) && authority instanceof AbortSignal && !authority.aborted);
  require(origin === DRIVE_ORIGIN || (typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)));
  const base = new URL(origin);
  const get = origin === DRIVE_ORIGIN ? httpsGet : httpGet;
  const transport = (pathname, params, query, limit) => {
    const url = new URL(pathname, base);
    url.search = new URLSearchParams(params).toString();
    return read(get, url, token, authority, query, limit);
  };
  const file = (query, params, limit) => {
    require(isId(query.id));
    return transport(FILES + '/' + query.id, params, query, limit);
  };
  const list = (kind, properties, query) => bytes(transport(FILES,
    listParams({buddy_isolated: '1', kind, ...properties}, query), query, MAX_METADATA));
  const metadata = query => bytes(file(query, {fields: FILE_FIELDS}, MAX_METADATA));

  return Object.freeze({
    list(query) {
      if (query.kind === 'root') {
        require(query.rootId === null);
        return list('root', {}, query);
      }
      require(query.kind === 'marker' && isId(query.rootId));
      return list('marker', {root: query.rootId}, query);
    },
    readMetadata(query) {
      require(query.kind === 'root' || query.kind === 'marker');
      return metadata(query);
    },
    readMarker: query => bytes(file(query, {alt: 'media'}, MAX_MARKER)),
    listObject(query) {
      require(isId(query.rootId) && isBackup(query.backup) && isDigest(query.sha256));
      return list('object', {root: query.rootId, backup: query.backup, sha256: query.sha256}, query);
    },
    readObjectMetadata: metadata,
    streamObject(query) {
      require(isDigest(query.sha256) && query.signal instanceof AbortSignal);
      const controller = new AbortController();
      const iterator = file({...query, signal: AbortSignal.any([query.signal, controller.signal])},
        {alt: 'media'}, MAX_OBJECT);
      return {
        [Symbol.asyncIterator]() { return this; },
        next: () => iterator.next(),
        return() {
          // Unblock a pending read before asking the generator to finish.
          controller.abort();
          return iterator.return();
        },
      };
    },
  });
}
