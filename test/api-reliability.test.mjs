import test from 'node:test';
import assert from 'node:assert/strict';
import {NETWORKS} from '../src/network.mjs';
import {createExplorerAPI, ExplorerError, retryAfterMilliseconds} from '../src/explorer-api.mjs';
import {proxyResponse} from '../src/proxy.mjs';

const reply = (value, network = 'mainnet', options = {}) => new Response(JSON.stringify(value), {
  ...options, headers: {'x-xeris-network': network,
    ...(network === 'mainnet' ? {'x-xeris-chain-id': NETWORKS.mainnet.chainId} : {}), ...options.headers},
});
const identity = network => reply({success: true, data: {slot: 27201, hash: NETWORKS[network].checkpointHash}}, network);
const memoryStorage = () => {
  const values = new Map();
  return {getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
};

test('verified route data survives a transient outage and remains isolated by network', async () => {
  const cacheStorage=memoryStorage(),freshness=[];let offline=false;
  const fetchImpl=async url=>{
    if(offline)throw new TypeError('Synthetic outage');
    if(url.endsWith('/identity/checkpoint'))return identity('mainnet');
    if(url.endsWith('/v2/validators'))return reply({success:true,data:[{address:'validator-one'}]});
    throw new Error('Unexpected route '+url);
  };
  const live=createExplorerAPI('mainnet',{cacheStorage,fetchImpl});
  assert.deepEqual(await live.validators(),[{address:'validator-one'}]);
  offline=true;
  const retained=createExplorerAPI('mainnet',{cacheStorage,fetchImpl,onFreshness:value=>freshness.push(value)});
  assert.deepEqual(await retained.validators(),[{address:'validator-one'}]);
  assert.ok(freshness.some(value=>value.state==='stale'&&value.path==='/identity/checkpoint'));
  assert.ok(freshness.some(value=>value.state==='stale'&&value.path==='/v2/validators'));
  const testnet=createExplorerAPI('testnet',{cacheStorage,fetchImpl});
  await assert.rejects(testnet.ready(),error=>error.retryable===true);
});

test('one transient identity failure can recover without permitting another chain', async () => {
  const calls = []; let fail = true;
  const api = createExplorerAPI('mainnet', {fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/identity/checkpoint')) {
      if (fail) { fail = false; throw new TypeError('Synthetic network interruption'); }
      return identity('mainnet');
    }
    return reply({success: true, data: []});
  }});
  await assert.rejects(api.ready(), e => e instanceof ExplorerError && e.code === 'TRANSPORT_ERROR' && e.retryable);
  assert.equal(calls.length, 1);
  assert.deepEqual(await api.validators(), []);
  assert.equal(calls.length, 3);
});

test('429 identity errors retain retry instructions and do not automatically retry', async () => {
  let calls = 0;
  const api = createExplorerAPI('mainnet', {fetchImpl: async () => {
    calls++; return reply({}, 'mainnet', {status: 429, headers: {'retry-after': '9'}});
  }});
  await assert.rejects(api.ready(), e => e.code === 'RATE_LIMITED' && e.status === 429 && e.retryAfterMs === 9000 && e.retryable);
  assert.equal(calls, 1);
});

test('retained route data honors per-path Retry-After without blocking other routes', async () => {
  const cacheStorage=memoryStorage();let clock=10_000,validatorCalls=0,blockCalls=0,busy=false;
  const fetchImpl=async url=>{
    if(url.endsWith('/identity/checkpoint'))return identity('mainnet');
    if(url.endsWith('/v2/validators')){
      validatorCalls++;
      if(busy)return reply({},'mainnet',{status:503,headers:{'retry-after':'30'}});
      return reply({success:true,data:[{address:'validator-one'}]});
    }
    if(url.endsWith('/v2/blocks?page=1&page_size=10')){blockCalls++;return reply({success:true,data:[]});}
    throw new Error('Unexpected route '+url);
  };
  const api=createExplorerAPI('mainnet',{cacheStorage,fetchImpl,now:()=>clock});
  assert.equal((await api.validators())[0].address,'validator-one');
  busy=true;
  assert.equal((await api.validators())[0].address,'validator-one');
  assert.equal(validatorCalls,2);
  clock+=29_999;
  assert.equal((await api.validators())[0].address,'validator-one');
  assert.equal(validatorCalls,2,'cached fallback must not re-probe before Retry-After');
  assert.deepEqual(await api.blocks(),[]);
  assert.equal(blockCalls,1,'backoff must remain isolated to the failed path');
  clock+=1;busy=false;
  assert.equal((await api.validators())[0].address,'validator-one');
  assert.equal(validatorCalls,3);
});

