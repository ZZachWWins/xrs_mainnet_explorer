import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createArchivePublisher, isEligibleDeploy} from '../src/archive-publisher.mjs';
import deployment, {INITIAL_ARCHIVE} from '../netlify/functions/archive-publish.mjs';

const siteId = '12345678-1234-1234-1234-123456789abc';
const generation = 'a'.repeat(64), chain = 'xeris-mainnet-v4';
const prefix = `chains/${chain}/`, pointerKey = prefix + 'current.json';
const source = `https://mainnetrpc.xerisweb.com/archive-export/${generation}/`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const event = () => ({site: {id: siteId}, deploy: {siteId, context: 'production', branch: 'main',
  state: 'ready', manual: false, id: 'b'.repeat(24), publishedAt: '2026-11-24T22:00:00Z',
  commitRef: 'c'.repeat(40), commitUrl: 'https://github.com/ZZachWWins/xrs_mainnet_explorer/commit/' + 'c'.repeat(40)}});

function fixture(change = () => {}) {
  const contents = new Map([['coverage.json', json({chain_id: chain, indexed_from: 1})],
    ['blocks/0.json', json([{slot: 1, hash: 'd'.repeat(64)}])]]);
  const manifest = {schema_version: 1, chain_id: chain, generation, indexed_from: 1,
    tip: {slot: 1, hash: 'd'.repeat(64)}, coverage: {chain_id: chain, gaps: []},
    files: [...contents].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}))};
  change(manifest);
  const raw = Buffer.concat([json(manifest), Buffer.from('\n')]);
  const archive = {generation, manifestSha256: hash(raw), canonicalManifestSha256: hash(json(manifest)),
    manifestBytes: raw.length, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    tipSlot: 1, tipHash: 'd'.repeat(64), indexedFrom: 1};
  contents.set('manifest.json', raw);
  return {archive, contents, manifest};
}

function memoryStore() {
  const data = new Map(), calls = [];
  let revision = 0;
  const entry = (bytes, etag) => ({bytes: Buffer.from(bytes), etag});
  return {data, calls,
    async get(key) {calls.push(['get', key]); return data.has(key) ? new Response(data.get(key).bytes).body : null;},
    async getWithMetadata(key) {calls.push(['getWithMetadata', key]); const value = data.get(key);
      return value ? {data: new Response(value.bytes).body, etag: value.etag} : null;},
    async set(key, value, options = {}) {calls.push(['set', key]); const prior = data.get(key);
      if ((options.onlyIfNew && prior) || (options.onlyIfMatch && prior?.etag !== options.onlyIfMatch)) return {modified: false};
      const etag = String(++revision); data.set(key, entry(typeof value === 'string' ? Buffer.from(value) : new Uint8Array(value), etag));
      return {modified: true, etag};},
  };
}

function harness(f = fixture(), options = {}) {
  const store = options.store ?? memoryStore(), requests = [];
  let factoryCalls = 0;
  const fetchImpl = async (url, init) => {
    requests.push({url, init}); assert.ok(url.startsWith(source));
    const path = url.slice(source.length), bytes = f.contents.get(path);
    return options.response ? options.response(path, bytes, init) : new Response(bytes, {headers: {'content-length': String(bytes.length)}});
  };
  const run = createArchivePublisher({archive: f.archive, runtimeSiteId: () => siteId,
    fetchImpl, now: options.now, storeFactory: async () => {factoryCalls++; return store;}});
  return {run, store, requests, factoryCalls: () => factoryCalls};
}

test('only same-site published main production GitHub deployments pass the event guard', async () => {
  assert.equal(isEligibleDeploy(event(), siteId), true);
  const changes = [e => {e.site.id = 'other';}, e => {e.deploy.siteId = 'other';},
    e => {e.deploy.context = 'deploy-preview';}, e => {e.deploy.branch = 'test';},
    e => {e.deploy.publishedAt = null;}, e => {e.deploy.manual = true;}, e => {e.deploy.state = 'building';},
    e => {e.deploy.commitUrl = 'https://github.com/attacker/repo/commit/' + e.deploy.commitRef;},
    e => {e.deploy.commitRef = 'not-a-commit';}, e => {e.deploy.id = 'not-a-deploy';}];
  for (const change of changes) {
    const candidate = event(); change(candidate); const h = harness();
    assert.deepEqual(await h.run(candidate), {status: 'ignored'});
    assert.equal(h.factoryCalls(), 0); assert.equal(h.requests.length, 0);
  }
  assert.equal(isEligibleDeploy(event(), undefined), false);
});

test('Function exposes only deploySucceeded, with pinned production archive and no fetch handler', () => {
  assert.deepEqual(Object.keys(deployment), ['deploySucceeded']);
  assert.equal(INITIAL_ARCHIVE.tipSlot, 50257); assert.equal(INITIAL_ARCHIVE.files, 640);
  assert.equal(INITIAL_ARCHIVE.bytes, 46814066);
});

test('initial publication verifies every file and activates only after immutable writes', async () => {
  const f = fixture(), h = harness(f); const result = await h.run(event());
  assert.equal(result.status, 'published'); assert.equal(result.files, 2);
  assert.deepEqual(h.store.calls.filter(([method]) => method === 'set').map(([, key]) => key), [
    prefix + `generations/${generation}/coverage.json`, prefix + `generations/${generation}/blocks/0.json`,
    prefix + `generations/${generation}/manifest.json`, pointerKey]);
  for (const {init} of h.requests) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store'); assert.ok(init.signal instanceof AbortSignal);
  }
});

