import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryBlobAdapter, validateManifest, safeArchivePath, verifyLocalExport } from './blobs.mjs';

const chainId = 'xeris-mainnet-v4';
const prefix = `chains/${chainId}/`;
const pointerKey = prefix + 'current.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value));
const stream = body => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(body)); controller.close(); } });
class Store {
  constructor() { this.entries = new Map(); this.calls = []; this.version = 0; }
  async get(key, options) {
    this.calls.push({ op: 'get', key, options });
    const row = this.entries.get(key); return row ? stream(row.body) : null;
  }
  async getWithMetadata(key, options) {
    this.calls.push({ op: 'getWithMetadata', key, options });
    const row = this.entries.get(key); return row ? { data: stream(row.body), etag: row.etag, metadata: {} } : null;
  }
  async set(key, value, options = {}) {
    this.calls.push({ op: 'set', key, options });
    if (this.beforeSet) await this.beforeSet(key);
    if (this.failKey === key) throw new Error('Injected write failure');
    const prior = this.entries.get(key);
    if (options.onlyIfNew && prior || options.onlyIfMatch && prior?.etag !== options.onlyIfMatch) return { modified: false };
    const etag = '"' + (++this.version) + '"';
    this.entries.set(key, { body: Buffer.from(value), etag }); return { modified: true, etag };
  }
}
function fixture(generation = 'g1', slot = 33971) {
  const payloads = new Map([
    ['coverage.json', bytes({ indexed_from: 33970, indexed_through: slot, gaps: [] })],
    ['blocks/33.json', bytes({ '33970': { slot: 33970, total_raw: '18446744073709551615' } })],
    ['hashes/aa.json', bytes({ ['a'.repeat(64)]: 33970 })],
  ]);
  const manifest = { schema_version: 1, chain_id: chainId, indexed_from: 33970,
    tip: { slot, hash: 'b'.repeat(64) }, coverage: { block_shard_size: 1000, list_page_size: 100 }, generation,
    files: [...payloads].map(([path, body]) => ({ path, sha256: digest(body), bytes: body.length })) };
  return { manifest, payloads, readFile: async path => payloads.get(path) };
}

test('publication preserves exact bytes and activates only after all immutable files and manifest', async () => {
  const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store }), exportData = fixture();
  assert.equal(store.calls.length, 0, 'constructing an adapter performs no remote operations');
  const result = await adapter.publish(exportData.manifest, exportData.readFile, { expectedGeneration: null });
  assert.equal(result.files, 3);
  const writes = store.calls.filter(call => call.op === 'set');
  assert.deepEqual(writes.map(call => call.key), ['coverage.json', 'blocks/33.json', 'hashes/aa.json', 'manifest.json'].map(path => prefix + 'generations/g1/' + path).concat(pointerKey));
  assert.ok(writes.every(call => call.options.onlyIfNew === true));
  assert.equal((await adapter.readCurrent()).manifest.generation, 'g1');
  assert.equal((await adapter.readJSON('blocks/33.json')).data['33970'].total_raw, '18446744073709551615');
  assert.ok(store.calls.filter(call => call.op.startsWith('get')).every(call => call.options.consistency === 'strong'));
});

test('failed upload leaves the previous generation active and cannot expose a partial new generation', async () => {
  const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store }), first = fixture();
  await adapter.publish(first.manifest, first.readFile);
  const prior = Buffer.from(store.entries.get(pointerKey).body), next = fixture('g2', 33972);
  store.failKey = prefix + 'generations/g2/blocks/33.json';
  await assert.rejects(adapter.publish(next.manifest, next.readFile), /Injected write failure/);
  assert.deepEqual(store.entries.get(pointerKey).body, prior);
  assert.equal((await adapter.readCurrent()).manifest.generation, 'g1');
  assert.equal(store.entries.has(prefix + 'generations/g2/manifest.json'), false);
});

test('activation uses compare-and-swap so a concurrent publisher cannot be overwritten', async () => {
  const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store }), first = fixture();
  await adapter.publish(first.manifest, first.readFile);
  const next = fixture('g2', 33972);
  store.beforeSet = async key => {
    if (key === pointerKey) { store.entries.get(key).etag = '"concurrent-writer"'; store.beforeSet = null; }
  };
  await assert.rejects(adapter.publish(next.manifest, next.readFile, { expectedGeneration: 'g1' }), /publication conflict/);
  assert.equal(JSON.parse(store.entries.get(pointerKey).body).generation, 'g1');
  assert.ok(store.calls.filter(call => call.op === 'set' && call.key === pointerKey).at(-1).options.onlyIfMatch);
});