test('actual checkpoint/header mismatches remain latched even if next response would be valid', async () => {
  for (const wrong of [() => identity('testnet'),
    () => reply({success: true, data: {slot: 27201, hash: NETWORKS.mainnet.checkpointHash}}, 'mainnet', {headers: {'x-xeris-chain-id': 'xeris-mainnet-other'}}),
    () => reply({success: true, data: {slot: 27201, hash: NETWORKS.testnet.checkpointHash}})]) {
    let calls = 0;
    const api = createExplorerAPI('mainnet', {fetchImpl: async () => { calls++; return calls === 1 ? wrong() : identity('mainnet'); }});
    await assert.rejects(api.ready(), e => e.code === 'NETWORK_MISMATCH' && !e.retryable);
    await assert.rejects(api.ready(), e => e.code === 'NETWORK_MISMATCH');
    assert.equal(calls, 1);
  }
});

test('missing optional supply never replaces otherwise valid stats or emits global failure', async () => {
  const errors = []; let feedCalls = 0;
  const api = createExplorerAPI('mainnet', {onError: (...args) => errors.push(args), fetchImpl: async url => {
    if (url.endsWith('/identity/checkpoint')) return identity('mainnet');
    if (url.endsWith('/v2/stats')) return reply({success: true, data: {current_slot: 35000, validator_count: 3}});
    if (url.includes('/v2/pools')) return reply({}, 'mainnet', {status: 503});
    feedCalls++; return reply({}, 'mainnet', {status: 503, headers: {'retry-after': '10'}});
  }});
  const stats = await api.stats();
  assert.equal(stats.current_slot, 35000);
  assert.equal(stats.circulating_supply, undefined);
  assert.equal(feedCalls, 1);
  assert.equal(errors.length, 0);
});

test('optional supply deadline completes even when fetch ignores cancellation', async () => {
  const errors = [];
  const api = createExplorerAPI('mainnet', {supplyTimeoutMs: 5, onError: (...args) => errors.push(args), fetchImpl: async url => {
    if (url.endsWith('/identity/checkpoint')) return identity('mainnet');
    if (url.endsWith('/v2/stats')) return reply({success: true, data: {current_slot: 35001, validator_count: 3}});
    if (url.includes('/v2/pools')) return reply({}, 'mainnet', {status: 503});
    return new Promise(() => {});
  }});
  assert.equal((await api.stats()).current_slot, 35001);
  assert.equal(errors.length, 0);
});

test('optional history enrichment cannot report a global endpoint failure', async () => {
  const errors = [];
  const api = createExplorerAPI('mainnet', {onError: (...args) => errors.push(args), fetchImpl: async url =>
    url.endsWith('/identity/checkpoint') ? identity('mainnet') : reply({}, 'mainnet', {status: 501})});
  await assert.rejects(api.block(20000, {optional: true}), e => e.code === 'UNSUPPORTED_ENDPOINT' && !e.retryable);
  assert.equal(errors.length, 0);
  await assert.rejects(api.block(20000));
  assert.equal(errors.length, 1);
});

test('a stalled response body expires, cancels, and can be retried', async () => {
  let calls = 0, cancelled = false;
  const api = createExplorerAPI('mainnet', {readTimeoutMs: 5, fetchImpl: async () => {
    calls++;
    if (calls !== 1) return identity('mainnet');
    return new Response(new ReadableStream({cancel() { cancelled = true; return new Promise(() => {}); }}), {headers: {'x-xeris-network': 'mainnet', 'x-xeris-chain-id': NETWORKS.mainnet.chainId}});
  }});
  await assert.rejects(api.ready(), e => e.code === 'TIMEOUT' && e.retryable);
  assert.equal(cancelled, true);
  assert.equal(await api.ready(), true);
});

