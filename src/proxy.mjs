import {NETWORKS} from './network.mjs';
import {projectLegacyTokens} from './legacy-tokens.mjs';
const ID = '[A-Za-z0-9_-]{1,128}';
const ROUTES = [
  /^\/v2\/(stats|blocks|transactions|validators|tokens|pools|contracts|search)$/,
  /^\/v2\/block\/slot\/\d{1,18}$/,
  new RegExp(`^/v2/(tx|account|contract)/${ID}$`),
  new RegExp(`^/v2/account/${ID}/transactions$`),
  new RegExp(`^/v2/token/${ID}/holders$`),
  new RegExp(`^/v2/contract/${ID}/quote$`),
  new RegExp(`^/contract/${ID}$`), /^\/balances$/, /^\/market\/supply$/, /^\/history\/accounts$/,
];
const RPC = new Set(['getSlot', 'getBalance', 'getTransaction', 'getSignaturesForAddress']);
export async function boundedBody(request, maximumBytes = 8192, timeoutMs = 3000) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let size = 0; let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request body timeout')), timeoutMs); });
  try {
    while (true) {
      const {done, value} = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error('Request body too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}
function checkQuery(query) {
  const seen = new Set();
  for (const [key, value] of query) {
    if (seen.has(key)) throw new Error('Duplicate query field');
    seen.add(key);
    if (['page', 'page_size', 'limit'].includes(key)) {
      const max = key === 'page' ? 1_000_000 : 100;
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) throw new Error('Invalid pagination');
    } else if (['after', 'input_token', 'token_id'].includes(key)) {
      if (!new RegExp(`^${ID}$`).test(value)) throw new Error('Invalid public identifier');
    } else if (key === 'amount') {
      if (!/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error('Invalid amount');
    } else if (key === 'q') {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid search');
    } else throw new Error('Unsupported query field');
  }
}
export function routeRequest(input, method = 'GET', body = null) {
  const url = new URL(input, 'https://explorer.invalid');
  if (url.search.length > 2048 || /%|\\/.test(url.pathname)) throw new Error('Invalid proxy path');
  const match = url.pathname.match(/^\/(?:networks|\.netlify\/functions\/explorer)\/(mainnet|testnet)(\/.*)$/);
  if (!match) throw new Error('Unknown network route');
  const [, network, path] = match;
  checkQuery(url.searchParams);
  if (path === '/identity/checkpoint') {
    if (network !== 'mainnet' || method !== 'GET' || body || url.search) throw new Error('Archived checkpoint is Mainnet GET only');
    return {network, url: `${NETWORKS.mainnet.origin}/history/block/${NETWORKS.mainnet.checkpointSlot}`,
      method: 'GET', body: null, archiveCheckpoint: true};
  }
  if (path === '/rpc') {
    if (network !== 'mainnet' || method !== 'POST' || url.search || typeof body !== 'string' || body.length > 8192) throw new Error('Unsupported RPC');
    const request = JSON.parse(body);
    if (!request || request.jsonrpc !== '2.0' || !RPC.has(request.method) || !Array.isArray(request.params) ||
        Object.keys(request).some(k => !['id', 'jsonrpc', 'method', 'params'].includes(k))) throw new Error('Read-only RPC methods only');
    if (typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) throw new Error('Invalid RPC ID');
    const [address, options] = request.params;
    if (request.method === 'getSlot' ? request.params.length !== 0 :
        typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(address)) throw new Error('Invalid RPC parameters');
    if (request.method === 'getBalance' && request.params.length !== 1) throw new Error('Invalid RPC parameters');
    if (request.method === 'getTransaction' && (request.params.length !== 2 || options !== 'jsonParsed')) throw new Error('Invalid RPC parameters');
    if (request.method === 'getSignaturesForAddress' && (request.params.length !== 2 || !options ||
        Object.keys(options).join(',') !== 'limit' || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error('Invalid RPC parameters');
    return {network, url: NETWORKS[network].origin + '/', method, body: JSON.stringify(request)};
  }
  if (method !== 'GET' || body || !ROUTES.some(r => r.test(path)) || (['/market/supply', '/history/accounts'].includes(path) && network !== 'mainnet')) throw new Error('Read-only explorer route required');
  if (path === '/history/accounts' && url.search) throw new Error('Account age lookup does not accept query parameters');
  if (network === 'testnet' && path === '/v2/tokens') {
    if ([...url.searchParams.keys()].some(k => !['limit', 'token_id'].includes(k))) throw new Error('Unsupported legacy registry query');
    return {network, url: NETWORKS[network].origin + path, method: 'GET', body: null,
      legacyTokens: {tokenId: url.searchParams.get('token_id'), limit: Number(url.searchParams.get('limit') || 100)}};
  }
  if (url.searchParams.has('token_id')) throw new Error('Exact legacy token lookup is Testnet only');
  return {network, url: NETWORKS[network].origin + path + url.search, method: 'GET', body: null};
}
function retryAfterHeader(value, now) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? String(Math.min(86_400, seconds)) : null;
}
export async function proxyResponse(request, {fetchImpl = fetch, timeoutMs, now = Date.now} = {}) {
  const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff'};
  let route;
  try {
    if (Number(request.headers.get('content-length') || 0) > 8192) throw new Error('Body too large');
    const body = request.method === 'POST' ? await boundedBody(request) : null;
    route = routeRequest(request.url, request.method, body);
  } catch {
    return new Response(JSON.stringify({success: false, error: 'Unsupported read-only explorer request'}), {status: 400, headers});
  }
  headers['X-Xeris-Network'] = route.network;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('Upstream deadline exceeded'));
  }, timeoutMs ?? (route.legacyTokens ? 20_000 : 10_000)); });
  try {
    const response = await Promise.race([fetchImpl(route.url, {method: route.method, body: route.body,
      headers: {'Accept': 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-cache'},
      redirect: 'error', cache: 'no-store', signal: controller.signal}), deadline]);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const supportedType = route.archiveCheckpoint ? contentType === 'application/json'
      : ['application/json', 'text/plain'].includes(contentType);
    if (!response.ok || !supportedType) {
      const transient = response.status === 429 || response.status === 503;
      const retryAfter = transient ? retryAfterHeader(response.headers.get('retry-after'), now()) : null;
      if (retryAfter !== null) headers['Retry-After'] = retryAfter;
      if (response.body) void response.body.cancel().catch(() => {});
      return new Response(JSON.stringify({success: false, error: `${NETWORKS[route.network].name} endpoint unavailable`,
        error_code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE', upstream_status: response.status}),
        {status: transient ? response.status : response.status === 404 || response.status === 405 ? 501 : 502, headers});
    }
    const maximumInput = route.legacyTokens ? 24 * 1024 * 1024 : 4_194_304;
    if (Number(response.headers.get('content-length') || 0) > maximumInput) throw new Error('Response too large');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) {
        const {done, value} = await Promise.race([reader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > maximumInput) throw new Error('Response too large');
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    let output;
    if (route.legacyTokens) output = JSON.stringify(projectLegacyTokens(text, route.legacyTokens));
    else if (route.archiveCheckpoint) {
      // Never relay the archive response as identity evidence. Bind its
      // transport headers, declared coverage, slot and hash here, then expose
      // only the minimal shape consumed by the browser checkpoint verifier.
      const value = JSON.parse(text), pin = NETWORKS.mainnet;
      if (response.headers.get('x-xeris-network') !== 'mainnet' ||
          response.headers.get('x-xeris-chain-id') !== pin.chainId ||
          !value || typeof value !== 'object' || Array.isArray(value) ||
          value.coverage?.chain_id !== pin.chainId ||
          value.data?.slot !== pin.checkpointSlot || value.data?.hash !== pin.checkpointHash)
        throw new Error('Archived checkpoint identity mismatch');
      headers['X-Xeris-Chain-Id'] = pin.chainId;
      output = JSON.stringify({success: true, data: {slot: pin.checkpointSlot, hash: pin.checkpointHash}});
    } else { JSON.parse(text); output = text; } // Legacy REST can label valid JSON text/plain.
    if (new TextEncoder().encode(output).byteLength > 4_194_304) throw new Error('Projected response too large');
    return new Response(output, {status: 200, headers});
  } catch {
    return new Response(JSON.stringify({success: false, error: `${NETWORKS[route.network].name} data unavailable; no other network was queried`,
      error_code: controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_UNAVAILABLE'}), {status: 502, headers});
  } finally { clearTimeout(timer); }
}
