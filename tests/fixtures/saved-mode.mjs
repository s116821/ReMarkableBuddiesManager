import { tablet } from './owned-report.mjs';
import { reduceSavedModeResult } from '../../host/saved-mode.mjs';
import { validateResult } from '../../host/observation-protocol.mjs';
export { tablet };
export const request = () => ({ connection_id: tablet.connection_id, boot_id: tablet.boot_id });
export const actor = 'a1111111-1111-4111-8111-111111111111';
export const device = 'b2222222-2222-4222-8222-222222222222';
export const epoch = 'c3333333-3333-4333-8333-333333333333';
export const group = 'd4444444-4444-4444-8444-444444444444';
export const backup = 'e5555555-5555-4555-8555-555555555555';
export const tokenDigest = '9'.repeat(64);
export const bindingDigest = '8'.repeat(64);
export const rootId = 'PRIVATE_ROOT_ID_CANARY';
export function report(kind = 'local-only') {
  const mode = kind === 'unconfigured' ? null : kind === 'local-only' ? { kind } : kind === 'isolated-backup' ? { kind, backup, binding_sha256: bindingDigest } : { kind, group, binding_sha256: bindingDigest, root_id: rootId };
  return { report_version: 1, operation: 'inspect', status: 'ok', incomplete: false, activation_performed: false,
    data: { current_snapshot: { device: mode ? device : null, epoch: mode ? epoch : null, mode, token: { actor, sha256: tokenDigest } }, receipt: null, receipt_status: null } };
}
export const privateReply = r => ({ contract_version: 1, status: 'observed', observation: tablet, saved_mode: { status: 'reported', report: r } });
export const reply = r => reduceSavedModeResult(privateReply(r), request(), validateResult);
