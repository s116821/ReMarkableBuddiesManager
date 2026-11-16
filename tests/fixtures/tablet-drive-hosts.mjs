import assert from 'node:assert/strict';
import {fixture} from './tablet-drive-setup.mjs';

// Synthetic peers below the real HTTP/Electron handlers. The first Apply
// changes the fixture's slot and loses its reply, so only Readback can settle it.
export function tabletDriveHostFixture() {
  const f = fixture({lostReply: true, delayApply: true});
  const begin = f.auth.beginTabletAuthorization;
  const cancel = f.observer.cancel.bind(f.observer);
  const run = f.observer.run.bind(f.observer);
  const replies = [];
  let hold = false, release, starts = 0, finishes = 0, wiredCalls = 0;
  f.auth.beginTabletAuthorization = async () => {
    starts++;
    const value = await begin();
    if (hold) {
      hold = false;
      await new Promise(resolve => { release = resolve; });
      release = null;
    }
    finishes++;
    return value;
  };
  f.observer.observe = async () => ({contract_version: 1, status: 'observed', observation: structuredClone(f.observer.lastObservation)});
  f.observer.cancel = () => {
    cancel();
    return {contract_version: 1, status: 'cancelled', observation: null};
  };
  f.observer.run = (...args) => {
    wiredCalls++;
    return run(...args);
  };
  return {
    auth: f.auth, observer: f.observer, store: f.store, replies,
    completeConsent: f.setAuthReady,
    holdBegin() { assert.ok(!hold && !release); hold = true; },
    releaseBegin() { assert.ok(release); release(); },
    releaseApply: f.release,
    snapshot: () => ({
      starts, finishes, held: typeof release === 'function', cancels: f.auth.cancels, takes: f.auth.takes,
      wiredCalls, wiredCancels: f.observer.cancels,
      applies: f.applyCount, readbacks: f.calls.filter(call => call.request?.action === 'readback').map(call => call.request),
      originals: structuredClone(f.store.value?.originals ?? [])
    })
  };
}
