// Internal, fixed construction choices. Never select a family from a response.
const families = Object.freeze({
  legacy: Object.freeze({version:1, lane:'ordinary-restore', selectors:Object.freeze({prepare:'prepare', apply:'apply', status:'status'})}),
  notebook: Object.freeze({version:2, lane:'notebook-restore', selectors:Object.freeze({prepare:'prepare-notebook', apply:'apply-notebook', status:'status-notebook'})}),
});
export function restoreFamily(name = 'legacy') {
  if (name !== 'legacy' && name !== 'notebook') throw Error('Restore family refused');
  return families[name];
}