test('body size/UTF-8 bounds reject invalid data rather than fabricating an empty success', async () => {
  for (const body of [Uint8Array.of(0xff), new Uint8Array(4_194_305)]) {
    const api = createExplorerAPI('mainnet', {fetchImpl: async () => new Response(body, {headers: {'x-xeris-network': 'mainnet', 'x-xeris-chain-id': NETWORKS.mainnet.chainId}})});
    await assert.rejects(api.ready(), e => e.code === 'INVALID_RESPONSE' && !e.retryable);
  }
});

test('coalesced failures retain each caller route context instead of first caller only', async () => {
  let context = '/old', resolve;
  const errors = [];
  const api = createExplorerAPI('mainnet', {getContext: () => context, onError: (_, route) => errors.push(route), fetchImpl: async url =>
    url.endsWith('/identity/checkpoint') ? identity('mainnet') : new Promise(r => { resolve = r; })});
  await api.ready();
  const first = api.validators();
  await new Promise(r => setTimeout(r, 0));
  context = '/new'; const second = api.validators();
  await new Promise(r => setTimeout(r, 0));
  resolve(reply({}, 'mainnet', {status: 502}));
  await Promise.allSettled([first, second]);
  assert.deepEqual(errors, ['/old', '/new']);
});

test('Retry-After supports dates and bounded integer values without exposing arbitrary header text', async () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  assert.equal(retryAfterMilliseconds('Mon, 23 Nov 2026 00:00:12 GMT', now), 12000);
  assert.equal(retryAfterMilliseconds('999999999', now), 86400000);
  assert.equal(retryAfterMilliseconds('nonsense', now), 0);
  assert.equal(retryAfterMilliseconds('Sun, 22 Nov 2026 23:59:00 GMT', now), 0);
  for (const status of [429, 503]) {
    let calls = 0;
    const response = await proxyResponse(new Request('https://explorer.example/networks/mainnet/v2/stats'), {
      now: () => now, fetchImpl: async () => { calls++; return new Response('busy', {status, headers: {'Retry-After': 'Mon, 23 Nov 2026 00:00:12 GMT'}}); },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '12');
    assert.equal(response.headers.get('x-xeris-network'), 'mainnet');
    assert.equal(calls, 1);
  }
});

test('proxy body deadline also bounds streams whose cancellation handler never settles', async () => {
  let cancelled = false;
  const response = await proxyResponse(new Request('https://explorer.example/networks/mainnet/v2/stats'), {
    timeoutMs: 5, fetchImpl: async () => new Response(new ReadableStream({cancel() { cancelled = true; return new Promise(() => {}); }}), {headers: {'Content-Type': 'application/json'}}),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error_code, 'TIMEOUT');
  assert.equal(cancelled, true);
});

test('proxy rejects malformed UTF-8 even when replacement decoding would form valid JSON', async () => {
  const response = await proxyResponse(new Request('https://explorer.example/networks/mainnet/v2/stats'), {
    fetchImpl: async () => new Response(Uint8Array.of(123,34,97,34,58,34,255,34,125), {headers: {'Content-Type': 'application/json'}}),
  });
  assert.equal(response.status, 502);
});

test('optional enrichment cannot impose its shorter deadline on a primary block detail read', async () => {
  const resolves = [];
  const api = createExplorerAPI('mainnet', {fetchImpl: async url => url.endsWith('/identity/checkpoint') ? identity('mainnet') :
    new Promise(resolve => resolves.push(resolve))});
  await api.ready();
  const enrichment = api.block(35000, {optional: true});
  const detail = api.block(35000);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(resolves.length, 2);
  for (const resolve of resolves) resolve(reply({success: true, data: {slot: 35000, transactions: []}}));
  assert.equal((await enrichment).slot, 35000);
  assert.equal((await detail).slot, 35000);
});
