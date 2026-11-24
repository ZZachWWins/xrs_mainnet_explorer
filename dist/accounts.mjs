// Presentation metadata only: first indexed activity is not key creation.
const RAW = /^(0|[1-9][0-9]{0,19})$/;
const MAX = 18446744073709551615n;
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function validateAccountAges(value) {
  if (value?.coverage?.chain_id !== 'xeris-mainnet-v4' || !/^[a-f0-9]{64}$/.test(value.generation) ||
      value.basis !== 'earliest_indexed_activity' || !Array.isArray(value.data) || value.data.length > 100 ||
      typeof value.truncated !== 'boolean' || !integer(value.coverage.indexed_from) || value.coverage.indexed_from < 1 ||
      !integer(value.coverage.tip?.slot) || value.coverage.tip.slot < value.coverage.indexed_from) throw Error('Account age metadata unavailable');
  const seen = new Set();
  for (const row of value.data) {
    if (!row || typeof row.address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.address) || seen.has(row.address) ||
        !integer(row.first_seen_slot) || row.first_seen_slot < value.coverage.indexed_from || row.first_seen_slot > value.coverage.tip.slot ||
        row.first_seen_timestamp_ms !== null && (!integer(row.first_seen_timestamp_ms) || row.first_seen_timestamp_ms < 1 || row.first_seen_timestamp_ms > 8640000000000000))
      throw Error('Invalid account age metadata');
    seen.add(row.address);
  }
  return {data:value.data, basis:value.basis, truncated:value.truncated};
}
export function validateAccountPrice(feed, now = Date.now()) {
  const market = feed?.market;
  if (feed?.schema_version !== '2' || feed.chain_id !== 'xeris-mainnet-v4' || feed.status !== 'ready' ||
      market?.token_id !== 'native_xrs' || market.decimals !== '9' || market.quote_token_id !== 'xeris_usdc' ||
      market.quote_decimals !== '6' || market.price_pool_id !== 'xrs-xusdc-mainnet-v1' || market.price_basis !== 'pool_spot' ||
      typeof market.price_quote_raw_numerator !== 'string' || typeof market.price_xrs_raw_denominator !== 'string' ||
      !RAW.test(market.price_quote_raw_numerator) || !RAW.test(market.price_xrs_raw_denominator) ||
      BigInt(market.price_quote_raw_numerator) <= 0n || BigInt(market.price_quote_raw_numerator) > MAX ||
      BigInt(market.price_xrs_raw_denominator) <= 0n || BigInt(market.price_xrs_raw_denominator) > MAX ||
      typeof feed.observed_at_ms !== 'string' || typeof feed.expires_at_ms !== 'string' ||
      !/^[0-9]{1,16}$/.test(feed.observed_at_ms) || !/^[0-9]{1,16}$/.test(feed.expires_at_ms) ||
      !integer(now) || BigInt(feed.observed_at_ms) > BigInt(now) + 2000n ||
      BigInt(feed.expires_at_ms) <= BigInt(now) || BigInt(feed.expires_at_ms) <= BigInt(feed.observed_at_ms) ||
      BigInt(feed.expires_at_ms) - BigInt(feed.observed_at_ms) > 20000n) throw Error('Current XRS valuation unavailable');
  return Object.freeze({numerator:market.price_quote_raw_numerator,denominator:market.price_xrs_raw_denominator,
    observedAtMs:feed.observed_at_ms,expiresAtMs:feed.expires_at_ms});
}
export function accountUSD(raw, quote, now = Date.now()) {
  try {
    if (!quote || !RAW.test(String(raw)) || typeof raw === 'number' && !Number.isSafeInteger(raw) || BigInt(raw) > MAX ||
        !RAW.test(quote.numerator) || !RAW.test(quote.denominator) || BigInt(quote.denominator) <= 0n || BigInt(quote.numerator) <= 0n ||
        !/^[0-9]{1,16}$/.test(quote.expiresAtMs) || !/^[0-9]{1,16}$/.test(quote.observedAtMs) || !integer(now) ||
        BigInt(now) >= BigInt(quote.expiresAtMs) || BigInt(now) + 2000n < BigInt(quote.observedAtMs)) return null;
    const numerator = BigInt(raw) * BigInt(quote.numerator), denominator = BigInt(quote.denominator) * 10000n;
    if (numerator > 0n && numerator < denominator) return '<$0.01';
    const cents = (numerator + denominator / 2n) / denominator;
    return '$' + (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (cents % 100n).toString().padStart(2,'0');
  } catch { return null; }
}
export function sortAccounts(entries, ages = [], key = 'age', direction = 'asc') {
  const map = new Map(ages.map(row => [row.address,row])), sign = direction === 'desc' ? -1 : 1;
  return [...entries].sort(([a,av],[b,bv]) => {
    let comparison = 0;
    if (key === 'age') {
      const as = map.get(a)?.first_seen_slot, bs = map.get(b)?.first_seen_slot;
      if (as == null || bs == null) return as == null && bs == null ? a.localeCompare(b) : as == null ? 1 : -1;
      comparison = as < bs ? -1 : as > bs ? 1 : 0;
    } else if (key === 'balance') comparison = BigInt(av) < BigInt(bv) ? -1 : BigInt(av) > BigInt(bv) ? 1 : 0;
    else comparison = a.localeCompare(b);
    return comparison * sign || a.localeCompare(b);
  });
}
export function accountFirstSeen(row) {
  if (!row) return 'Unavailable';
  if (row.first_seen_timestamp_ms === null && integer(row.first_seen_slot) && row.first_seen_slot > 0) return 'Block ' + row.first_seen_slot.toLocaleString('en-US');
  if (!integer(row.first_seen_timestamp_ms) || row.first_seen_timestamp_ms < 1) return 'Unavailable';
  const date = new Date(row.first_seen_timestamp_ms);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return date.toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'}) + ' UTC';
}
