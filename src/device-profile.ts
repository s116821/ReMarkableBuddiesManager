import type { ConnectionState } from './observation';
// One resolver for wired CLI probes; no installed/native compatibility claim.
export function resolveDeviceProfile(connection: ConnectionState) {
  const t = connection.observation;
  const admitted = connection.status === 'observed' && !!t?.model && !!t.firmware &&
    !t.firmware_conflict && ['armv7l', 'aarch64', 'armv6l'].includes(t.architecture ?? '');
  return { savedModeProbe: admitted, memoryQueryProbe: admitted, runtimeIdentityProbe: admitted, inspection: admitted, personalizationProbe: admitted, personalizationReportSupport: 'probe-required' as const,
    installation: false as const, buddyReportSupport: 'probe-required' as const };
}
