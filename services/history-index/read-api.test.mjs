import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryApiHandler } from './read-api.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let number = BigInt('0x' + bytes.toString('hex')), encoded = '';
  while (number) { encoded = ALPHABET[Number(number % 58n)] + encoded; number /= 58n; }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + encoded;
}
const address = base58(Buffer.alloc(32, 7));
const otherAddress = base58(Buffer.alloc(32, 8));
const signature = slot => base58(Buffer.alloc(64, slot));
const blockHash = slot => slot.toString(16).padStart(64, '0');

function fixture(generation, count = 101) {
  const tip = { slot: count, hash: blockHash(count) }, files = new Map();
  const coverage = { indexed_from: 1, tip, counts: { blocks: count, transactions: count }, gaps: [], block_shard_size: 1000, list_page_size: 100 };
  const blocks = Array.from({ length: count }, (_, i) => ({ slot: i + 1, hash: blockHash(i + 1), transactions: [signature(i + 1)] }));
  const transactions = blocks.map(block => ({ signature: signature(block.slot), slot: block.slot, block_hash: block.hash, status: 'confirmed', amount_raw: '18446744073709551615' }));
  files.set('coverage.json', coverage);
  files.set('blocks/0.json', Object.fromEntries(blocks.map(block => [String(block.slot), block])));
  files.set('hashes/00.json', Object.fromEntries(blocks.map(block => [block.hash, block.slot])));
  for (const tx of transactions) files.set(`transactions/${tx.signature}.json`, tx);
  for (const [prefix, records] of [['lists/blocks', blocks], ['lists/transactions', transactions], [`addresses/${address}`, transactions]]) {
    const ordered = [...records].reverse();
    for (let offset = 0; offset < ordered.length; offset += 100) {
      files.set(`${prefix}/${offset / 100 + 1}.json`, { data: ordered.slice(offset, offset + 100), cursor: offset + 100 < ordered.length ? 'private-sqlite-cursor' : null, snapshot_tip: tip, coverage });
    }
  }
  const manifest = { schema_version: 1, chain_id: 'xeris-mainnet-v4', generation, indexed_from: 1, tip, coverage,
    files: [...files.keys()].map(path => ({ path, bytes: 1, sha256: '0'.repeat(64) })) };
  return { manifest, files };
}

function fakeAdapter(generations = [fixture('generation-a'), fixture('generation-b', 102)]) {
  const archives = new Map(generations.map(value => [value.manifest.generation, value]));
  const state = { current: generations[0]?.manifest.generation ?? null, calls: [] };
  const adapter = {
    async readCurrent() { state.calls.push(['current']); return state.current ? { manifest: archives.get(state.current).manifest, etag: 'etag' } : null; },
    async readGeneration(generation) { state.calls.push(['generation', generation]); if (!archives.has(generation)) throw new Error('Archive generation is unavailable'); return archives.get(generation).manifest; },
    async readJSON(path, { generation }) {
      state.calls.push(['json', generation, path]);
      const value = archives.get(generation)?.files.get(path);
      if (value === undefined) throw new Error('Missing stored file');
      return { generation, data: value };
    },
  };
  return { adapter, archives, state };
}

async function request(handler, path, options) {
  const response = await handler(new Request('https://explorer.example' + path, options));
  return { response, body: await response.json() };
}

test('coverage, slot/hash lookups, and complete transaction records use only fixed export paths', async () => {
  const { adapter, state } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  const coverage = await request(handler, '/api/history/coverage');
  assert.equal(coverage.response.status, 200);
  assert.deepEqual(coverage.body.data, coverage.body.coverage);
  assert.equal(coverage.body.generation, 'generation-a');
  const slot = await request(handler, '/api/history/block/1');
  const hash = await request(handler, '/api/history/block/' + blockHash(1)); // An all-digit hash remains a hash.
  assert.equal(hash.response.status, 200);
  assert.deepEqual(hash.body.data, slot.body.data);
  assert.deepEqual(state.calls.slice(-3), [['current'], ['json', 'generation-a', 'hashes/00.json'], ['json', 'generation-a', 'blocks/0.json']]);
  const tx = await request(handler, '/api/history/transaction/' + signature(1));
  assert.equal(tx.body.data.signature, signature(1));
  assert.equal(tx.body.data.amount_raw, '18446744073709551615');
  assert.equal(tx.response.headers.get('cache-control'), 'no-store');
  assert.equal(tx.response.headers.get('access-control-allow-origin'), null);
});

