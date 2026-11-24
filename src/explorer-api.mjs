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

export function createExplorerAPI(network, {fetchImpl = fetch, onError = () => {}, onNotice = () => {}, now = Date.now, getContext = () => '', readTimeoutMs, supplyTimeoutMs = 2000} = {}) {
  if (!Object.hasOwn(NETWORKS, network)) throw new Error('Unknown network');
  const prefix = `/networks/${network}`;
  let identity, bindingFailure, lastSupply;
  const pending = new Map();
  const error = (message, options) => new ExplorerError(message, {network, ...options});
  async function read(path, {identityCheck = false, reportError = true, timeoutMs} = {}) {
    const context = getContext();
    const pendingKey = path + (timeoutMs === undefined ? '' : `|deadline:${timeoutMs}`);
    try {
      if (!identityCheck) await ready();
      if (bindingFailure) throw bindingFailure;
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
            if (bindingFailure) throw bindingFailure;
            return result;
          } catch (cause) {
            if (reader) void reader.cancel().catch(() => {});
            if (cause?.code === 'NETWORK_MISMATCH') bindingFailure = cause;
            if (cause instanceof ExplorerError) throw cause;
            throw error(`${NETWORKS[network].name}: this data is currently unavailable`, {code: controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR', retryable: true});
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
  function ready() {
    if (bindingFailure) return Promise.reject(bindingFailure);
    if (!identity) {
      const attempt = read(`/v2/block/slot/${NETWORKS[network].checkpointSlot}`, {identityCheck: true, reportError: false})
        .then(value => {
          try { return verifyCheckpoint(network, value); }
          catch { throw error('Network checkpoint mismatch; data display stopped', {code: 'NETWORK_MISMATCH'}); }
        });
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
        const feed = await read('/market/supply', {reportError: false, timeoutMs: supplyTimeoutMs});
        if (feed.schema_version !== '2' || feed.chain_id !== 'xeris-mainnet-v4' || feed.status !== 'ready' ||
            feed.supply?.basis !== 'unlocked_on_chain_v2' || !/^[0-9]+$/.test(feed.supply?.circulating_raw) ||
            !/^[0-9]+$/.test(feed.expires_at_ms) || BigInt(feed.expires_at_ms) <= BigInt(now())) throw new Error('Live circulating supply unavailable');
        lastSupply = {raw: feed.supply.circulating_raw, expires: BigInt(feed.expires_at_ms),
          observedAt: feed.observed_at, mined: feed.mining?.total_mined_raw};
      } catch (cause) {
        // A brief transport failure must not erase an observation that is still
        // within its original validity period. Invalid data is never retained.
        if (!(cause instanceof ExplorerError && cause.retryable)) lastSupply = undefined;
      }
      if (lastSupply && BigInt(now()) < lastSupply.expires) {
        const observed = lastSupply;
        Object.defineProperty(result, 'circulating_supply', {enumerable: true,
          get: () => BigInt(now()) < observed.expires ? observed.raw : undefined});
        result.supply_observed_at = observed.observedAt;
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
  return Object.freeze({network, ready, stats,
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
