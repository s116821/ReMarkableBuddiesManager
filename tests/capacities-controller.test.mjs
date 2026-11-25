import assert from 'node:assert/strict';
import test from 'node:test';
import { CapacitiesController } from '../src/capacities-auth.ts';
import { currentHost } from '../src/host.ts';

const state = status => ({contract_version:1,status});
function pending() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}
const adapter = values => ({
  status: async () => state('disconnected'),
  begin: async () => state('authorization-failed'),
  cancel: async () => state('canceled'),
  reconcile: async () => state('reconcile-required'),
  ...values,
});

test('reserved browser popup precedes quiescence and canceled or failed quiescence never begins', async t => {
  const calls = [];
  const controller = new CapacitiesController(adapter({
    begin: async () => { throw Error('unprepared begin'); },
    cancel: async () => { throw Error('host cancel before begin'); }
  }), () => {}, () => {
    calls.push('reserve');
    return {
      begin: async () => { calls.push('begin'); return state('awaiting-consent'); },
      close: () => calls.push('close'),
    };
  });
  t.after(() => controller.dispose());
  await controller.refresh();
  await controller.begin(async () => { calls.push('quiesce'); return false; });
  assert.deepEqual(calls,['reserve','quiesce','close']);
  assert.equal(controller.state.status,'disconnected');
  assert.equal(controller.state.pending,null);

  const gate = pending();
  const begin = controller.begin(() => { calls.push('quiesce'); return gate.promise; });
  assert.deepEqual(calls.slice(-2),['reserve','quiesce']);
  await controller.cancel();
  gate.resolve(true);
  await begin;
  assert.equal(calls.includes('begin'),false);
  assert.equal(controller.state.pending,null);
});

test('polling reads status only while host consent is active', async t => {
  const done = pending();
  const calls = [];
  const controller = new CapacitiesController(adapter({
    status: async () => { calls.push('status'); return state(calls.length === 1 ? 'disconnected' : 'connected'); },
    begin: async () => { calls.push('begin'); return state('awaiting-consent'); },
  }), value => { if (value.status === 'connected') done.resolve(); }, undefined, 5);
  t.after(() => controller.dispose());
  await controller.refresh();
  await controller.begin(async () => true);
  assert.equal(controller.state.status,'awaiting-consent');
  await done.promise;
  assert.deepEqual(calls,['status','begin','status']);
  assert.equal(controller.state.status,'connected');
});

test('cancel ignores a late consent response and original check requires quiescence', async t => {
  const late = pending();
  const started = pending();
  let checks = 0;
  let cancels = 0;
  const controller = new CapacitiesController(adapter({
    begin: () => { started.resolve(); return late.promise; },
    cancel: async () => { cancels++; return state('reconcile-required'); },
    reconcile: async () => { checks++; return state('connected'); }
  }), () => {});
  t.after(() => controller.dispose());
  await controller.refresh();
  const begin = controller.begin(async () => true);
  await started.promise;
  const stop = controller.cancel();
  assert.equal(cancels,0);
  late.resolve(state('awaiting-consent'));
  await stop;
  await begin;
  assert.equal(cancels,1);
  assert.equal(controller.state.status,'reconcile-required');
  await controller.reconcile(async () => false);
  assert.equal(checks,0);
  assert.equal(controller.state.status,'reconcile-required');
  await controller.reconcile(async () => true);
  assert.equal(checks,1);
  assert.equal(controller.state.status,'connected');
});

test('a previous connection is not confirmed for this renderer and a fresh tablet can begin', async t => {
  let begins = 0;
  const confirmed = [];
  const controller = new CapacitiesController(adapter({
    status: async () => state('connected'),
    begin: async () => { begins++; return state('connected'); },
  }), (value, ownsConfirmation) => { if (ownsConfirmation) confirmed.push(value.status); });
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.deepEqual(confirmed,[]);
  await controller.begin(async () => true);
  assert.equal(begins,0);
  await controller.begin(async () => true,true);
  assert.equal(begins,1);
  assert.deepEqual(confirmed,['connected']);
});

test('an unowned reconciliation can display a historical connection without confirming this tablet', async t => {
  const confirmed = [];
  const controller = new CapacitiesController(adapter({
    status: async () => state('reconcile-required'),
    reconcile: async () => state('connected'),
  }), (value, ownsConfirmation) => { if (ownsConfirmation) confirmed.push(value.status); });
  t.after(() => controller.dispose());
  await controller.refresh();
  await controller.reconcile(async () => true,false);
  assert.equal(controller.state.status,'connected');
  assert.deepEqual(confirmed,[]);
});

