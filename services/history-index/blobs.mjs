import { createHash } from 'node:crypto';
import { open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LIMITS = Object.freeze({
  manifestBytes: 4 * 1024 * 1024, fileBytes: 8 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024, files: 50_000,
});
const HASH = /^[a-f0-9]{64}$/;
const hash = value => typeof value === 'string' && HASH.test(value);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const token = value => typeof value === 'string' && TOKEN.test(value);
const decoder = new TextDecoder('utf-8', { fatal: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const jsonBytes = value => Buffer.from(JSON.stringify(value), 'utf8');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function limitsFor(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (Object.keys(limits).some(key => !Object.hasOwn(DEFAULT_LIMITS, key) || !integer(limits[key]) || limits[key] === 0)) {
    throw new Error('Invalid archive limits');
  }
  return limits;
}

export function safeArchivePath(path) {
  return typeof path === 'string' && path.length <= 256 && path !== 'manifest.json'
    && path.endsWith('.json') && path.split('/').every(part =>
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && part !== '.' && part !== '..');
}

function decodeJSON(bytes, label) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error(`Invalid UTF-8 JSON in ${label}`); }
}

async function boundedBytes(value, maximum, label) {
  if (value?.getReader) {
    const reader = value.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximum - size) throw new Error(`${label} exceeds size limit`);
        chunks.push(chunk); size += chunk.byteLength;
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      void Promise.resolve(reader.cancel()).catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8')
    : value instanceof ArrayBuffer ? new Uint8Array(value)
    : value instanceof Uint8Array ? value : null;
  if (!bytes) throw new Error(`Missing bytes for ${label}`);
  if (bytes.byteLength > maximum) throw new Error(`${label} exceeds size limit`);
  return Buffer.from(bytes);
}

function freezeJSON(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJSON(child);
    Object.freeze(value);
  }
  return value;
}

export function validateManifest(input, chainId, overrides) {
  const limits = limitsFor(overrides);
  if (!token(chainId)) throw new Error('Invalid archive chain ID');
  let bytes;
  try { bytes = jsonBytes(input); } catch { throw new Error('Manifest is not serializable JSON'); }
  if (bytes.length > limits.manifestBytes) throw new Error('Manifest exceeds size limit');
  const manifest = decodeJSON(bytes, 'manifest'); // Own a snapshot across asynchronous uploads.
  if (!object(manifest) || manifest.schema_version !== 1 || manifest.chain_id !== chainId
    || !token(manifest.generation) || !integer(manifest.indexed_from)
    || !object(manifest.tip) || !integer(manifest.tip.slot) || !hash(manifest.tip.hash)
    || manifest.tip.slot < manifest.indexed_from || !object(manifest.coverage)
    || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > limits.files) {
    throw new Error('Invalid or wrong-chain archive manifest');
  }
  let total = 0;
  const files = new Map();
  for (const file of manifest.files) {
    if (!object(file) || !safeArchivePath(file.path) || !hash(file.sha256)
      || !integer(file.bytes) || file.bytes === 0 || file.bytes > limits.fileBytes || files.has(file.path)) {
      throw new Error('Invalid or duplicate archive file entry');
    }
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > limits.totalBytes) throw new Error('Archive exceeds total size limit');
    files.set(file.path, file);
  }
  return { manifest: freezeJSON(manifest), files, bytes, sha256: sha256(bytes), totalBytes: total };
}

function validatePointer(pointer, chainId) {
  if (!object(pointer) || pointer.schema_version !== 1 || pointer.chain_id !== chainId
    || !token(pointer.generation) || !hash(pointer.manifest_sha256)
    || !integer(pointer.indexed_from) || !object(pointer.tip) || !integer(pointer.tip.slot)
    || pointer.tip.slot < pointer.indexed_from || !hash(pointer.tip.hash)) throw new Error('Invalid archive pointer');
  return pointer;
}

