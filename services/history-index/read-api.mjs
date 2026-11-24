/** Read-only HTTP facade for immutable, integrity-checked history exports.
 * No SDK, credential access, storage writes, or network calls at import time.
 * The injected adapter is responsible for verifying manifest and file integrity.
 */
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PAGE_SIZE = 100, SHARD_SIZE = 1000, MAX_PAGE = 50_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slotNumber = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && HASH.test(value);
const token = value => typeof value === 'string' && TOKEN.test(value);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new HttpError(400, 'invalid_request', message); };
const unavailable = () => { throw new HttpError(503, 'archive_unavailable', 'Archive data is temporarily unavailable.'); };
const absent = () => { throw new HttpError(404, 'not_indexed', 'No matching record in this archive generation; see coverage for retained history.'); };

function base58Bytes(value, expected) {
  if (typeof value !== 'string' || value.length < expected || value.length > Math.ceil(expected * 1.366)) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  const zeros = value.match(/^1*/)[0].length;
  const length = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  return zeros + length === expected;
}
const addressValid = value => base58Bytes(value, 32);
const signatureValid = value => base58Bytes(value, 64);

function parseSlot(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const slot = Number(value);
  return slotNumber(slot) ? slot : null;
}

function encodeCursor(generation, route, address, page) {
  return Buffer.from(JSON.stringify({ v: 1, generation, route, address, page })).toString('base64url');
}

function decodeCursor(encoded, route, address) {
  if (typeof encoded !== 'string' || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid('Invalid pagination cursor.');
  let value;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) invalid('Noncanonical pagination cursor.');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { invalid('Invalid pagination cursor.'); }
  if (!object(value) || Object.keys(value).sort().join(',') !== 'address,generation,page,route,v'
    || value.v !== 1 || !token(value.generation) || value.route !== route || value.address !== address
    || !Number.isSafeInteger(value.page) || value.page < 2 || value.page > MAX_PAGE) invalid('Mismatched pagination cursor.');
  return value;
}

function checkParams(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) invalid('Unknown or repeated query parameter.');
  }
}

function routeFor(url, basePath) {
  if (url.pathname !== basePath && !url.pathname.startsWith(basePath + '/')) throw new HttpError(404, 'unknown_route', 'Unknown history endpoint.');
  const path = url.pathname.slice(basePath.length);
  if (path.includes('%') || path.length > 256) invalid('Invalid endpoint path.');
  if (['/coverage', '/blocks', '/transactions', '/search'].includes(path)) {
    const kind = path.slice(1);
    checkParams(url, kind === 'search' ? ['q'] : kind === 'coverage' ? [] : ['cursor']);
    return { kind, address: null };
  }
  const match = /^\/(block|transaction|address)\/([^/]+)$/.exec(path);
  if (!match) throw new HttpError(404, 'unknown_route', 'Unknown history endpoint.');
  const [, kind, id] = match;
  checkParams(url, kind === 'address' ? ['cursor'] : []);
  if (kind === 'block' && !hash(id) && parseSlot(id) === null) invalid('Expected a positive block slot or lowercase block hash.');
  if (kind === 'transaction' && !signatureValid(id)) invalid('Expected a 64-byte base58 transaction signature.');
  if (kind === 'address' && !addressValid(id)) invalid('Expected a 32-byte base58 address.');
  return { kind, id, address: kind === 'address' ? id : null };
}

