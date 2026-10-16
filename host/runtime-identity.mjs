export function parseRuntimeIdentity(v) {
  if (!v || Object.keys(v).sort().join() !== 'binary_version,installation_eligible,package_owner,provenance,report_version,running_version,status' || v.report_version !== 1 ||
      !['reported', 'missing', 'unsafe', 'unsupported', 'unavailable'].includes(v.status) || v.installation_eligible !== false || v.package_owner !== 'unknown' || v.provenance !== 'unknown' || v.running_version !== null ||
      (v.status === 'reported' ? typeof v.binary_version !== 'string' || v.binary_version.length > 96 || !/^(?:v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?|dev\.(?:unknown|v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+-g[0-9a-f]{7,40})?(?:-dirty)?|[0-9a-f]{7,40}(?:-dirty)?))$/.test(v.binary_version) : v.binary_version !== null)) throw new Error('Unsupported binary identity report');
  return v;
}
