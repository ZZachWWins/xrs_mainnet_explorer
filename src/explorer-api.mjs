import {NETWORKS, parsePublicJSON, verifyCheckpoint} from './network.mjs';

export function createExplorerAPI(network, {fetchImpl = fetch, onError = () => {}, onNotice = () => {}, now = Date.now, getContext = () => ''} = {}) {
  if (!Object.hasOwn(NETWORKS, network)) throw new Error('Unknown network');
  const prefix = `/networks/${network}`;
  let identity;
  const pending = new Map();
  async function read(path, {identityCheck = false} = {}) {
    const context = getContext();
    if (!identityCheck) await ready();
    if (pending.has(path)) return pending.get(path);
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), network === 'testnet' && path.startsWith('/v2/tokens') ? 25_000 : 12_000);
      try {
        const response = await fetchImpl(prefix + path, {cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal});
        if (!response.ok) throw new Error(`${NETWORKS[network].name}: this data is currently unavailable`);
        if (response.headers.get('x-xeris-network') !== network) throw new Error('Network response binding failed');
        const result = parsePublicJSON(await response.text());
        if (result?.success === false || result?.error) throw new Error(`${NETWORKS[network].name}: requested record is unavailable`);
        return result;
      } catch (error) { onError(error.message, context); throw error; }
      finally { clearTimeout(timer); }
    })();
    pending.set(path, task);
    try { return await task; } finally { if (pending.get(path) === task) pending.delete(path); }
  }
  function ready() {
    if (!identity) {
      identity = read(`/v2/block/slot/${NETWORKS[network].checkpointSlot}`, {identityCheck: true})
        .then(value => verifyCheckpoint(network, value));
    }
    return identity;
  }
  async function list(path, key = 'data') {
    const context = getContext();
    const rows = []; let after = null; const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const response = await read(path + '?limit=100' + (after ? '&after=' + encodeURIComponent(after) : ''));
      if (!Array.isArray(response[key])) throw new Error('Invalid list response');
      rows.push(...response[key]);
      if (response.truncated === true) onNotice(`Showing ${response[key].length} core and recent tokens from ${Number(response.total).toLocaleString()} registered tokens. Direct token links open exact records.` +
        (response.omitted_count ? ` ${response.omitted_count} historical records are unavailable in this view.` : ''), context);
      if (!response.next_after) return rows;
      if (typeof response.next_after !== 'string' || seen.has(response.next_after)) throw new Error('Incomplete list response');
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
        const feed = await read('/market/supply');
        if (feed.schema_version !== '2' || feed.chain_id !== 'xeris-mainnet-v4' || feed.status !== 'ready' ||
            feed.supply?.basis !== 'unlocked_on_chain_v2' || !/^[0-9]+$/.test(feed.supply?.circulating_raw) ||
            !/^[0-9]+$/.test(feed.expires_at_ms) || BigInt(feed.expires_at_ms) <= BigInt(now())) throw new Error('Live circulating supply unavailable');
        const expires = BigInt(feed.expires_at_ms);
        Object.defineProperty(result, 'circulating_supply', {enumerable: true,
          get: () => BigInt(now()) < expires ? feed.supply.circulating_raw : undefined});
        result.supply_observed_at = feed.observed_at;
        // Gross emitted amount is not labelled circulating or outstanding supply.
        result.total_mined_raw = feed.mining?.total_mined_raw;
      } catch { /* Supply stays unavailable; never substitute a token cap. */ }
    }
    return result;
  }
  function normalizeBlock(block) {
    return block && {...block, transactions: block.transactions || block.txs || [],
      tx_count: block.transaction_count ?? block.tx_count ?? (block.transactions || block.txs || []).length};
  }
  return Object.freeze({network, ready, stats,
    blocks: async () => {
      const response = await read('/v2/blocks?page=1&page_size=10');
      if (!Array.isArray(response.data)) throw new Error('Invalid blocks response');
      return response.data.map(normalizeBlock);
    },
    block: async slot => normalizeBlock((await read(`/v2/block/slot/${encodeURIComponent(slot)}`)).data),
    transactions: async (page = 1, pageSize = 20) => read(`/v2/transactions?page=${page}&page_size=${pageSize}`),
    transaction: async signature => (await read(`/v2/tx/${encodeURIComponent(signature)}`)).data,
    account: async address => (await read(`/v2/account/${encodeURIComponent(address)}`)).data,
    accountTransactions: async (address, page = 1, pageSize = 20) => read(`/v2/account/${encodeURIComponent(address)}/transactions?page=${page}&page_size=${pageSize}`),
    validators: async () => (await read('/v2/validators')).data,
    search: async value => (await read(`/v2/search?q=${encodeURIComponent(value)}`)).data,
    balances: async () => {
      const result = await read('/balances');
      if (!result || Array.isArray(result) || Object.entries(result).some(([address, value]) =>
          !/^[A-Za-z0-9_-]{1,128}$/.test(address) || !/^(0|[1-9]\d*)$/.test(String(value)))) throw new Error('Invalid balance map');
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
    contract: async id => normalizeContract((await read(network === 'mainnet' ? `/contract/${encodeURIComponent(id)}` : `/v2/contract/${encodeURIComponent(id)}`)), id),
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
