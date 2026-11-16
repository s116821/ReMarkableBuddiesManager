import {localModeDigest as digest, localModeUuid as uuid} from './local-mode-choice-protocol.mjs';
import {validateResult} from './observation-protocol.mjs';
import {parseDriveBegin, unavailableDrive} from './drive-protocol.mjs';

const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
const refuse = () => { throw Error('Tablet Drive setup refused'); };
const states = new Set(['none', 'authorizing', 'ready', 'verified', 'observed', 'unchanged', 'unknown',
  'unresolved', 'cancelled', 'unavailable', 'busy', 'refused', 'expired', 'capacity', 'unsupported', 'invalidated', 'recovery-required']);
const same = (left, right) => left && right && left.connection_id === right.connection_id && left.boot_id === right.boot_id;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

export function parseTabletDriveSetupRequest(value) {
  if (!value || bytes(value) > 512) refuse();
  if (value.action === 'retained') {
    if (keys(value) !== 'action') refuse();
  } else if (value.action === 'cancel') {
    if (keys(value) !== 'action,reference' || !digest(value.reference)) refuse();
  } else {
    if (!['begin', 'poll', 'confirm', 'check'].includes(value.action) || !digest(value.connection_id) || !uuid(value.boot_id)) refuse();
    if (value.action === 'begin') {
      if (keys(value) !== 'action,boot_id,connection_id,intent' || !['connect', 'remove'].includes(value.intent)) refuse();
    } else if (keys(value) !== 'action,boot_id,connection_id,reference' || !digest(value.reference)) refuse();
  }
  return value;
}

export function parseTabletDriveSetupResult(value, request) {
  if (keys(value) !== 'contract_version,observation,status,tablet_drive' || bytes(value) > 8192) refuse();
  validateResult({contract_version: value.contract_version, status: value.status, observation: value.observation});
  if (value.status === 'observed' && !same(value.observation, request)) refuse();
  const setup = value.tablet_drive;
  if (keys(setup) !== 'account,authorizationUrl,installed,intent,mode,reference,retained,state' || !states.has(setup.state) ||
      setup.reference !== null && !digest(setup.reference) || setup.intent !== null && !['connect', 'remove'].includes(setup.intent) ||
      setup.installed !== null && typeof setup.installed !== 'boolean' || setup.mode !== null && !['local-only', 'isolated-backup'].includes(setup.mode)) refuse();
  if (setup.account !== null && (keys(setup.account) !== 'label' || typeof setup.account.label !== 'string' ||
      !setup.account.label.length || setup.account.label.length > 320 || /[\x00-\x1f\x7f]/.test(setup.account.label))) refuse();
  if (setup.authorizationUrl !== null) {
    if (setup.state !== 'authorizing' || typeof setup.authorizationUrl !== 'string' || setup.authorizationUrl.length > 4096) refuse();
    parseDriveBegin({state: {...unavailableDrive(), status: 'connecting', error: null}, authorizationUrl: setup.authorizationUrl});
  }
  if (!Array.isArray(setup.retained) || setup.retained.length > 8) refuse();
  const references = new Set();
  for (const retained of setup.retained) {
    if (keys(retained) !== 'boot_id,connection_id,reference,status_available' || !digest(retained.reference) ||
        !digest(retained.connection_id) || !uuid(retained.boot_id) || typeof retained.status_available !== 'boolean' || references.has(retained.reference)) refuse();
    references.add(retained.reference);
  }
  if (['authorizing', 'ready', 'verified', 'observed', 'unchanged'].includes(setup.state) &&
      (!setup.reference || !setup.intent || setup.installed === null || !setup.mode || value.status !== 'observed')) refuse();
  if (['unknown', 'unresolved'].includes(setup.state) && (!setup.reference || !references.has(setup.reference))) refuse();
  if (setup.state === 'ready' && references.has(setup.reference)) refuse();
  if (request.reference && setup.reference !== null && setup.reference !== request.reference) refuse();
  if (request.action === 'retained' && (setup.state !== 'none' || setup.reference !== null || value.status !== 'unconfigured')) refuse();
  return value;
}