test('generation bytes are immutable and an existing same-key mismatch aborts activation', async () => {
  const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store }), exportData = fixture();
  await store.set(prefix + 'generations/g1/coverage.json', '{"unrelated":true}');
  await assert.rejects(adapter.publish(exportData.manifest, exportData.readFile), /Immutable archive generation collision/);
  assert.equal(store.entries.has(pointerKey), false);
});

test('retries are idempotent and readers can retain a complete prior-generation snapshot', async () => {
  const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store }), first = fixture();
  await adapter.publish(first.manifest, first.readFile); await adapter.publish(first.manifest, first.readFile);
  const next = fixture('g2', 33972); await adapter.publish(next.manifest, next.readFile);
  assert.equal((await adapter.readCurrent()).manifest.generation, 'g2');
  assert.equal((await adapter.readJSON('coverage.json', { generation: 'g1' })).data.indexed_through, 33971);
  assert.equal((await adapter.readJSON('coverage.json')).data.indexed_through, 33972);
  await assert.rejects(adapter.publish(first.manifest, first.readFile), /tip regression/);
  await assert.rejects(adapter.publish(next.manifest, next.readFile, { expectedGeneration: 'g1' }), /changed before publication/);
});

test('wrong chains, traversal, reserved keys and resource-limit violations fail before uploads', async () => {
  const base = fixture();
  for (const path of ['../key.json', '/etc/key.json', 'a//b.json', 'a/../b.json', 'a\\b.json', 'manifest.json', 'data%2fkey.json', 'file.txt']) assert.equal(safeArchivePath(path), false);
  for (const modify of [
    manifest => { manifest.chain_id = 'xeris-testnet'; },
    manifest => { delete manifest.generation; },
    manifest => { manifest.generation = '../next'; },
    manifest => { manifest.files[0].path = '../key.json'; },
    manifest => { manifest.tip.hash = [manifest.tip.hash]; },
    manifest => { manifest.files.push(manifest.files[0]); },
    manifest => { manifest.files[0].bytes = 9 * 1024 * 1024; },
    manifest => { manifest.tip.slot = 1; },
  ]) {
    const manifest = structuredClone(base.manifest); modify(manifest);
    const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store });
    await assert.rejects(adapter.publish(manifest, base.readFile)); assert.equal(store.calls.length, 0);
  }
  assert.throws(() => validateManifest(base.manifest, chainId, { totalBytes: 1 }), /total size/);
  assert.throws(() => validateManifest(base.manifest, chainId, { files: 1 }), /manifest/);
  assert.throws(() => createHistoryBlobAdapter(), /namespace/);
});

test('payload corruption, unexpected files and pointer mismatches never return archive data', async () => {
  const store = new Store(), adapter = createHistoryBlobAdapter({ chainId, store }), exportData = fixture();
  await adapter.publish(exportData.manifest, exportData.readFile);
  const original = store.entries.get(prefix + 'generations/g1/coverage.json');
  original.body = Buffer.from(original.body); original.body[1] = 32;
  await assert.rejects(adapter.readJSON('coverage.json'), /integrity failure/);
  const calls = store.calls.length;
  await assert.rejects(adapter.readJSON('private.json', { generation: 'g1' }), /not listed/);
  assert.equal(store.calls.length, calls);
  const pointer = JSON.parse(store.entries.get(pointerKey).body); pointer.manifest_sha256 = 'c'.repeat(64);
  store.entries.get(pointerKey).body = bytes(pointer);
  await assert.rejects(adapter.readCurrent(), /does not match/);
  pointer.chain_id = 'xeris-testnet'; store.entries.get(pointerKey).body = bytes(pointer);
  await assert.rejects(adapter.readCurrent(), /Invalid archive pointer/);
});

test('local verification confines reads to listed regular files and does not need Netlify credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xeris-public-export-'));
  try {
    const exportData = fixture();
    for (const [path, body] of exportData.payloads) {
      await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), body);
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(exportData.manifest));
    const result = await verifyLocalExport(directory, chainId);
    assert.equal(result.remote_writes, 0); assert.equal(result.files, 3);
    await rm(join(directory, 'coverage.json'));
    await symlink(join(directory, 'blocks/33.json'), join(directory, 'coverage.json'));
    await assert.rejects(verifyLocalExport(directory, chainId), /symlinks/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
