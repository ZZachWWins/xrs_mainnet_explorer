import {createHash} from 'node:crypto';
import {createHistoryBlobAdapter, safeArchivePath, validateManifest} from '../services/history-index/blobs.mjs';

const CHAIN = 'xeris-mainnet-v4';
const SOURCE = 'https://mainnetrpc.xerisweb.com/archive-export/';
const REPOSITORY = 'https://github.com/ZZachWWins/xrs_mainnet_explorer/commit/';
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SITE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMITS = Object.freeze({manifestBytes: 256 * 1024, fileBytes: 1024 * 1024, totalBytes: 64 * 1024 * 1024, files: 1024});
const RUN_MS = 12 * 60 * 1000;
const REQUEST_MS = 10_000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value > 0;
const decoder = new TextDecoder('utf-8', {fatal: true});

// Netlify verifies the platform-event JWS before invoking this handler. The
// event payload is never accepted through a fetch/HTTP handler in this package.
export function isEligibleDeploy(event, runtimeSiteId) {
  const deploy = event?.deploy, site = event?.site;
  return typeof runtimeSiteId === 'string' && SITE.test(runtimeSiteId)
    && site?.id === runtimeSiteId && deploy?.siteId === runtimeSiteId
    && deploy.context === 'production' && deploy.branch === 'main'
    && deploy.state === 'ready' && deploy.manual === false
    && typeof deploy.id === 'string' && /^[a-f0-9]{24}$/.test(deploy.id)
    && typeof deploy.publishedAt === 'string' && Number.isFinite(Date.parse(deploy.publishedAt))
    && typeof deploy.commitRef === 'string' && COMMIT.test(deploy.commitRef)
    && deploy.commitUrl === REPOSITORY + deploy.commitRef;
}

function checkedPin(input) {
  const pin = Object.freeze({...input});
  if (!HASH.test(pin.generation) || !HASH.test(pin.manifestSha256)
    || !HASH.test(pin.canonicalManifestSha256) || !HASH.test(pin.tipHash)
    || !integer(pin.manifestBytes) || pin.manifestBytes > LIMITS.manifestBytes
    || !integer(pin.files) || pin.files > LIMITS.files
    || !integer(pin.bytes) || pin.bytes > LIMITS.totalBytes
    || !integer(pin.tipSlot) || pin.indexedFrom !== 1) throw new Error('Invalid pinned archive');
  return pin;
}

function matchesPin(record, pin) {
  const manifest = record.manifest;
  return record.sha256 === pin.canonicalManifestSha256
    && manifest.generation === pin.generation && manifest.indexed_from === pin.indexedFrom
    && manifest.tip.slot === pin.tipSlot && manifest.tip.hash === pin.tipHash
    && record.files.size === pin.files && record.totalBytes === pin.bytes;
}

async function defaultStoreFactory(fetchImpl) {
  const {getStore} = await import('@netlify/blobs');
  // No custom token/site option: the platform supplies credentials for this
  // site's existing site-wide namespace, also used by the read-only API.
  return getStore({name: 'xeris-explorer-history', consistency: 'strong', fetch: fetchImpl});
}

/** Initial publication only. A future archive updater needs its own review. */
export function createArchivePublisher({archive, runtimeSiteId = () => process.env.SITE_ID,
  fetchImpl = fetch, storeFactory = defaultStoreFactory, now = Date.now} = {}) {
  const pin = checkedPin(archive);
  return async event => {
    if (!isEligibleDeploy(event, runtimeSiteId())) return {status: 'ignored'};
    const deadline = now() + RUN_MS;
    const runController = new AbortController();
    const timer = setTimeout(() => runController.abort(), RUN_MS);
    timer.unref?.();
    let requests = 0, sourceBytes = 0;
    const assertBudget = () => {
      if (runController.signal.aborted || now() >= deadline) throw new Error('Archive publication time limit reached');
    };
    const boundedFetch = async (input, options = {}) => {
      assertBudget();
      if (++requests > pin.files * 4 + 32) throw new Error('Archive request limit reached');
      const incomingSignal = options.signal ?? (input instanceof Request ? input.signal : undefined);
      const signals = [runController.signal, AbortSignal.timeout(Math.max(1, Math.min(REQUEST_MS, deadline - now())))];
      if (incomingSignal) signals.push(incomingSignal);
      return fetchImpl(input, {...options, signal: AbortSignal.any(signals)});
    };
    const sourceFile = async (path, maximum) => {
      if (path !== 'manifest.json' && !safeArchivePath(path)) throw new Error('Invalid source path');
      const url = new URL(path, SOURCE + pin.generation + '/');
      const response = await boundedFetch(url.href, {method: 'GET', redirect: 'error', credentials: 'omit',
        cache: 'no-store', headers: {accept: 'application/json'}});
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href) || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Public archive source unavailable');
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
        void response.body.cancel().catch(() => {});
        throw new Error('Public archive size limit reached');
      }
      const reader = response.body.getReader(), chunks = [];
      let total = 0;
      try {
        while (true) {
          assertBudget();
          const {value, done} = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array) || value.byteLength > maximum - total) throw new Error('Public archive size limit reached');
          total += value.byteLength;
          sourceBytes += value.byteLength;
          if (sourceBytes > pin.bytes + pin.manifestBytes) throw new Error('Public archive total size limit reached');
          chunks.push(value);
        }
        return Buffer.concat(chunks, total);
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    };
    try {
      const rawStore = await storeFactory(boundedFetch);
      // Check the time budget before every storage action, including the final
      // CAS activation. Network calls made by the SDK also use boundedFetch.
      const store = Object.fromEntries(['get', 'getWithMetadata', 'set'].map(method => [method, (...args) => {
        assertBudget();
        return rawStore[method](...args);
      }]));
      const adapter = createHistoryBlobAdapter({chainId: CHAIN, store, limits: LIMITS});
      const current = await adapter.readCurrent();
      if (current) {
        const record = validateManifest(current.manifest, CHAIN, LIMITS);
        if (!matchesPin(record, pin)) return {status: 'already_initialized_other_generation'};
        return {status: 'already_published', generation: pin.generation};
      }
      const bytes = await sourceFile('manifest.json', pin.manifestBytes);
      if (bytes.length !== pin.manifestBytes || digest(bytes) !== pin.manifestSha256) throw new Error('Pinned manifest mismatch');
      const record = validateManifest(JSON.parse(decoder.decode(bytes)), CHAIN, LIMITS);
      if (!matchesPin(record, pin)) throw new Error('Pinned archive checkpoint mismatch');
      const result = await adapter.publish(record.manifest,
        path => sourceFile(path, record.files.get(path).bytes), {expectedGeneration: null});
      return {status: 'published', generation: result.generation, files: result.files, bytes: result.bytes};
    } finally {
      clearTimeout(timer);
      runController.abort();
    }
  };
}
