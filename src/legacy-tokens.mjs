// The legacy Testnet ignores pagination. Project its public registry server-side
// so Netlify and browsers receive a bounded, explicitly partial listing.
export const LEGACY_REGISTRY_MAX_BYTES = 24 * 1024 * 1024;
const MAX_ROWS = 100_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UNSIGNED = /^(0|[1-9]\d*)$/;
const U64 = 18446744073709551615n;

function losslessRegistry(text) {
  if (typeof text !== 'string' || text.length > LEGACY_REGISTRY_MAX_BYTES ||
      new TextEncoder().encode(text).length > LEGACY_REGISTRY_MAX_BYTES) throw new Error('Legacy registry exceeds size limit');
  // Skip complete quoted strings, including escaped quotes. JSON.parse still
  // validates grammar after unsafe integer lexemes have been preserved.
  const protectedNumbers = text.replace(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"') return token;
    if (!Number.isFinite(Number(token))) throw new Error('Nonfinite registry number');
    return /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
  });
  return JSON.parse(protectedNumbers);
}

function raw(value, field) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Invalid ${field}`);
  if (!['number', 'string'].includes(typeof value) || !UNSIGNED.test(String(value)) || BigInt(value) > U64) throw new Error(`Invalid ${field}`);
  return String(value);
}

function projectedToken(token) {
  const result = {token_id: token.token_id};
  for (const field of ['name', 'symbol', 'mint_authority']) {
    if (token[field] != null) {
      if (typeof token[field] !== 'string' || token[field].length > 256) throw new Error(`Invalid token ${field}`);
      result[field] = token[field];
    }
  }
  if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 18) throw new Error('Invalid token decimals');
  result.decimals = token.decimals;
  for (const field of ['max_supply', 'current_supply', 'created_slot']) {
    if (token[field] != null) result[field] = raw(token[field], field);
  }
  // Preserve small public RWA descriptors without passing arbitrary large blobs.
  if (token.rwa_metadata != null && typeof token.rwa_metadata === 'object' &&
      !Array.isArray(token.rwa_metadata) && JSON.stringify(token.rwa_metadata).length <= 4096) result.rwa_metadata = token.rwa_metadata;
  return result;
}

export function projectLegacyTokens(text, {tokenId = null, limit = 100} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (tokenId !== null && (typeof tokenId !== 'string' || !ID.test(tokenId)))) throw new Error('Invalid registry selection');
  const response = losslessRegistry(text);
  if (response?.success !== true || !Array.isArray(response.data) || response.data.length > MAX_ROWS) throw new Error('Invalid legacy registry');
  const rows = [];
  let omittedCount = 0;
  const ids = new Set();
  for (const row of response.data) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.token_id !== 'string') throw new Error('Invalid token record');
    // Legacy history contains empty IDs and IDs with spaces that cannot use the
    // supported detail routes. Report omissions instead of breaking all tokens.
    if (!ID.test(row.token_id)) { omittedCount++; continue; }
    if (ids.has(row.token_id)) throw new Error('Duplicate token identifier');
    ids.add(row.token_id);
    raw(row.created_slot ?? 0, 'created slot');
    rows.push(row);
  }
  let selection;
  if (tokenId !== null) selection = rows.filter(row => row.token_id === tokenId);
  else {
    const core = rows.filter(row => row.token_id === 'xrs_native' || row.token_id === 'xeris_usdc').slice(0, limit);
    const candidates = rows.filter(row => row.token_id !== 'xrs_native' && row.token_id !== 'xeris_usdc');
    candidates.sort((a, b) => {
      const left = BigInt(a.created_slot ?? 0), right = BigInt(b.created_slot ?? 0);
      return left > right ? -1 : left < right ? 1 : a.token_id < b.token_id ? -1 : a.token_id > b.token_id ? 1 : 0;
    });
    selection = [...core, ...candidates.slice(0, limit - core.length)];
  }
  return {success: true, data: selection.map(projectedToken), total: response.data.length,
    omitted_count: omittedCount,
    truncated: tokenId === null && selection.length < response.data.length,
    coverage: tokenId === null ? 'core_and_latest' : 'exact_token', next_after: null};
}
