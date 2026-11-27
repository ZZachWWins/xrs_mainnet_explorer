import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_NETWORK, NETWORKS, selectedNetwork, networkLink, verifyCheckpoint, parsePublicJSON, rawUnits} from '../src/network.mjs';
import {routeRequest, proxyResponse, boundedBody} from '../src/proxy.mjs';
import {createExplorerAPI, normalizeContract} from '../src/explorer-api.mjs';

test('the single configurable default drives otherwise-unqualified links', () => {
  assert.ok(Object.hasOwn(NETWORKS, DEFAULT_NETWORK));
  assert.equal(selectedNetwork('https://example.com/block/27201'), DEFAULT_NETWORK);
  assert.equal(selectedNetwork('https://example.com/?network=mainnet'), 'mainnet');
});
test('unknown and duplicate network selections fail closed', () => {
  for (const query of ['network=', 'network=other', 'network=mainnet&network=testnet', 'network=MAINNET']) {
    assert.throws(() => selectedNetwork('https://example.com/?' + query));
  }
});
test('internal deep links retain exact selected network and other parameters', () => {
  assert.equal(networkLink('/block/27201?page=2#transactions', 'testnet', 'https://example.com/'), '/block/27201?page=2&network=testnet#transactions');
  assert.equal(networkLink('/account/address?network=mainnet', 'testnet', 'https://example.com/'), '/account/address?network=testnet');
  assert.equal(networkLink('https://external.example/path', 'testnet', 'https://example.com/'), 'https://external.example/path');
});
test('both checkpoint hashes are distinct and validated exactly', () => {
  assert.notEqual(NETWORKS.mainnet.checkpointHash, NETWORKS.testnet.checkpointHash);
  for (const network of ['mainnet', 'testnet']) {
    const data = {success: true, data: {slot: 27201, hash: NETWORKS[network].checkpointHash}};
    assert.equal(verifyCheckpoint(network, data), true);
    assert.throws(() => verifyCheckpoint(network, {...data, success: 1}));
    assert.throws(() => verifyCheckpoint(network, {...data, data: {...data.data, slot: '27201'}}));
    assert.throws(() => verifyCheckpoint(network, {...data, data: {...data.data, hash: NETWORKS[network === 'mainnet' ? 'testnet' : 'mainnet'].checkpointHash}}));
  }
});
test('unsafe raw integers remain exact, string contents untouched', () => {
  const value = parsePublicJSON('{"small":27201,"raw":200305530815068434,"nonce":18446744073709551615,"text":"12345678901234567890","decimal":0.18}');
  assert.equal(value.raw, '200305530815068434');
  assert.equal(value.nonce, '18446744073709551615');
  assert.equal(value.small, 27201);
  assert.equal(value.text, '12345678901234567890');
  assert.equal(value.decimal, 0.18);
});
test('invalid JSON and nonfinite numbers do not become valid when preserving integers', () => {
  for (const text of ['[01]', '[1e999]', '[NaN]', '[90071992547409930 1]', '["unclosed]', '[-]']) assert.throws(() => parsePublicJSON(text));
});
test('unit formatting keeps nine decimals beyond JS safe integer', () => {
  assert.equal(rawUnits('200305530815068434', 9, 9), '200,305,530.815068434');
  assert.equal(rawUnits('500000', 6, 6), '0.5');
  assert.equal(rawUnits('0001'), '—');
});
test('proxy targets are fixed per-network and never accept a user upstream', () => {
  assert.equal(routeRequest('/networks/mainnet/v2/stats').url, 'https://mainnetrpc.xerisweb.com/v2/stats');
  assert.equal(routeRequest('/networks/testnet/v2/stats').url, 'http://138.197.116.81:50008/v2/stats');
  assert.equal(routeRequest('/.netlify/functions/explorer/mainnet/v2/stats').network, 'mainnet');
  for (const path of ['/networks/other/v2/stats', '/networks/mainnet/https://evil.example', '/networks/mainnet/v2/stats?upstream=https://evil.example', '/networks/mainnet/%2e%2e/v2/stats']) assert.throws(() => routeRequest(path));
});
test('evicted Mainnet checkpoint identity is read only from its fixed archive route', () => {
  const route = routeRequest('/networks/mainnet/identity/checkpoint');
  assert.equal(route.url, 'https://mainnetrpc.xerisweb.com/history/block/27201');
  assert.equal(route.archiveCheckpoint, true);
  assert.equal(routeRequest('/networks/testnet/v2/block/slot/27201').url, 'http://138.197.116.81:50008/v2/block/slot/27201');
  for (const request of ['/networks/testnet/identity/checkpoint', '/networks/mainnet/identity/checkpoint?page=1'])
    assert.throws(() => routeRequest(request));
  assert.throws(() => routeRequest('/networks/mainnet/identity/checkpoint', 'POST', '{}'));
});
test('archived checkpoint proxy validates transport and archive identity before normalizing', async () => {
  const pin = NETWORKS.mainnet;
  const valid = {coverage: {chain_id: pin.chainId}, data: {slot: pin.checkpointSlot, hash: pin.checkpointHash, transaction_count: 1}, generation: 'a'.repeat(64)};
  const upstream = (value = valid, headers = {}) => new Response(JSON.stringify(value), {headers: {
    'content-type': 'application/json', 'x-xeris-network': 'mainnet', 'x-xeris-chain-id': pin.chainId, ...headers}});
  let requested;
  const result = await proxyResponse(new Request('https://explorer.example/networks/mainnet/identity/checkpoint'), {
    fetchImpl: async url => { requested = url; return upstream(); },
  });
  assert.equal(requested, 'https://mainnetrpc.xerisweb.com/history/block/27201');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-xeris-network'), 'mainnet');
  assert.equal(result.headers.get('x-xeris-chain-id'), pin.chainId);
  assert.deepEqual(await result.json(), {success: true, data: {slot: pin.checkpointSlot, hash: pin.checkpointHash}});

  const wrong = [
    () => upstream(valid, {'x-xeris-network': 'testnet'}),
    () => upstream(valid, {'x-xeris-chain-id': 'xeris-mainnet-other'}),
    () => upstream({...valid, coverage: {chain_id: 'xeris-mainnet-other'}}),
    () => upstream({...valid, data: {...valid.data, slot: pin.checkpointSlot + 1}}),
    () => upstream({...valid, data: {...valid.data, hash: NETWORKS.testnet.checkpointHash}}),
  ];
  for (const fixture of wrong) {
    const refused = await proxyResponse(new Request('https://explorer.example/networks/mainnet/identity/checkpoint'), {fetchImpl: async () => fixture()});
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).success, false);
  }
});
test('read-only proxy rejects mutation methods and transaction submission', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.throws(() => routeRequest('/networks/mainnet/v2/tokens', method, '{}'));
  for (const method of ['sendTransaction', 'requestAirdrop', 'simulateTransaction']) assert.throws(() => routeRequest('/networks/mainnet/rpc', 'POST', JSON.stringify({jsonrpc: '2.0', id: 1, method, params: []})));
  assert.throws(() => routeRequest('/networks/testnet/rpc', 'POST', JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getSlot', params: []})));
});
test('allowlisted RPC uses the actual root RPC endpoint and validates params', () => {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getSlot', params: []});
  assert.equal(routeRequest('/networks/mainnet/rpc', 'POST', body).url, 'https://mainnetrpc.xerisweb.com/');
  assert.throws(() => routeRequest('/networks/mainnet/rpc', 'POST', JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getSlot', params: ['other']})));
});
test('query bounds prevent unbounded pages or ambiguous fields', () => {
  for (const query of ['limit=101', 'page_size=0', 'page=-1', 'page=1&page=2', 'q=<script>', 'after=x/y', 'amount=18446744073709551616']) assert.throws(() => routeRequest('/networks/mainnet/v2/tokens?' + query));
  assert.match(routeRequest('/networks/mainnet/v2/tokens?limit=100&after=xrs_native').url, /limit=100&after=xrs_native$/);
});
test('proxy never forwards user cookies/auth and never caches or follows redirects', async () => {
  let call;
  const response = await proxyResponse(new Request('https://explorer.example/networks/mainnet/v2/stats', {headers: {Authorization: 'synthetic-test-only', Cookie: 'synthetic-test-only'}}), {
    fetchImpl: async (url, options) => { call = {url, options}; return new Response('{"success":true,"data":{}}', {headers: {'Content-Type': 'application/json'}}); },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-xeris-network'), 'mainnet');
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(call.options.headers.Cookie, undefined);
});
test('unavailable mainnet endpoint never falls back to testnet or fake empty data', async () => {
  const calls = [];
  const response = await proxyResponse(new Request('https://explorer.example/networks/mainnet/balances'), {
    fetchImpl: async url => { calls.push(url); return new Response('not found', {status: 404}); },
  });
  assert.equal(response.status, 501);
  assert.deepEqual(calls, ['https://mainnetrpc.xerisweb.com/balances']);
  assert.equal((await response.json()).success, false);
});
test('legacy text/plain JSON balances are supported without executing HTML', async () => {
  const response = await proxyResponse(new Request('https://explorer.example/networks/testnet/balances'), {
    fetchImpl: async () => new Response('{"public-address":200000000000000001}', {headers: {'Content-Type': 'text/plain'}}),
  });
  assert.equal(response.status, 200);
  assert.equal(parsePublicJSON(await response.text())['public-address'], '200000000000000001');
  const bad = await proxyResponse(new Request('https://explorer.example/networks/testnet/balances'), {
    fetchImpl: async () => new Response('<html>error</html>', {headers: {'Content-Type': 'text/plain'}}),
  });
  assert.equal(bad.status, 502);
});
test('proxy errors and timeout fail on the requested network only', async () => {
  const response = await proxyResponse(new Request('https://explorer.example/networks/mainnet/v2/stats'), {
    timeoutMs: 5,
    fetchImpl: async (_, {signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /no other network was queried/);
});
test('streamed request body limit applies even with absent or false Content-Length', async () => {
  let called = false;
  const body = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(4097)); controller.close(); }});
  const request = new Request('https://explorer.example/networks/mainnet/rpc', {method: 'POST', body, duplex: 'half', headers: {'Content-Length': '1'}});
  const response = await proxyResponse(request, {fetchImpl: async () => { called = true; throw new Error('Must never call upstream'); }});
  assert.equal(response.status, 400);
  assert.equal(called, false);
});
test('streamed body deadline cancels a stalled public request', async () => {
  let cancelled = false;
  const request = new Request('https://explorer.example', {method: 'POST', body: new ReadableStream({cancel() { cancelled = true; }}), duplex: 'half'});
  await assert.rejects(boundedBody(request, 8192, 5), /timeout/);
  assert.equal(cancelled, true);
});
test('streamed request parser rejects invalid UTF-8', async () => {
  const request = new Request('https://explorer.example', {method: 'POST', body: Uint8Array.of(0xff)});
  await assert.rejects(boundedBody(request));
});

function apiFixture(network, overrides = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const suffix = url.slice(`/networks/${network}`.length);
    const identityPath = network === 'mainnet' ? '/identity/checkpoint' : '/v2/block/slot/27201';
    const payload = suffix === identityPath ? {success: true, data: {slot: 27201, hash: NETWORKS[network].checkpointHash}} :
      suffix === '/v2/stats' ? {success: true, data: {current_slot: 30000, validator_count: 3, total_staked: 3000000000000}} :
      overrides[suffix] || {success: true, data: []};
    return new Response(JSON.stringify(payload), {headers: {'X-Xeris-Network': network,
      ...(network === 'mainnet' && suffix === identityPath ? {'X-Xeris-Chain-Id': NETWORKS.mainnet.chainId} : {})}});
  };
  return {calls, fetchImpl};
}
test('each API instance verifies its own network before requesting data', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const fixture = apiFixture(network);
    const api = createExplorerAPI(network, fixture);
    await api.validators();
    assert.deepEqual(fixture.calls, [network === 'mainnet' ? '/networks/mainnet/identity/checkpoint' : '/networks/testnet/v2/block/slot/27201', `/networks/${network}/v2/validators`]);
  }
});
test('a live probe bypasses the cached startup identity and can recover after transport loss', async () => {
  let calls = 0, offline = false;
  const api = createExplorerAPI('mainnet', {fetchImpl: async () => {
    calls++;
    if (offline) throw new Error('offline');
    return new Response(JSON.stringify({success: true, data: {slot: 27201, hash: NETWORKS.mainnet.checkpointHash}}),
      {headers: {'X-Xeris-Network': 'mainnet', 'X-Xeris-Chain-Id': NETWORKS.mainnet.chainId}});
  }});
  await api.ready(); await api.ready(); assert.equal(calls, 1);
  offline = true; await assert.rejects(api.probe(), error => error.retryable === true);
  offline = false; assert.equal(await api.probe(), true); assert.equal(calls, 3);
});
test('failed network identity blocks all subsequent API requests', async () => {
  const calls = [];
  const api = createExplorerAPI('mainnet', {fetchImpl: async url => { calls.push(url); return new Response(JSON.stringify({success: true, data: {slot: 27201, hash: NETWORKS.testnet.checkpointHash}}), {headers: {'X-Xeris-Network': 'mainnet', 'X-Xeris-Chain-Id': NETWORKS.mainnet.chainId}}); }});
  await assert.rejects(api.validators());
  await assert.rejects(api.tokens());
  assert.deepEqual(calls, ['/networks/mainnet/identity/checkpoint']);
});
test('a response labelled as another network cannot populate the UI', async () => {
  const api = createExplorerAPI('mainnet', {fetchImpl: async () => new Response('{}', {headers: {'X-Xeris-Network': 'testnet'}})});
  await assert.rejects(api.ready(), /binding failed/);
});
test('in-flight reads coalesce but settled results are not cached', async () => {
  const fixture = apiFixture('testnet');
  const api = createExplorerAPI('testnet', fixture);
  await api.ready();
  await Promise.all([api.validators(), api.validators()]);
  assert.equal(fixture.calls.filter(url => url.endsWith('/validators')).length, 1);
  await api.validators();
  assert.equal(fixture.calls.filter(url => url.endsWith('/validators')).length, 2);
});
test('circulation comes only from fresh policy-v2 mainnet feed, never wrapped cap', async () => {
  const feed = {schema_version: '2', chain_id: 'xeris-mainnet-v4', status: 'ready', expires_at_ms: '20000',
    supply: {basis: 'unlocked_on_chain_v2', circulating_raw: '200305530815068434'}, mining: {total_mined_raw: '308530815068434'}};
  const fixture = apiFixture('mainnet', {'/market/supply': feed});
  const api = createExplorerAPI('mainnet', {...fixture, now: () => 10000});
  assert.equal((await api.stats()).circulating_supply, '200305530815068434');
  const stale = createExplorerAPI('mainnet', {...fixture, now: () => 20000});
  assert.equal((await stale.stats()).circulating_supply, undefined);
  const testnet = createExplorerAPI('testnet', apiFixture('testnet'));
  assert.equal((await testnet.stats()).circulating_supply, undefined);
});
test('wrapped token holders come from token registry, not native balance map', async () => {
  const fixture = apiFixture('mainnet', {'/v2/token/xrs_native/holders?limit=100': {holders: [], next_after: null}});
  const api = createExplorerAPI('mainnet', fixture);
  await api.holders('xrs_native');
  assert.equal(fixture.calls.some(url => url.endsWith('/balances')), false);
});
test('cyclic token pagination fails instead of reporting an incomplete registry', async () => {
  const fixture = apiFixture('mainnet', {
    '/v2/tokens?limit=100': {data: [{token_id: 'one'}], next_after: 'one'},
    '/v2/tokens?limit=100&after=one': {data: [{token_id: 'two'}], next_after: 'one'},
  });
  await assert.rejects(createExplorerAPI('mainnet', fixture).tokens(), /Incomplete/);
});
test('circulation property expires even if a component retains its last statistics object', async () => {
  let now = 10000;
  const feed = {schema_version: '2', chain_id: 'xeris-mainnet-v4', status: 'ready', expires_at_ms: '20000',
    supply: {basis: 'unlocked_on_chain_v2', circulating_raw: '200305530815068434'}};
  const api = createExplorerAPI('mainnet', {...apiFixture('mainnet', {'/market/supply': feed}), now: () => now});
  const stats = await api.stats();
  assert.equal(stats.circulating_supply, '200305530815068434');
  const rerendered = Object.create(Object.getPrototypeOf(stats), Object.getOwnPropertyDescriptors(stats));
  now = 20000;
  assert.equal(stats.circulating_supply, undefined);
  assert.equal(rerendered.circulating_supply, undefined);
});
test('read error carries its original route context, so stale-page notices can be ignored', async () => {
  let context = '/balances?network=testnet'; let resolve;
  const errors = [];
  const fixture = apiFixture('testnet');
  const api = createExplorerAPI('testnet', {getContext: () => context, onError: (message, startedAt) => errors.push(startedAt),
    fetchImpl: async url => url.endsWith('/balances') ? new Promise(r => { resolve = r; }) : fixture.fetchImpl(url)});
  await api.ready();
  const pending = api.balances();
  await new Promise(r => setTimeout(r, 0));
  context = '/tokens?network=testnet';
  resolve(new Response('', {status: 502}));
  await assert.rejects(pending);
  assert.deepEqual(errors, ['/balances?network=testnet']);
});
test('raw same-network Swap contract maps to the recovered UI without inventing values', () => {
  const state = {token_a: 'xrs_native', token_b: 'xeris_usdc', reserve_a: '709700000000', reserve_b: '10101886', fee_bps: 30};
  const response = {success: true, contract: {contract_id: 'pool', owner: 'public-owner', contract_type: 'Swap', state: {Swap: state}}};
  const result = normalizeContract(response, 'pool');
  assert.equal(result.contract_type, 'swap');
  assert.deepEqual(result.params, state);
  assert.equal(result.owner, 'public-owner');
  assert.throws(() => normalizeContract(response, 'other-pool'));
  assert.throws(() => normalizeContract({...response, contract: {...response.contract, state: {Swap: {...state, fee_bps: 10000}}}}, 'pool'));
});
test('mainnet contract detail uses the bounded explorer route on the same network', async () => {
  const fixture = apiFixture('mainnet', {'/v2/contract/pool': {contract: {contract_id: 'pool', owner: 'owner', contract_type: 'Other', state: {Other: {value: 'raw'}}}}});
  const result = await createExplorerAPI('mainnet', fixture).contract('pool');
  assert.equal(result.contract_type, 'Recorded contract');
  assert.equal(fixture.calls.at(-1), '/networks/mainnet/v2/contract/pool');
});
test('Testnet contract list uses the real contracts envelope key', async () => {
  const fixture = apiFixture('testnet', {'/v2/contracts?limit=100': {success: true, contracts: [{contract_id: 'test-contract'}], count: 1}});
  const contracts = await createExplorerAPI('testnet', fixture).contracts();
  assert.equal(contracts[0].contract_id, 'test-contract');
});
test('legacy proxy bounds a greater-than-4MiB upstream registry before replying', async () => {
  const data = Array.from({length: 50000}, (_, n) => ({token_id: `token_${n}`, name: `Public test token ${n}`, created_slot: n,
    decimals: 9, max_supply: '700000000000000001', current_supply: '9007199254740993'}));
  const text = JSON.stringify({success: true, data});
  assert.ok(Buffer.byteLength(text) > 4_194_304);
  let target;
  const result = await proxyResponse(new Request('https://explorer.example/networks/testnet/v2/tokens?limit=100'), {
    fetchImpl: async url => { target = url; return new Response(text, {headers: {'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text))}}); },
  });
  assert.equal(result.status, 200);
  assert.equal(target, 'http://138.197.116.81:50008/v2/tokens');
  const output = await result.text();
  assert.ok(Buffer.byteLength(output) < 100000);
  const projected = JSON.parse(output);
  assert.equal(projected.total, 50000);
  assert.equal(projected.data.length, 100);
  assert.equal(projected.truncated, true);
  assert.equal(projected.data[0].current_supply, '9007199254740993');
});
test('legacy proxy exact token lookup is local and never forwards unbounded selection parameters', async () => {
  const route = routeRequest('/networks/testnet/v2/tokens?token_id=older_token');
  assert.equal(route.url, 'http://138.197.116.81:50008/v2/tokens');
  assert.deepEqual(route.legacyTokens, {tokenId: 'older_token', limit: 100});
  const result = await proxyResponse(new Request('https://explorer.example/networks/testnet/v2/tokens?token_id=older_token'), {
    fetchImpl: async () => new Response(JSON.stringify({success: true, data: [
      {token_id: 'newer', decimals: 9, created_slot: 200}, {token_id: 'older_token', decimals: 6, created_slot: 1, current_supply: '1000001'}]}),
      {headers: {'Content-Type': 'application/json'}}),
  });
  const projected = await result.json();
  assert.equal(projected.data.length, 1);
  assert.equal(projected.data[0].token_id, 'older_token');
  assert.equal(projected.coverage, 'exact_token');
  assert.equal(projected.truncated, false);
  assert.throws(() => routeRequest('/networks/testnet/v2/tokens?after=older_token'));
});
test('limited legacy listing is explicitly disclosed and not refetched as complete pagination', async () => {
  const notices = [];
  const fixture = apiFixture('testnet', {'/v2/tokens?limit=100': {success: true, data: [{token_id: 'core'}], total: 64084, truncated: true, next_after: null}});
  const api = createExplorerAPI('testnet', {...fixture, onNotice: message => notices.push(message)});
  assert.equal((await api.tokens()).length, 1);
  assert.equal(fixture.calls.filter(path => path.includes('/v2/tokens')).length, 1);
  assert.match(notices[0], /64,084/);
});
test('legacy token details request exact ID instead of requiring it in limited listing', async () => {
  const fixture = apiFixture('testnet', {'/v2/tokens?token_id=older_token': {success: true, data: [{token_id: 'older_token', decimals: 6}], coverage: 'exact_token'}});
  assert.equal((await createExplorerAPI('testnet', fixture).token('older_token')).decimals, 6);
  assert.equal(fixture.calls.at(-1), '/networks/testnet/v2/tokens?token_id=older_token');
});
