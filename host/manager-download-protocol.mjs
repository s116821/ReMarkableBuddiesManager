const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-f0-9]{64}$/;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === keys.toSorted().join();
export const validDownloadTag = tag => typeof tag === 'string' && tag.length <= 64 && TAG.test(tag);
export function parseDownloadRequest(v) {
  const keys = v?.action === 'start' ? ['action', 'tag'] : v?.action === 'cancel' ? ['action', 'operation_id'] : ['action'];
  if (!exact(v, keys) || !['status', 'start', 'cancel'].includes(v.action) || (v.action === 'start' && !validDownloadTag(v.tag)) ||
      (v.action === 'cancel' && (typeof v.operation_id !== 'string' || !ID.test(v.operation_id)))) throw new Error('Download input refused');
  return v;
}
export function downloadState(status = 'unconfigured') {
  return { report_version: 1, status, operation_id: null, tag: null, source_sha: null, folder: null, incomplete: false, update_eligible: false, error: null };
}
export function parseDownloadState(v) {
  if (!exact(v, Object.keys(downloadState())) || v.report_version !== 1 || !['unconfigured','idle','downloading','cancelling','complete','cancelled','failed'].includes(v.status) ||
      v.update_eligible !== false || typeof v.incomplete !== 'boolean' || ![null,'download-refused','setup-unavailable','cancelled'].includes(v.error)) throw new Error('Download report refused');
  const empty = ['unconfigured','idle'].includes(v.status);
  if (empty ? [v.operation_id,v.tag,v.source_sha,v.folder,v.error].some(x=>x!==null) || v.incomplete :
      typeof v.operation_id !== 'string' || !ID.test(v.operation_id) || !validDownloadTag(v.tag) || v.folder !== `manager-download-${v.operation_id}`) throw new Error('Download identity refused');
  if (v.status === 'complete' ? typeof v.source_sha !== 'string' || !/^[a-f0-9]{40}$/.test(v.source_sha) || v.incomplete || v.error !== null : v.source_sha !== null) throw new Error('Download qualification refused');
  if (['downloading','cancelling'].includes(v.status) && (v.incomplete || v.error !== null)) throw new Error('Download pending refused');
  if (v.status === 'cancelled' && v.error !== 'cancelled') throw new Error('Download cancellation refused');
  if (v.status === 'failed' && !['download-refused','setup-unavailable'].includes(v.error)) throw new Error('Download failure refused');
  return { ...v };
}
