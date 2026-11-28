import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createConnectionRecovery, createFreshnessState} from '../src/connection-recovery.mjs';

function harness(connect) {
  let clock = 0, sequence = 0;
  const timers = new Map(), events = [];
  const recovery = createConnectionRecovery({connect, now: () => clock,
    schedule(callback, delay) { const id = ++sequence; timers.set(id, {callback, at: clock + delay, delay}); return id; },
    cancel(id) { timers.delete(id); }, onConnecting() { events.push('connecting'); },
    onConnected() { events.push('connected'); }, onFailure(error, state) { events.push({code: error.code, ...state}); }});
  return {recovery, timers, events,
    async next() { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; timers.delete(id); clock = timer.at; timer.callback(); await Promise.resolve(); await Promise.resolve(); },
    advance(ms) { clock += ms; }};
}

test('transient disconnection reconnects automatically with bounded exponential backoff', async () => {
  let attempts = 0;
  const ui = harness(async () => { if (++attempts < 7) throw {code: 'HTTP_ERROR', retryable: true}; });
  await ui.recovery.start();
  const delays = [];
  while (ui.timers.size) { delays.push([...ui.timers.values()][0].delay); await ui.next(); }
  assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000, 30000]);
  assert.equal(attempts, 7); assert.equal(ui.events.at(-1), 'connected');
  await ui.recovery.retry(); assert.equal(attempts, 8);
});

test('a recovered connection remains available for a later outage without a page reload', async () => {
  let attempts = 0, offline = false;
  const ui = harness(async () => { attempts++; if (offline) throw {code: 'TRANSPORT_ERROR', retryable: true}; });
  await ui.recovery.start(); assert.equal(ui.events.at(-1), 'connected');
  offline = true; await ui.recovery.retry(); assert.equal(ui.timers.size, 1);
  offline = false; await ui.next();
  assert.equal(attempts, 3); assert.equal(ui.events.at(-1), 'connected');
});

test('manual retry coalesces with a pending attempt and clears the automatic timer', async () => {
  let attempts = 0, finish;
  const ui = harness(() => ++attempts === 1 ? Promise.reject({retryable: true}) : new Promise(resolve => { finish = resolve; }));
  await ui.recovery.start(); assert.equal(ui.timers.size, 1);
  const retry = ui.recovery.retry(); assert.equal(ui.timers.size, 0);
  await ui.recovery.retry(); assert.equal(attempts, 2);
  finish(); await retry; assert.equal(ui.events.at(-1), 'connected');
});

test('server Retry-After cannot be bypassed by manual retry', async () => {
  let attempts = 0;
  const ui = harness(async () => { if (++attempts === 1) throw {code: 'RATE_LIMITED', retryable: true, retryAfterMs: 90000}; });
  await ui.recovery.start(); assert.equal([...ui.timers.values()][0].delay, 90000);
  await ui.recovery.retry(); ui.advance(89999); await ui.recovery.retry(); assert.equal(attempts, 1);
  await ui.next(); assert.equal(attempts, 2); assert.equal(ui.events.at(-1), 'connected');
});

test('one live path cannot mark the explorer live while another displayed path remains stale', () => {
  const freshness = createFreshnessState();
  assert.deepEqual(freshness.update({state:'stale',path:'/market/supply',observedAtMs:1000}), {
    state:'stale',observedAtMs:1000,staleCount:1,stalePaths:['/market/supply'],
  });
  const mixed = freshness.update({state:'live',path:'/v2/stats',observedAtMs:5000});
  assert.equal(mixed.state,'stale');assert.equal(mixed.observedAtMs,1000);assert.equal(mixed.staleCount,1);
  const twoStale = freshness.update({state:'stale',path:'/v2/validators',observedAtMs:3000});
  assert.equal(twoStale.state,'stale');assert.equal(twoStale.observedAtMs,1000);assert.equal(twoStale.staleCount,2);
  assert.deepEqual(freshness.retain(['/v2/validators']).stalePaths,['/v2/validators']);
  assert.equal(freshness.update({state:'live',path:'/v2/validators',observedAtMs:6000}).state,'live');
});

test('network identity and malformed-response failures never retry automatically', async () => {
  for (const code of ['NETWORK_MISMATCH', 'INVALID_RESPONSE']) {
    const ui = harness(async () => { throw {code, retryable: false}; });
    await ui.recovery.start(); assert.equal(ui.timers.size, 0);
    assert.equal(ui.events.at(-1).retryable, false);
  }
});

test('navigation cancels scheduled work and ignores a late connection result', async () => {
  const ui = harness(async () => { throw {retryable: true}; });
  await ui.recovery.start(); ui.recovery.stop(); assert.equal(ui.timers.size, 0);
  let resolve; const pending = harness(() => new Promise(done => { resolve = done; }));
  const attempt = pending.recovery.start(); pending.recovery.stop(); resolve(); await attempt;
  assert.deepEqual(pending.events, ['connecting']);
});

test('restoring a stopped document from browser history rechecks its network through a reload', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("window.addEventListener('pagehide'");
  const end = source.indexOf('void mountExplorer()', start);
  assert.ok(start > 0 && end > start);
  const handlers = new Map(); let stopped = 0, reloaded = 0;
  Function('window', 'recovery', 'location', 'freshnessRetryTimer', source.slice(start, end))(
    {addEventListener: (name, handler) => handlers.set(name, handler)},
    {stop: () => stopped++}, {reload: () => reloaded++}, 0);
  handlers.get('pageshow')({persisted: false}); assert.equal(reloaded, 0);
  handlers.get('pagehide')(); assert.equal(stopped, 1);
  handlers.get('pageshow')({persisted: true}); assert.equal(reloaded, 1);
});

test('the normal explorer shell mounts before network recovery and failures retain it', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const mount = source.lastIndexOf('void mountExplorer()'), recovery = source.lastIndexOf('void recovery.start()');
  assert.ok(mount > 0 && recovery > mount);
  const failure = source.slice(source.indexOf('onFailure(error'), source.indexOf("window.addEventListener('online'"));
  assert.ok(failure.indexOf('if (explorerMounted || mountPromise)') < failure.indexOf("document.createElement('main')"));
  assert.match(failure, /Unverified updates will not be displayed/);
});
