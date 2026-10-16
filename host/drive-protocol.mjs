export const DRIVE_STATUSES = Object.freeze(['unconfigured', 'disconnected', 'connecting', 'cached', 'connected', 'checking',
  'cancelled', 'expired', 'denied', 'authorization-failed', 'unavailable', 'revoking', 'revocation-unconfirmed']);
export const DRIVE_ACTIONS = Object.freeze(['status', 'begin', 'cancel', 'check', 'disconnect', 'revoke']);
export function parseDriveState(v) {
  if (!v || Object.keys(v).sort().join() !== 'account,authorizationId,backupReady,checkedAt,contract_version,error,status' || v.contract_version !== 1 ||
    !DRIVE_STATUSES.includes(v.status) || v.backupReady !== false ||
    (v.authorizationId !== null && (typeof v.authorizationId !== 'string' || !/^[a-f0-9]{64}$/.test(v.authorizationId))) ||
    (v.error !== null && !['storage-unavailable', 'configuration-unavailable', 'cancelled', 'authorization-failed', 'authorization-required', 'revocation-unconfirmed'].includes(v.error)) ||
    (v.checkedAt !== null && (typeof v.checkedAt !== 'string' || !Number.isFinite(Date.parse(v.checkedAt)))) ||
    (v.account !== null && (!v.account || Object.keys(v.account).join() !== 'label' || typeof v.account.label !== 'string' || !v.account.label.length || v.account.label.length > 320 || /[\x00-\x1f\x7f]/.test(v.account.label)))) throw new Error('Invalid Drive state');
  if (['cached', 'connected'].includes(v.status) && (!v.account || !v.checkedAt || !v.authorizationId)) throw new Error('Invalid Drive state');
  return v;
}
export function parseDriveBegin(v) {
  if (!v || Object.keys(v).sort().join() !== 'authorizationUrl,state') throw new Error('Invalid Drive begin');
  parseDriveState(v.state);
  if (v.authorizationUrl !== null) {
    const u = new URL(v.authorizationUrl);
    const allowed = new Set(['client_id', 'response_type', 'redirect_uri', 'access_type', 'prompt', 'scope', 'state', 'code_challenge', 'code_challenge_method']);
    const keys = [...u.searchParams.keys()];
    if (keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length) throw new Error('Invalid Drive consent parameters');
    if (typeof v.authorizationUrl !== 'string' || v.authorizationUrl.length > 4096 || u.origin !== 'https://accounts.google.com' ||
      u.pathname !== '/o/oauth2/v2/auth' || u.username || u.password || u.hash || v.state.status !== 'connecting') throw new Error('Invalid Drive consent URL');
  }
  return v;
}
export const unavailableDrive = () => ({ contract_version: 1, status: 'unavailable', account: null, checkedAt: null, authorizationId: null, error: 'configuration-unavailable', backupReady: false });
