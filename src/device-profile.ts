import type { ConnectionState } from './observation';
// One resolver for read-only admission; no installed/native compatibility claim.
export function resolveDeviceProfile(connection: ConnectionState) {
  const t = connection.observation;
  return { inspection: connection.status === 'observed' && !!t?.model && !!t.firmware &&
    !t.firmware_conflict && ['armv7l', 'aarch64', 'armv6l'].includes(t.architecture ?? ''),
    installation: false as const, buddyReportSupport: 'probe-required' as const };
}