/** No connection or credential lookup happens until an adapter method is called. */
export function createHistoryBlobAdapter({ chainId, store, storeName = 'xeris-explorer-history', netlify = {}, limits: overrides } = {}) {
  if (!token(chainId) || typeof storeName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(storeName)) throw new Error('Invalid archive namespace');
  const limits = limitsFor(overrides), prefix = `chains/${chainId}/`, pointerKey = prefix + 'current.json';
  if (Object.keys(netlify).some(key => !['siteID', 'token', 'region'].includes(key))) throw new Error('Unsupported Netlify option');
  let storePromise;
  const manifests = new Map();
  async function client() {
    if (!storePromise) storePromise = (async () => {
      if (store) return store;
      let sdk;
      try { sdk = await import('@netlify/blobs'); }
      catch { throw new Error('Install @netlify/blobs in the deployment runtime before using remote storage'); }
      return sdk.getStore({ name: storeName, ...netlify, consistency: 'strong' });
    })();
    const result = await storePromise;
    if (!result || !['get', 'getWithMetadata', 'set'].every(name => typeof result[name] === 'function')) throw new Error('Unsupported Blobs store client');
    return result;
  }
  async function currentPointer() {
    const result = await (await client()).getWithMetadata(pointerKey, { type: 'stream', consistency: 'strong' });
    if (result === null) return null;
    if (typeof result.etag !== 'string' || !result.etag) throw new Error('Archive pointer has no ETag');
    return { pointer: validatePointer(decodeJSON(await boundedBytes(result.data, 4096, 'pointer'), 'pointer'), chainId), etag: result.etag };
  }
  const generationKey = generation => {
    if (!token(generation)) throw new Error('Invalid archive generation');
    return prefix + `generations/${generation}/`;
  };
  async function generationRecord(generation) {
    const key = generationKey(generation);
    if (!manifests.has(generation)) {
      const raw = await (await client()).get(key + 'manifest.json', { type: 'stream', consistency: 'strong' });
      if (raw === null) throw new Error('Archive generation is unavailable');
      const bytes = await boundedBytes(raw, limits.manifestBytes, 'manifest');
      const record = validateManifest(decodeJSON(bytes, 'manifest'), chainId, limits);
      if (record.manifest.generation !== generation) throw new Error('Archive generation mismatch');
      record.sha256 = sha256(bytes); // Check the exact stored serialization against the pointer.
      if (manifests.size >= 2) manifests.delete(manifests.keys().next().value);
      manifests.set(generation, record);
    }
    return manifests.get(generation);
  }
  async function readCurrent() {
    const active = await currentPointer();
    if (!active) return null;
    const record = await generationRecord(active.pointer.generation);
    if (record.sha256 !== active.pointer.manifest_sha256 || record.manifest.indexed_from !== active.pointer.indexed_from
      || record.manifest.tip.slot !== active.pointer.tip.slot || record.manifest.tip.hash !== active.pointer.tip.hash) {
      throw new Error('Archive pointer does not match its generation');
    }
    return { manifest: record.manifest, etag: active.etag };
  }
  async function readJSON(path, { generation } = {}) {
    if (!safeArchivePath(path)) throw new Error('Invalid archive path');
    const selected = generation ?? (await readCurrent())?.manifest.generation;
    if (!selected) throw new Error('No active archive generation');
    const record = await generationRecord(selected), file = record.files.get(path);
    if (!file) throw new Error('Path is not listed in this archive generation');
    const raw = await (await client()).get(generationKey(selected) + path, { type: 'stream', consistency: 'strong' });
    const bytes = await boundedBytes(raw, file.bytes, path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Archive integrity failure: ${path}`);
    return { generation: selected, data: decodeJSON(bytes, path) };
  }
  async function immutablePut(key, bytes, digest, metadata) {
    const remote = await client();
    const result = await remote.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { onlyIfNew: true, metadata });
    if (result?.modified === true) return;
    const existing = await boundedBytes(await remote.get(key, { type: 'stream', consistency: 'strong' }), bytes.length, key);
    if (existing.length !== bytes.length || sha256(existing) !== digest) throw new Error('Immutable archive generation collision');
  }
  async function publish(input, readFile, { expectedGeneration, allowTipRegression = false } = {}) {
    if (typeof readFile !== 'function') throw new Error('A public export file reader is required');
    const record = validateManifest(input, chainId, limits), before = await currentPointer();
    if (expectedGeneration !== undefined && expectedGeneration !== (before?.pointer.generation ?? null)) throw new Error('Archive generation changed before publication');
    if (!allowTipRegression && before && record.manifest.tip.slot < before.pointer.tip.slot) throw new Error('Refusing an archive tip regression');
    const base = generationKey(record.manifest.generation);
    for (const file of record.files.values()) {
      const bytes = await boundedBytes(await readFile(file.path), file.bytes, file.path);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Export integrity failure: ${file.path}`);
      decodeJSON(bytes, file.path);
      await immutablePut(base + file.path, bytes, file.sha256, { chain_id: chainId, generation: record.manifest.generation, sha256: file.sha256 });
    }
    await immutablePut(base + 'manifest.json', record.bytes, record.sha256, { chain_id: chainId, generation: record.manifest.generation, sha256: record.sha256 });
    const pointer = { schema_version: 1, chain_id: chainId, generation: record.manifest.generation,
      manifest_sha256: record.sha256, indexed_from: record.manifest.indexed_from, tip: record.manifest.tip };
    const options = before ? { onlyIfMatch: before.etag } : { onlyIfNew: true };
    const activated = await (await client()).set(pointerKey, JSON.stringify(pointer), options);
    if (activated?.modified !== true) throw new Error('Archive publication conflict; activation pointer was not updated');
    return { generation: record.manifest.generation, files: record.files.size, bytes: record.totalBytes, etag: activated.etag };
  }
  return Object.freeze({ readCurrent, readJSON, readGeneration: async generation => (await generationRecord(generation)).manifest, publish });
}

