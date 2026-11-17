import {validateResult} from './observation-protocol.mjs';

export function parseRuntimeReport(value,tablet) {
  if (!value || Object.keys(value).sort().join() !== 'contract_version,observation,runtime_identity,status') throw new Error('Unsupported runtime report');
  validateResult({ contract_version: value.contract_version, status: value.status, observation: value.observation });
  if (value.status !== 'observed' || !value.observation || value.observation.boot_id !== tablet.boot_id || value.observation.connection_id !== tablet.connection_id) return {status:'Binary version unavailable — read tablet state again',report:null};
  const report=parseRuntimeIdentity(value.runtime_identity);
  return {status:report.status === 'reported' ? 'Binary version reported — unverified' : `Binary identity ${report.status}`,report};
}

export function parseRuntimeIdentity(v) {
  if (!v || Object.keys(v).sort().join() !== 'binary_version,installation_eligible,package_owner,provenance,report_version,running_version,status' || v.report_version !== 1 ||
      !['reported', 'missing', 'unsafe', 'unsupported', 'unavailable'].includes(v.status) || v.installation_eligible !== false || v.package_owner !== 'unknown' || v.provenance !== 'unknown' || v.running_version !== null ||
      (v.status === 'reported' ? typeof v.binary_version !== 'string' || v.binary_version.length > 96 || !/^(?:v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?|dev\.(?:unknown|v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+-g[0-9a-f]{7,40})?(?:-dirty)?|[0-9a-f]{7,40}(?:-dirty)?))$/.test(v.binary_version) : v.binary_version !== null)) throw new Error('Unsupported binary identity report');
  return v;
}