test('repeated deployment is a no-op without fetching or rewriting the source', async () => {
  const h = harness(); await h.run(event()); const requestCount = h.requests.length;
  const writes = h.store.calls.filter(([method]) => method === 'set').length;
  assert.deepEqual(await h.run(event()), {status: 'already_published', generation});
  assert.equal(h.requests.length, requestCount); assert.equal(h.store.calls.filter(([method]) => method === 'set').length, writes);
});

test('another active generation is preserved, including a newer checkpoint', async () => {
  const h = harness(); await h.run(event()); const value = h.store.data.get(pointerKey), pointer = JSON.parse(value.bytes);
  const oldKey = prefix + `generations/${generation}/manifest.json`;
  const manifest = JSON.parse(h.store.data.get(oldKey).bytes); manifest.generation = 'e'.repeat(64);
  manifest.tip.slot = 2; const bytes = json(manifest);
  h.store.data.set(prefix + `generations/${manifest.generation}/manifest.json`, {bytes, etag: 'other'});
  Object.assign(pointer, {generation: manifest.generation, tip: manifest.tip, manifest_sha256: hash(bytes)});
  h.store.data.set(pointerKey, {bytes: json(pointer), etag: 'other'});
  const before = h.store.calls.length, requestCount = h.requests.length;
  assert.deepEqual(await h.run(event()), {status: 'already_initialized_other_generation'});
  assert.ok(h.store.calls.slice(before).every(([method]) => method !== 'set')); assert.equal(h.requests.length, requestCount);
});

test('wrong exact manifest hash fails before any file or storage write', async () => {
  const f = fixture(); f.contents.set('manifest.json', Buffer.alloc(f.archive.manifestBytes, 32)); const h = harness(f);
  await assert.rejects(h.run(event()), /Pinned manifest mismatch/);
  assert.equal(h.requests.length, 1); assert.equal(h.store.calls.some(([method]) => method === 'set'), false);
});

test('wrong chain, checkpoint, counts or source path cannot be activated', async () => {
  for (const change of [m => {m.chain_id = 'xeris-testnet';}, m => {m.tip.hash = 'e'.repeat(64);},
    m => {m.indexed_from = 0;}, m => {m.files[0].path = '../private.json';}]) {
    const h = harness(fixture(change)); await assert.rejects(h.run(event()));
    assert.equal(h.store.calls.some(([method]) => method === 'set'), false);
  }
  const f = fixture(); f.archive.bytes++; const h = harness(f);
  await assert.rejects(h.run(event()), /checkpoint mismatch/);
});

test('tampered file leaves no activated pointer; partial immutable writes are harmless', async () => {
  const f = fixture(); const bytes = f.contents.get('blocks/0.json'); f.contents.set('blocks/0.json', Buffer.alloc(bytes.length, 32));
  const h = harness(f); await assert.rejects(h.run(event()), /integrity failure/);
  assert.equal(h.store.data.has(pointerKey), false);
  assert.equal(h.store.data.has(prefix + `generations/${generation}/coverage.json`), true);
});

test('oversized streamed and declared bodies, redirects, HTTP errors and empty responses fail closed', async () => {
  for (const response of [(_path, bytes) => new Response(Buffer.concat([bytes, Buffer.from('x')])),
    (_path, bytes) => new Response(bytes, {headers: {'content-length': String(bytes.length + 1)}}),
    () => new Response(null, {status: 302, headers: {location: 'https://other.invalid/'}}),
    () => new Response('error', {status: 503}), () => new Response(null)]) {
    const h = harness(fixture(), {response}); await assert.rejects(h.run(event()));
    assert.equal(h.store.calls.some(([method]) => method === 'set'), false);
  }
});

test('deadline prevents storage activation even when source bytes are otherwise valid', async () => {
  let clock = 0;
  const h = harness(fixture(), {now: () => clock, response: (_path, bytes) => {clock = 13 * 60 * 1000; return new Response(bytes);}});
  await assert.rejects(h.run(event()), /time limit/); assert.equal(h.store.data.has(pointerKey), false);
});

test('error-body cancellation cannot delay refusal when a stream cancel never settles', async () => {
  const h = harness(fixture(), {response: () => new Response(new ReadableStream({
    cancel() {return new Promise(() => {});},
  }), {status: 503})});
  await assert.rejects(h.run(event()), /source unavailable/);
  assert.equal(h.store.data.has(pointerKey), false);
});

test('a concurrent activation wins; the initial publisher never overwrites its pointer', async () => {
  const store = memoryStore(), original = store.set.bind(store);
  store.set = async (key, value, options) => {
    if (key === pointerKey && !store.data.has(key)) store.data.set(key, {bytes: Buffer.from('other-publisher'), etag: 'racer'});
    return original(key, value, options);
  };
  const h = harness(fixture(), {store}); await assert.rejects(h.run(event()), /publication conflict/);
  assert.equal(store.data.get(pointerKey).bytes.toString(), 'other-publisher');
});

test('retry verifies existing immutable bytes and rejects a generation collision', async () => {
  const store = memoryStore(), key = prefix + `generations/${generation}/coverage.json`;
  store.data.set(key, {bytes: Buffer.from('collision'), etag: 'existing'});
  const h = harness(fixture(), {store}); await assert.rejects(h.run(event())); assert.equal(store.data.has(pointerKey), false);
});