/** Confined reader for explicit public export directories; never scans adjacent files. */
export async function openLocalExport(directory, { limits: overrides } = {}) {
  const limits = limitsFor(overrides), root = await realpath(resolve(directory));
  if (!(await lstat(root)).isDirectory()) throw new Error('Export root must be a directory');
  async function read(path, maximum = limits.fileBytes) {
    if (path !== 'manifest.json' && !safeArchivePath(path)) throw new Error('Invalid archive path');
    let filePath = root;
    for (const part of path.split('/')) {
      filePath = join(filePath, part);
      if ((await lstat(filePath)).isSymbolicLink()) throw new Error('Export symlinks are not allowed');
    }
    const canonical = await realpath(filePath);
    if (!canonical.startsWith(root + sep)) throw new Error('Export path leaves its root');
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid export file size or type');
      const chunks = []; let total = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maximum) throw new Error('Export file exceeds size limit');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } finally { await handle.close(); }
  }
  const manifest = decodeJSON(await read('manifest.json', limits.manifestBytes), 'manifest');
  return { manifest, readFile: path => read(path) };
}

export async function verifyLocalExport(directory, chainId, { limits } = {}) {
  const local = await openLocalExport(directory, { limits }), record = validateManifest(local.manifest, chainId, limits);
  for (const file of record.files.values()) {
    const bytes = await local.readFile(file.path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Export integrity failure: ${file.path}`);
    decodeJSON(bytes, file.path);
  }
  return { chain_id: chainId, generation: record.manifest.generation, files: record.files.size, bytes: record.totalBytes, remote_writes: 0 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 5 || process.argv[2] !== 'verify-export') {
    throw new Error('Usage: node blobs.mjs verify-export <public-export-directory> <chain-id>');
  }
  console.log(JSON.stringify(await verifyLocalExport(process.argv[3], process.argv[4]), null, 2));
}
