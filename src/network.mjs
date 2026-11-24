// Public configuration. No wallet, signer, secret, arbitrary endpoint, or fallback.
export const DEFAULT_NETWORK = 'testnet';
export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({name: 'Mainnet Beta', origin: 'https://mainnetrpc.xerisweb.com', checkpointSlot: 27201,
    checkpointHash: '0a401c139eef73f049010450d4aa13ef38636799784d01bbc0ecdb9c71facaf3'}),
  testnet: Object.freeze({name: 'Testnet', origin: 'http://138.197.116.81:50008', checkpointSlot: 27201,
    checkpointHash: '04a25302888ed7988efe33b427d9409ab6ba8c144cb0993ed515e57bbbef7fc7'}),
});
export function selectedNetwork(url) {
  const values = new URL(url).searchParams.getAll('network');
  if (!values.length) return DEFAULT_NETWORK;
  if (values.length !== 1 || !Object.hasOwn(NETWORKS, values[0])) throw new Error('Unknown or ambiguous network');
  return values[0];
}
export function networkLink(input, network, base) {
  if (!Object.hasOwn(NETWORKS, network)) throw new Error('Unknown network');
  const url = new URL(input, base);
  if (url.origin !== new URL(base).origin) return url.href;
  url.searchParams.set('network', network);
  return url.pathname + url.search + url.hash;
}
export function verifyCheckpoint(network, response) {
  const pinned = NETWORKS[network];
  if (!pinned || response?.success !== true || response?.data?.slot !== pinned.checkpointSlot ||
      response.data.hash !== pinned.checkpointHash) throw new Error('Network checkpoint mismatch; data display stopped');
  return true;
}
// Preserve unsafe raw integers instead of silently rounding financial/history data.
// Only JSON numeric tokens outside strings are transformed; JSON.parse still
// validates the full grammar. Display code may explicitly format rounded units.
export function parsePublicJSON(text) {
  if (typeof text !== 'string' || text.length > 4_194_304) throw new Error('Invalid public response size');
  let result = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (quoted) {
      result += c; i++;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; result += c; i++; }
    else if (c === '-' || /[0-9]/.test(c)) {
      const token = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
      if (!token) throw new Error('Invalid JSON number');
      const unsafe = /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token));
      if (!Number.isFinite(Number(token))) throw new Error('Nonfinite public number');
      result += unsafe ? JSON.stringify(token) : token; i += token.length;
    } else { result += c; i++; }
  }
  return JSON.parse(result);
}
export function rawUnits(value, decimals = 9, maximumFractionDigits = 9) {
  const raw = String(value);
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return '—';
  const padded = raw.padStart(decimals + 1, '0');
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).slice(0, maximumFractionDigits).replace(/0+$/, '') : '';
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}
