export const statuses = new Set(['unconfigured', 'unsupported-host', 'disconnected', 'untrusted', 'authentication-required', 'timeout', 'cancelled', 'cable-lost', 'observation-unavailable', 'observed']);
export const result = (status, observation = null) => ({ contract_version: 1, status, observation });
export function validateResult(value) {
  if (!value || value.contract_version !== 1 || !statuses.has(value.status) || Object.keys(value).sort().join() !== 'contract_version,observation,status') throw new Error('Invalid observation');
  if (value.status !== 'observed') {
    if (value.observation !== null) throw new Error('Invalid observation');
    return value;
  }
  const o = value.observation;
  if (!o || Object.keys(o).sort().join() !== 'architecture,boot_id,connection_id,firmware,firmware_conflict,installed_version,model,provenance,service' ||
      !/^[a-f0-9]{64}$/.test(o.connection_id) || !/^[a-f0-9-]{36}$/.test(o.boot_id) ||
      o.installed_version !== null || o.provenance !== 'unknown' || typeof o.firmware_conflict !== 'boolean') throw new Error('Invalid observation');
  for (const key of ['model', 'firmware', 'architecture']) if (o[key] !== null && (typeof o[key] !== 'string' || !/^[A-Za-z0-9 ._()+/-]{1,96}$/.test(o[key]))) throw new Error('Invalid observation');
  if (!o.service || Object.keys(o.service).sort().join() !== 'ActiveState,LoadState,SubState') throw new Error('Invalid observation');
  for (const value of Object.values(o.service)) if (value !== null && (typeof value !== 'string' || !/^[a-z-]{1,32}$/.test(value))) throw new Error('Invalid observation');
  return value;
}

