export {sortAccounts, accountUSD, accountFirstSeen} from './accounts.mjs';
// View lifetimes are independent of RPC lifetimes. A response for a previous
// route must never overwrite the next account, page or record.
export function loadAccountView(api, address, page, emit) {
  let active = true;
  Promise.resolve().then(() => api.account(address)).then(value => {
    if (!value || value.address !== address) throw new Error('Account response identity mismatch');
    if (active) emit.account(value);
  }).catch(error => { if (active) emit.accountError(error); });
  Promise.resolve().then(() => api.accountTransactions(address, page, 20)).then(async response => {
    if (!Array.isArray(response.data)) throw new Error('Account history is unavailable');
    const seen = new Set();
    const rows = response.data.filter(row => {
      if (!row || typeof row.signature !== 'string' || seen.has(row.signature)) return false;
      seen.add(row.signature); return true;
    });
    if (!active) return;
    emit.history(rows, response.pagination || {});
    const enriched = await enrichTransactionTimes(api, rows, () => active);
    if (active) emit.history(enriched, response.pagination || {});
  }).catch(error => { if (active) emit.historyError(error); });
  return () => { active = false; };
}

export async function enrichTransactionTimes(api, rows, active = () => true) {
  const times = new Map();
  const slots = [...new Set(rows.filter(row => !row.timestamp && Number.isSafeInteger(row.block_slot)).map(row => row.block_slot))].slice(0, 3);
  // One optional read at a time, after the original rows are already visible.
  for (const slot of slots) {
    if (!active()) return rows;
    try {
      const block = await api.block(slot, {optional: true});
      if (block?.slot === slot && Number.isSafeInteger(block.poh_timestamp)) times.set(slot, block.poh_timestamp);
    } catch { /* Missing timestamps do not erase history or block balances. */ }
  }
  return rows.map(row => row.timestamp || !times.has(row.block_slot) ? row : {...row, timestamp: times.get(row.block_slot)});
}

export function loadTransactionsView(api, page, emit) {
  let active = true;
  Promise.resolve().then(() => api.transactions(page, 20)).then(async response => {
    if (!Array.isArray(response.data)) throw new Error('Transaction history is unavailable');
    if (!active) return;
    emit.rows(response.data, response.pagination || {});
    const rows = await enrichTransactionTimes(api, response.data, () => active);
    if (active) emit.rows(rows, response.pagination || {});
  }).catch(error => { if (active) emit.error(error); });
  return () => { active = false; };
}

export function dashboardLoader(api, emit) {
  let active = true, pending = false;
  return {
    async refresh() {
      if (!active || pending) return;
      pending = true;
      try {
        await Promise.allSettled([
          api.blocks().then(rows => { if (active) emit.blocks(rows); }).catch(error => { if (active) emit.blocksError(error); }),
          api.stats().then(value => { if (active) emit.stats(value); }).catch(error => { if (active) emit.statsError(error); }),
          api.transactions(1, 5).then(async value => {
            if (!Array.isArray(value.data)) throw new Error('Recent transactions are unavailable');
            if (!active) return;
            const rows = value.data.slice(0, 5); emit.transactions(rows);
            const enriched = await enrichTransactionTimes(api, rows, () => active);
            if (active) emit.transactions(enriched);
          }).catch(error => { if (active) emit.transactionsError(error); }),
        ]);
      } finally { pending = false; }
    },
    dispose() { active = false; },
  };
}

// Pool records remain useful if optional token metadata cannot be retrieved.
export function loadPoolsView(api, emit) {
  let active = true;
  Promise.resolve().then(() => api.pools()).then(rows => {
    if (!Array.isArray(rows)) throw new Error('Pool records unavailable');
    if (active) emit.pools(rows);
  }).catch(error => { if (active) emit.error(error); });
  Promise.resolve().then(() => api.tokens()).then(tokens => {
    if (!Array.isArray(tokens)) throw new Error('Token metadata unavailable');
    const decimals = Object.create(null);
    for (const token of tokens) {
      if (typeof token?.token_id === 'string' && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 18)
        decimals[token.token_id] = token.decimals;
    }
    if (active) emit.decimals(decimals);
  }).catch(() => { if (active) emit.decimals(Object.create(null)); });
  return () => { active = false; };
}

export function transactionStatus(status) {
  const states = {
    confirmed: {label: 'Confirmed', color: 'text-green-400'},
    success: {label: 'Success reported', color: 'text-green-400'},
    failed: {label: 'Failed', color: 'text-red-400'},
    partial: {label: 'Partially executed', color: 'text-yellow-400'},
    pending: {label: 'Pending', color: 'text-yellow-400'},
    queued: {label: 'Queued', color: 'text-yellow-400'},
  };
  return Object.hasOwn(states, status) ? states[status] : {label: 'Outcome unavailable', color: 'text-text-dim'};
}