test('block pagination stays on the original immutable generation after pointer advancement', async () => {
  const { adapter, state } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  const first = await request(handler, '/api/history/blocks');
  assert.equal(first.body.data.length, 100);
  assert.equal(first.body.data[0].slot, 101);
  assert.equal(first.body.page_size, 100);
  assert.notEqual(first.body.cursor, 'private-sqlite-cursor');
  state.current = 'generation-b'; state.calls.length = 0;
  const second = await request(handler, '/api/history/blocks?cursor=' + first.body.cursor);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.generation, 'generation-a');
  assert.deepEqual(second.body.data.map(block => block.slot), [1]);
  assert.equal(second.body.coverage.tip.slot, 101);
  assert.equal(second.body.cursor, null);
  assert.deepEqual(state.calls, [['generation', 'generation-a'], ['json', 'generation-a', 'lists/blocks/2.json']]);
  const fresh = await request(handler, '/api/history/blocks');
  assert.equal(fresh.body.generation, 'generation-b');
  assert.equal(fresh.body.data[0].slot, 102);
});

test('transaction/address pagination is generation-bound and cursors cannot cross routes or addresses', async () => {
  const { adapter, state } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  const transactions = await request(handler, '/api/history/transactions');
  const account = await request(handler, '/api/history/address/' + address);
  state.current = 'generation-b';
  const next = await request(handler, '/api/history/address/' + address + '?cursor=' + account.body.cursor);
  assert.equal(next.body.generation, 'generation-a');
  assert.deepEqual(next.body.data.map(tx => tx.slot), [1]);
  const txNext = await request(handler, '/api/history/transactions?cursor=' + transactions.body.cursor);
  assert.deepEqual(txNext.body.data.map(tx => tx.slot), [1]);
  for (const path of ['/api/history/blocks?cursor=' + transactions.body.cursor,
    '/api/history/address/' + otherAddress + '?cursor=' + account.body.cursor,
    '/api/history/address/' + address + '?cursor=' + transactions.body.cursor]) {
    state.calls.length = 0;
    const result = await request(handler, path);
    assert.equal(result.response.status, 400);
    assert.deepEqual(state.calls, []);
  }
});

test('search resolves slots, hashes, signatures, and addresses with usable address continuation', async () => {
  const { adapter, state } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  for (const [q, type] of [['1', 'block'], [blockHash(1), 'block'], [signature(1), 'transaction'], [address, 'address']]) {
    const result = await request(handler, '/api/history/search?q=' + q);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.type, type);
    assert.equal(result.body.generation, 'generation-a');
  }
  const account = await request(handler, '/api/history/search?q=' + address);
  assert.equal(account.body.data.address, address);
  assert.equal(account.body.data.transactions.length, 100);
  state.current = 'generation-b';
  const next = await request(handler, '/api/history/address/' + address + '?cursor=' + account.body.data.cursor);
  assert.equal(next.body.generation, 'generation-a');
  assert.equal(next.body.data[0].slot, 1);
});

test('unindexed records are honest 404 responses with the selected generation coverage', async () => {
  const { adapter, state } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  for (const path of ['/block/999', '/block/' + 'f'.repeat(64), '/transaction/' + signature(250), '/address/' + otherAddress, '/search?q=' + signature(250)]) {
    const result = await request(handler, '/api/history' + path);
    assert.equal(result.response.status, 404, path);
    assert.equal(result.body.error.code, 'not_indexed');
    assert.equal(result.body.generation, 'generation-a');
    assert.equal(result.body.coverage.indexed_from, 1);
  }
  // Unlisted keys are never probed remotely.
  const missing = new Set([`transactions/${signature(250)}.json`, `addresses/${otherAddress}/1.json`, 'hashes/ff.json']);
  assert.equal(state.calls.some(call => call[0] === 'json' && missing.has(call[2])), false);
});