/** Returns an async Web Request -> Web Response handler; GET is the only method. */
export function createHistoryApiHandler({ adapter, basePath = '/api/history' } = {}) {
  if (!adapter || !['readCurrent', 'readGeneration', 'readJSON'].every(key => typeof adapter[key] === 'function')) throw new Error('A read-only history adapter is required');
  if (typeof basePath !== 'string' || basePath.length > 128 || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new Error('Invalid history base path');

  return async function handle(request) {
    let manifest = null;
    const respond = (status, payload, extraHeaders = {}) => new Response(JSON.stringify({ generation: manifest?.generation ?? null, coverage: manifest?.coverage ?? null, ...payload }), {
      status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders },
    });
    try {
      if (request?.method !== 'GET') return respond(405, { error: { code: 'method_not_allowed', message: 'Only GET is supported.' } }, { allow: 'GET' });
      if (typeof request.url !== 'string' || request.url.length > 4096) invalid('Invalid request URL.');
      let url;
      try { url = new URL(request.url); } catch { invalid('Invalid request URL.'); }
      const route = routeFor(url, basePath), cursorText = url.searchParams.get('cursor');
      const cursor = cursorText !== null ? decodeCursor(cursorText, route.kind, route.address) : null;
      let searchValue;
      if (route.kind === 'search') {
        searchValue = url.searchParams.get('q');
        if (typeof searchValue !== 'string' || searchValue.length > 128
          || (!hash(searchValue) && parseSlot(searchValue) === null && !signatureValid(searchValue) && !addressValid(searchValue))) invalid('Search requires a block slot, lowercase block hash, transaction signature, or address.');
      }
      try {
        manifest = cursor ? await adapter.readGeneration(cursor.generation) : (await adapter.readCurrent())?.manifest;
      } catch (error) {
        if (cursor && error?.message === 'Archive generation is unavailable') throw new HttpError(410, 'generation_unavailable', 'This archive generation is no longer available; restart pagination.');
        throw error;
      }
      if (!manifest) throw new HttpError(503, 'archive_unavailable', 'No archive generation has been activated.');
      if (!token(manifest.generation) || (cursor && manifest.generation !== cursor.generation)
        || !object(manifest.coverage) || manifest.coverage.list_page_size !== PAGE_SIZE || manifest.coverage.block_shard_size !== SHARD_SIZE
        || !object(manifest.tip) || !slotNumber(manifest.tip.slot) || !hash(manifest.tip.hash)
        || !slotNumber(manifest.indexed_from) || manifest.indexed_from > manifest.tip.slot
        || !Array.isArray(manifest.files) || manifest.files.length > 50_000) unavailable();
      const paths = new Set(manifest.files.map(file => file.path));
      async function read(path) {
        if (!paths.has(path)) return null;
        const result = await adapter.readJSON(path, { generation: manifest.generation });
        if (!object(result) || result.generation !== manifest.generation || result.data === null || result.data === undefined) unavailable();
        return result.data;
      }
      const inRange = slot => slotNumber(slot) && slot >= manifest.indexed_from && slot <= manifest.tip.slot;
      async function block(id) {
        let slot = parseSlot(id), expectedHash;
        if (hash(id)) {
          expectedHash = id;
          const shard = await read(`hashes/${id.slice(0, 2)}.json`);
          if (shard === null) absent();
          if (!object(shard)) unavailable();
          if (!Object.hasOwn(shard, id)) absent();
          slot = shard[id];
          if (!inRange(slot)) unavailable();
        }
        if (!inRange(slot)) absent();
        const shard = await read(`blocks/${Math.floor(slot / SHARD_SIZE)}.json`);
        if (shard === null) { if (expectedHash) unavailable(); absent(); }
        if (!object(shard)) unavailable();
        if (!Object.hasOwn(shard, String(slot))) { if (expectedHash) unavailable(); absent(); }
        const value = shard[String(slot)];
        if (!object(value) || value.slot !== slot || !hash(value.hash) || (expectedHash && value.hash !== expectedHash)) unavailable();
        return value;
      }
      async function transaction(signature) {
        const value = await read(`transactions/${signature}.json`);
        if (value === null) absent();
        if (!object(value) || value.signature !== signature || !inRange(value.slot)) unavailable();
        return value;
      }
      async function page(kind, address = null, number = 1) {
        const prefix = kind === 'address' ? `addresses/${address}` : `lists/${kind}`;
        const value = await read(`${prefix}/${number}.json`);
        if (value === null) absent();
        if (!object(value) || !Array.isArray(value.data) || value.data.length > PAGE_SIZE
          || !(value.cursor === null || (typeof value.cursor === 'string' && value.cursor.length > 0))
          || !object(value.snapshot_tip) || value.snapshot_tip.slot !== manifest.tip.slot || value.snapshot_tip.hash !== manifest.tip.hash) unavailable();
        const more = value.cursor !== null;
        if (more && (number === MAX_PAGE || !paths.has(`${prefix}/${number + 1}.json`))) unavailable();
        return { data: value.data, cursor: more ? encodeCursor(manifest.generation, kind, address, number + 1) : null,
          page: number, page_size: PAGE_SIZE, snapshot_tip: manifest.tip };
      }
      let payload;
      if (route.kind === 'coverage') payload = { data: manifest.coverage };
      else if (route.kind === 'block') payload = { data: await block(route.id) };
      else if (route.kind === 'transaction') payload = { data: await transaction(route.id) };
      else if (['blocks', 'transactions', 'address'].includes(route.kind)) payload = await page(route.kind, route.address, cursor?.page ?? 1);
      else if (hash(searchValue) || parseSlot(searchValue) !== null) payload = { type: 'block', data: await block(searchValue) };
      else if (signatureValid(searchValue)) payload = { type: 'transaction', data: await transaction(searchValue) };
      else {
        const result = await page('address', searchValue);
        payload = { type: 'address', data: { address: searchValue, transactions: result.data, cursor: result.cursor,
          page: result.page, page_size: result.page_size, snapshot_tip: result.snapshot_tip } };
      }
      return respond(200, payload);
    } catch (error) {
      if (error instanceof HttpError) return respond(error.status, { error: { code: error.code, message: error.message } });
      return respond(503, { error: { code: 'archive_unavailable', message: 'Archive data is temporarily unavailable.' } });
    }
  };
}