test('pagehide and teardown cancel admitted local flows only', async () => {
  const canceled = pending();
  let cancels = 0;
  const outside = new CapacitiesController(adapter({
    status: async () => state('awaiting-consent'),
    cancel: async () => { cancels++; return state('canceled'); }
  }), () => {});
  await outside.refresh();
  outside.pageHidden();
  outside.dispose();
  assert.equal(cancels,0);

  const owned = new CapacitiesController(adapter({
    begin: async () => state('awaiting-consent'),
    cancel: async () => { cancels++; canceled.resolve(); return state('reconcile-required'); }
  }), () => {});
  await owned.refresh();
  await owned.begin(async () => true);
  owned.pageHidden();
  owned.dispose();
  await canceled.promise;
  assert.equal(cancels,1);
});

test('browser begin opens only the fixed same-origin ticket URL after a closed host response', async t => {
  const events = [];
  let reply;
  const popup = {
    opener: {}, closed:false,
    close() { this.closed = true; },
    location: {replace(url) { events.push(url); }}
  };
  const originals = {window:globalThis.window,location:globalThis.location,fetch:globalThis.fetch};
  const origin = 'http://127.0.0.1:8123';
  globalThis.location = new URL(origin);
  globalThis.window = {open(url,target) { events.push([url,target]); return popup; }};
  globalThis.fetch = async (route,options) => {
    events.push(options.body);
    assert.equal(route,'/manager-capacities');
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.redirect,'error');
    const requested = JSON.parse(options.body);
    if (requested.action === 'cancel') {
      assert.equal(options.keepalive,true);
      return Response.json(state('canceled'));
    }
    if (requested.action === 'status' || requested.action === 'reconcile') {
      return Response.json(state(requested.launchId ? 'selection-changed' : 'connected'));
    }
    return Response.json(await reply);
  };
  t.after(() => {
    for (const [name,value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });

  const host = currentHost();
  const ticket = 'c'.repeat(32);
  const launch = host.prepareCapacitiesBegin();
  assert.equal(popup.opener,null);
  assert.deepEqual(events,[['about:blank','_blank']]);
  reply = {state:state('awaiting-consent'),launchId:ticket};
  assert.deepEqual(await launch.begin(),state('awaiting-consent'));
  assert.deepEqual(events,[['about:blank','_blank'],'{"action":"begin"}',origin+'/manager-capacities-open?launch='+ticket]);
  launch.close();
  assert.equal(popup.closed,false);

  reply = {state:state('awaiting-consent'),launchId:ticket,authorizationUrl:'https://untrusted.invalid'};
  const refused = host.prepareCapacitiesBegin();
  await assert.rejects(refused.begin());
  refused.close();
  assert.equal(popup.closed,true);
  assert.equal(events.filter(value => typeof value === 'string' && value.includes('/manager-capacities-open')).length,1);

  popup.closed = false;
  const next = currentHost();
  const gated = pending();
  reply = gated.promise;
  const closing = next.prepareCapacitiesBegin();
  const underway = closing.begin();
  closing.close();
  const newTicket = 'd'.repeat(32);
  gated.resolve({state:state('awaiting-consent'),launchId:newTicket});
  assert.equal((await underway).status,'canceled');
  assert.equal(events.at(-1),JSON.stringify({action:'cancel',launchId:newTicket}));
  assert.equal(events.filter(value => typeof value === 'string' && value.includes('/manager-capacities-open')).length,1);
  assert.equal((await next.capacitiesAuth.status()).status,'selection-changed');
  assert.equal(events.at(-1),JSON.stringify({action:'status',launchId:newTicket}));
  assert.equal((await next.capacitiesAuth.reconcile()).status,'selection-changed');
  assert.equal(events.at(-1),JSON.stringify({action:'reconcile',launchId:newTicket}));
  assert.equal(next.hasCapacitiesLaunch(),true);
  const unowned = currentHost();
  assert.equal((await unowned.capacitiesAuth.cancel()).status,'connected');
  assert.equal(events.at(-1),'{"action":"status"}');
  assert.equal((await unowned.capacitiesAuth.reconcile()).status,'connected');
  assert.equal(events.at(-1),'{"action":"reconcile"}');
  assert.equal(unowned.hasCapacitiesLaunch(),false);
});