test('invalid methods, parameters, paths, identifiers and cursors fail before storage access', async () => {
  const { adapter, state } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  const post = await request(handler, '/api/history/blocks', { method: 'POST', body: 'ignored' });
  assert.equal(post.response.status, 405);
  assert.equal(post.response.headers.get('allow'), 'GET');
  assert.equal(post.body.generation, null);
  assert.equal(post.body.coverage, null);
  for (const path of ['/api/history/blocks?limit=1', '/api/history/blocks?cursor=', '/api/history/blocks?cursor=x&cursor=y',
    '/api/history/block/0', '/api/history/block/9007199254740992', '/api/history/block/%2fprivate',
    '/api/history/transaction/' + '1'.repeat(63), '/api/history/address/' + '1'.repeat(44),
    '/api/history/search', '/api/history/search?q=', '/api/history/search?q=foo&q=bar', '/api/history/search?q=https://example.com',
    '/api/history/blocks?cursor=' + 'a'.repeat(1025)]) {
    const result = await request(handler, path);
    assert.equal(result.response.status, 400, path);
    assert.ok(Object.hasOwn(result.body, 'coverage'));
    assert.ok(Object.hasOwn(result.body, 'generation'));
  }
  for (const path of ['/api/history-no/blocks', '/api/history/anything', '/api/history/blocks/extra']) {
    assert.equal((await request(handler, path)).response.status, 404);
  }
  assert.deepEqual(state.calls, []);
});

test('missing generations and corrupt/listed storage fail closed without exposing internal errors', async () => {
  const { adapter, state, archives } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  const first = await request(handler, '/api/history/blocks');
  archives.delete('generation-a');
  const expired = await request(handler, '/api/history/blocks?cursor=' + first.body.cursor);
  assert.equal(expired.response.status, 410);
  assert.equal(expired.body.error.code, 'generation_unavailable');
  state.current = null;
  assert.equal((await request(handler, '/api/history/coverage')).response.status, 503);
  state.current = 'generation-b';
  archives.get('generation-b').files.delete('blocks/0.json');
  const missing = await request(handler, '/api/history/block/1');
  assert.equal(missing.response.status, 503);
  assert.equal(missing.body.generation, 'generation-b');
  adapter.readJSON = async () => { throw new Error('private-token=should-not-escape'); };
  const failure = await request(handler, '/api/history/transactions');
  assert.equal(failure.response.status, 503);
  assert.equal(JSON.stringify(failure.body).includes('should-not-escape'), false);
  adapter.readJSON = async () => ({ generation: 'wrong-generation', data: {} });
  assert.equal((await request(handler, '/api/history/transactions')).response.status, 503);
});

test('a missing continuation shard or mismatched block identity is storage corruption, not empty history', async () => {
  const { adapter, archives } = fakeAdapter(), handler = createHistoryApiHandler({ adapter });
  const archive = archives.get('generation-a');
  archive.manifest.files = archive.manifest.files.filter(file => file.path !== 'lists/blocks/2.json');
  assert.equal((await request(handler, '/api/history/blocks')).response.status, 503);
  archive.files.get('blocks/0.json')['1'] = { slot: 2, hash: blockHash(1) };
  assert.equal((await request(handler, '/api/history/block/1')).response.status, 503);
  delete archive.files.get('blocks/0.json')['1'];
  assert.equal((await request(handler, '/api/history/block/' + blockHash(1))).response.status, 503);
});

test('construction has no storage side effects and an explicit custom base path is supported', async () => {
  const { adapter, state } = fakeAdapter();
  const handler = createHistoryApiHandler({ adapter, basePath: '/history/v1' });
  assert.deepEqual(state.calls, []);
  assert.equal((await request(handler, '/history/v1/coverage')).response.status, 200);
  assert.equal((await request(handler, '/api/history/coverage')).response.status, 404);
  assert.throws(() => createHistoryApiHandler({ adapter, basePath: '../history' }));
  assert.throws(() => createHistoryApiHandler({ adapter: {} }));
});
