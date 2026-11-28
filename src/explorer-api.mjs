import {validateAccountAges, validateAccountPrice, validateStoredAccountPrice} from './accounts.mjs';
import {NETWORKS, parsePublicJSON, verifyCheckpoint} from './network.mjs';

export class ExplorerError extends Error {
  constructor(message, {code = 'UNAVAILABLE', network, retryable = false, retryAfterMs = 0, status = null} = {}) {
    super(message); this.name = 'ExplorerError';
    Object.assign(this, {code, network, retryable, retryAfterMs, status});
  }
}
export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 128) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(86_400_000, Math.max(0, Math.ceil(delay))) : 0;
}

export function createExplorerAPI(network, {fetchImpl = fetch, onError = () => {}, onNotice = () => {}, onFreshness = () => {}, now = Date.now, getContext = () => '', readTimeoutMs, supplyTimeoutMs = 2000, cacheStorage} = {}) {
  if (!Object.hasOwn(NETWORKS, network)) throw new Error('Unknown network');
  const prefix = `/networks/${network}`;
  let identity, bindingFailure, lastSupply;
  const pending = new Map();
  const stalePaths = new Set();
  const retryNotBefore = new Map(), retryFailures = new Map();
  if (cacheStorage === undefined) { try { cacheStorage = globalThis.localStorage; } catch { cacheStorage = null; } }
  const cacheKey = path => `xeris:explorer:verified:v1:${network}:${encodeURIComponent(path)}`;
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const cached = path => {
    try {
      if (!cacheStorage?.getItem) return null;
      const raw = cacheStorage.getItem(cacheKey(path));
      if (raw === null) return null;
      if (typeof raw !== 'string' || raw.length > 1_048_576) throw new Error('Invalid cache entry');
      const envelope = parsePublicJSON(raw);
      if (!exactKeys(envelope, ['version','network','path','observedAtMs','value']) || envelope.version !== 1 ||
          envelope.network !== network || envelope.path !== path || !Number.isSafeInteger(envelope.observedAtMs) ||
          envelope.observedAtMs <= 0 || envelope.observedAtMs > now() + 2000 || !envelope.value ||
          typeof envelope.value !== 'object' || Array.isArray(envelope.value)) throw new Error('Invalid cache entry');
      return envelope;
    } catch {
      try { cacheStorage?.removeItem?.(cacheKey(path)); } catch { /* Storage is optional. */ }
      return null;
    }
  };
  const remember = (path, value, observedAtMs) => {
    try {
      if (!cacheStorage?.setItem) return;
      const encoded = JSON.stringify({version:1, network, path, observedAtMs, value});
      if (encoded.length <= 1_048_576) cacheStorage.setItem(cacheKey(path), encoded);
    } catch { /* A full or unavailable cache never interrupts verified live reads. */ }
  };
  const retained = (path, retryAfterMs = 0) => {
    const value = cached(path);
    if (!value) return null;
    stalePaths.add(path);
    try { onFreshness({state:'stale', observedAtMs:value.observedAtMs, path, retryAfterMs}); } catch { /* Presentation callbacks never invalidate verified data. */ }
    return value.value;
  };
  const error = (message, options) => new ExplorerError(message, {network, ...options});
  // Mainnet's node keeps only a recent live window, so its pinned historic
  // identity is exposed by a dedicated same-origin Function route. Testnet's
  // pinned slot is still available from its live endpoint.
  const checkpointPath = network === 'mainnet' ? '/identity/checkpoint'
    : `/v2/block/slot/${NETWORKS[network].checkpointSlot}`;
  async function read(path, {identityCheck = false, reportError = true, timeoutMs} = {}) {
    const context = getContext();
    const pendingKey = path + (timeoutMs === undefined ? '' : `|deadline:${timeoutMs}`);
    try {
      if (!identityCheck) await ready();
      if (bindingFailure) throw bindingFailure;
      const notBefore = retryNotBefore.get(path) || 0;
      if (notBefore > now()) {
        const value = retained(path, notBefore - now());
        if (value) return value;
        throw retryFailures.get(path) || error(`${NETWORKS[network].name}: updates are temporarily delayed`,
          {code:'RATE_LIMITED', retryable:true, retryAfterMs:notBefore-now()});
      }
      if (notBefore) { retryNotBefore.delete(path); retryFailures.delete(path); }
      if (!pending.has(pendingKey)) {
        const task = (async () => {
          const controller = new AbortController(); let timer;
          const timeout = timeoutMs ?? readTimeoutMs ?? (network === 'testnet' && path.startsWith('/v2/tokens') ? 25_000 : 12_000);
          const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(error(`${NETWORKS[network].name}: the data request timed out`, {code: 'TIMEOUT', retryable: true}));
          }, timeout); });
          let reader;
          try {
            const response = await Promise.race([fetchImpl(prefix + path, {cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal}), deadline]);
            if (!response.ok) {
              if (response.body) void response.body.cancel().catch(() => {});
              throw error(`${NETWORKS[network].name}: this data is currently unavailable`, {
              code: response.status === 429 ? 'RATE_LIMITED' : response.status === 501 ? 'UNSUPPORTED_ENDPOINT' : 'HTTP_ERROR',
              status: response.status, retryable: response.status === 429 || response.status >= 500 && response.status !== 501,
              retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after'), now()),
            });
            }
            if (response.headers.get('x-xeris-network') !== network) throw error('Network response binding failed', {code: 'NETWORK_MISMATCH'});
            if (path === '/identity/checkpoint' && response.headers.get('x-xeris-chain-id') !== NETWORKS[network].chainId)
              throw error('Network chain binding failed', {code: 'NETWORK_MISMATCH'});
            const maximumBytes = 4_194_304;
            if (Number(response.headers.get('content-length') || 0) > maximumBytes) throw error('Public response exceeds size limit', {code: 'INVALID_RESPONSE'});
            if (!response.body) throw error('Missing public response', {code: 'INVALID_RESPONSE'});
            reader = response.body.getReader(); const chunks = []; let size = 0;
            while (true) {
              const {done, value} = await Promise.race([reader.read(), deadline]);
              if (done) break;
              size += value.byteLength;
              if (size > maximumBytes) throw error('Public response exceeds size limit', {code: 'INVALID_RESPONSE'});
              chunks.push(value);
            }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            let result;
            try { result = parsePublicJSON(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
            catch { throw error('Invalid public response', {code: 'INVALID_RESPONSE'}); }
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('Invalid public response', {code: 'INVALID_RESPONSE'});
            if (result.success === false || result.error) throw error(`${NETWORKS[network].name}: requested record is unavailable`, {code: 'RECORD_UNAVAILABLE'});
            const state = response.headers.get('x-xeris-data-state') === 'stale' ? 'stale' : 'live';
            const headerTime = Number(response.headers.get('x-xeris-observed-at'));
            const observedAtMs = Number.isSafeInteger(headerTime) && headerTime > 0 && headerTime <= now() ? headerTime : now();
            stalePaths[state === 'stale' ? 'add' : 'delete'](path);
            retryNotBefore.delete(path); retryFailures.delete(path);
            remember(path, result, observedAtMs);
            try { onFreshness({state, observedAtMs, path}); } catch { /* Presentation callbacks never invalidate verified data. */ }
            if (bindingFailure) throw bindingFailure;
            return result;
          } catch (cause) {
            if (reader) void reader.cancel().catch(() => {});
            if (cause?.code === 'NETWORK_MISMATCH') {
              bindingFailure = cause;
              try { cacheStorage?.removeItem?.(cacheKey(path)); } catch { /* Storage is optional. */ }
            }
            const failure = cause instanceof ExplorerError ? cause :
              error(`${NETWORKS[network].name}: this data is currently unavailable`, {code: controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR', retryable: true});
            if (failure.retryable && failure.retryAfterMs > 0) {
              retryNotBefore.set(path, now() + failure.retryAfterMs); retryFailures.set(path, failure);
            }
            const previous = failure.retryable ? retained(path, failure.retryAfterMs) : null;
            if (previous) return previous;
            throw failure;
          } finally { clearTimeout(timer); }
        })();
        pending.set(pendingKey, task);
        // Delete before a later explicit retry; no settled response cache.
        task.then(() => { if (pending.get(pendingKey) === task) pending.delete(pendingKey); }, () => { if (pending.get(pendingKey) === task) pending.delete(pendingKey); });
      }
      const result = await pending.get(pendingKey);
      if (bindingFailure) throw bindingFailure;
      return result;
    } catch (cause) {
      if (reportError) onError(cause.message, context, cause);
      throw cause;
    }
  }
  async function probe() {
    const value = await read(checkpointPath, {identityCheck: true, reportError: false});
    try { return verifyCheckpoint(network, value); }
    catch {
      const mismatch = error('Network checkpoint mismatch; data display stopped', {code: 'NETWORK_MISMATCH'});
      bindingFailure = mismatch;
      try { cacheStorage?.removeItem?.(cacheKey(checkpointPath)); } catch { /* Storage is optional. */ }
      throw mismatch;
    }
  }
  function ready() {
    if (bindingFailure) return Promise.reject(bindingFailure);
    if (!identity) {
      const attempt = probe();
      identity = attempt;
      // An unavailable transport can recover on a later caller. A real identity
      // mismatch remains latched, so retrying can never override a wrong chain.
      attempt.catch(cause => { if (cause.retryable && identity === attempt) identity = undefined; });
    }
    return identity;
  }
  async function list(path, key = 'data') {
    const context = getContext();
    const rows = []; let after = null; const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const response = await read(path + '?limit=100' + (after ? '&after=' + encodeURIComponent(after) : ''));
      if (!Array.isArray(response[key]) || response[key].length > 100) throw new Error('Invalid or oversized list response');
      rows.push(...response[key]);
      if (response.truncated === true) onNotice(`Showing ${response[key].length} core and recent tokens from ${Number(response.total).toLocaleString()} registered tokens. Direct token links open exact records.` +
        (response.omitted_count ? ` ${response.omitted_count} historical records are unavailable in this view.` : ''), context);
      if (!response.next_after) return rows;
      if (typeof response.next_after !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(response.next_after) || seen.has(response.next_after)) throw new Error('Incomplete list response');
      after = response.next_after; seen.add(after);
    }
    throw new Error('List exceeds the explorer display limit');
  }
  async function stats() {
    const response = await read('/v2/stats');
    if (!response.data || !Number.isSafeInteger(response.data.current_slot)) throw new Error('Invalid network statistics');
    const result = {...response.data, num_validators: response.data.validator_count};
    if (network === 'mainnet') {
      try {
        const supplyPath = '/market/supply';
        const feed = await read(supplyPath, {reportError: false, timeoutMs: supplyTimeoutMs});
        const retainedFeed = stalePaths.has(supplyPath);
        const market = feed.market;
        if (feed.schema_version !== '2' || feed.chain_id !== 'xeris-mainnet-v4' || feed.status !== 'ready' ||
            feed.supply?.basis !== 'unlocked_on_chain_v2' || !/^[0-9]+$/.test(feed.supply?.circulating_raw) ||
            !/^[0-9]+$/.test(feed.expires_at_ms) || !retainedFeed && BigInt(feed.expires_at_ms) <= BigInt(now())) throw new Error('Live circulating supply unavailable');
        let marketCapRaw, marketCapDecimals;
        if (market?.token_id === 'native_xrs' && market?.quote_token_id === 'xeris_usdc' &&
            market?.valuation_basis === 'circulating_supply' && market?.price_basis === 'pool_spot' &&
            market?.circulating_raw === feed.supply.circulating_raw && /^[0-9]+$/.test(market?.market_cap_quote_raw) &&
            /^[0-9]+$/.test(market?.price_quote_raw_numerator) && /^[1-9][0-9]*$/.test(market?.price_xrs_raw_denominator) &&
            /^(0|[1-9][0-9]?)$/.test(market?.quote_decimals) && Number(market.quote_decimals) <= 18) {
          const expected = BigInt(feed.supply.circulating_raw) * BigInt(market.price_quote_raw_numerator) /
            BigInt(market.price_xrs_raw_denominator);
          if (expected === BigInt(market.market_cap_quote_raw)) {
            marketCapRaw = market.market_cap_quote_raw;
            marketCapDecimals = Number(market.quote_decimals);
          }
        }
        lastSupply = {raw: feed.supply.circulating_raw, expires: BigInt(feed.expires_at_ms),
          observedAt: feed.observed_at, mined: feed.mining?.total_mined_raw,
          marketCapRaw, marketCapDecimals, stale: retainedFeed};
      } catch (cause) {
        // A transport failure must not erase the last verified presentation
        // value. Invalid or wrong-chain data still clears it immediately.
        if (!(cause instanceof ExplorerError && cause.retryable)) lastSupply = undefined;
      }
      if (lastSupply) {
        const observed = lastSupply;
        result.circulating_supply = observed.raw;
        result.market_cap_quote_raw = observed.marketCapRaw;
        result.market_cap_quote_decimals = observed.marketCapDecimals;
        result.supply_observed_at = observed.observedAt;
        result.supply_stale = observed.stale || BigInt(now()) >= observed.expires;
        // Gross emitted amount is not labelled circulating or outstanding supply.
        result.total_mined_raw = observed.mined;
      } else lastSupply = undefined;
    }
    if (bindingFailure) throw bindingFailure;
    return result;
  }
  function normalizeBlock(block) {
    return block && {...block, transactions: block.transactions || block.txs || [],
      tx_count: block.transaction_count ?? block.tx_count ?? (block.transactions || block.txs || []).length};
  }
  const matchingRecord = (value, field, wanted) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value[field] !== wanted)
      throw error('The returned record does not match this page', {code: 'RECORD_MISMATCH'});
    return value;
  };
  return Object.freeze({network, ready, probe, stats,
    accountAges: async () => network === 'mainnet'
      ? validateAccountAges(await read('/history/accounts', {reportError:false}))
      : {data:[],basis:'unavailable',truncated:false},
    accountPrice: async () => {
      if (network !== 'mainnet') return null;
      const path = '/market/supply';
      const feed = await read(path, {reportError:false,timeoutMs:supplyTimeoutMs});
      return stalePaths.has(path) ? validateStoredAccountPrice(feed, now()) : validateAccountPrice(feed, now());
    },
    blocks: async () => {
      const response = await read('/v2/blocks?page=1&page_size=10');
      if (!Array.isArray(response.data)) throw new Error('Invalid blocks response');
      return response.data.map(normalizeBlock);
    },
    block: async (slot, {optional = false} = {}) => {
      if (!/^\d{1,16}$/.test(String(slot)) || !Number.isSafeInteger(Number(slot))) throw error('Invalid block slot', {code: 'INVALID_IDENTIFIER'});
      const value = (await read(`/v2/block/slot/${Number(slot)}`, optional ? {reportError: false, timeoutMs: 2000} : {})).data;
      return normalizeBlock(matchingRecord(value, 'slot', Number(slot)));
    },
    transactions: async (page = 1, pageSize = 20) => read(`/v2/transactions?page=${page}&page_size=${pageSize}`),
    transaction: async signature => matchingRecord((await read(`/v2/tx/${encodeURIComponent(signature)}`)).data, 'signature', signature),
    account: async address => matchingRecord((await read(`/v2/account/${encodeURIComponent(address)}`)).data, 'address', address),
    accountTransactions: async (address, page = 1, pageSize = 20) => read(`/v2/account/${encodeURIComponent(address)}/transactions?page=${page}&page_size=${pageSize}`),
    validators: async () => (await read('/v2/validators')).data,
    search: async value => (await read(`/v2/search?q=${encodeURIComponent(value)}`)).data,
    balances: async () => {
      const result = await read('/balances');
      if (!result || Array.isArray(result) || Object.entries(result).some(([address, value]) =>
          !/^[A-Za-z0-9_-]{1,128}$/.test(address) || typeof value === 'number' && !Number.isSafeInteger(value) ||
          !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) > 18446744073709551615n)) throw new Error('Invalid balance map');
      return result;
    },
    tokens: () => list('/v2/tokens'),
    token: async id => {
      const tokens = network === 'testnet' ? (await read(`/v2/tokens?token_id=${encodeURIComponent(id)}`)).data : await list('/v2/tokens');
      if (!Array.isArray(tokens)) throw new Error('Invalid token lookup');
      return tokens.find(token => token.token_id === id) || null;
    },
    holders: id => list(`/v2/token/${encodeURIComponent(id)}/holders`, 'holders'),
    contracts: () => list('/v2/contracts', 'contracts'),
    contract: async id => normalizeContract((await read(`/v2/contract/${encodeURIComponent(id)}`)), id),
    quote: async (id, token, amount) => (await read(`/v2/contract/${encodeURIComponent(id)}/quote?input_token=${encodeURIComponent(token)}&amount=${encodeURIComponent(amount)}`)).quote,
    pools: () => list('/v2/pools', 'pools'),
  });
}

export function normalizeContract(response, expectedId) {
  const contract = response?.contract || response?.data;
  if (!contract || (contract.contract_id || contract.id) !== expectedId || typeof contract.owner !== 'string') throw new Error('Invalid contract identity');
  if (contract.contract_type === 'Swap' && contract.state?.Swap) {
    const state = contract.state.Swap;
    if (typeof state.token_a !== 'string' || typeof state.token_b !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(String(state.reserve_a)) || !/^(0|[1-9]\d*)$/.test(String(state.reserve_b)) ||
        !Number.isInteger(state.fee_bps) || state.fee_bps < 0 || state.fee_bps >= 10000) throw new Error('Invalid swap contract');
    return {...contract, contract_type: 'swap', state, params: state};
  }
  // Existing testnet v2 returns the normalized shape consumed by the UI.
  if (typeof contract.contract_type === 'string' && contract.contract_type === contract.contract_type.toLowerCase()) return contract;
  // Unknown raw enum variants are shown as raw records, never guessed dates or balances.
  return {...contract, raw_contract_type: contract.contract_type, contract_type: 'Recorded contract'};
}
