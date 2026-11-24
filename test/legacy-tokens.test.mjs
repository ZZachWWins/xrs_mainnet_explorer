import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLegacyTokens, LEGACY_REGISTRY_MAX_BYTES} from '../src/legacy-tokens.mjs';
const token = (token_id, created_slot = 0) => ({token_id, name: token_id, symbol: 'XRS', decimals: 9,
  max_supply: '700000000000000000', current_supply: '200307010815068434', created_slot});
const registry = data => JSON.stringify({success: true, data});

test('partial legacy view reserves core assets and orders latest tokens numerically', () => {
  const rows = [token('older', 9), token('newer', 10), token('xrs_native'), token('xeris_usdc'), token('latest', 100)];
  const result = projectLegacyTokens(registry(rows), {limit: 4});
  assert.deepEqual(result.data.map(t => t.token_id), ['xrs_native', 'xeris_usdc', 'latest', 'newer']);
  assert.equal(result.total, 5); assert.equal(result.truncated, true);
  assert.equal(result.coverage, 'core_and_latest'); assert.equal(result.next_after, null);
});
test('exact token lookup works outside the displayed latest set', () => {
  const rows = Array.from({length: 200}, (_, i) => token('token_' + i, i));
  const result = projectLegacyTokens(registry(rows), {tokenId: 'token_0'});
  assert.equal(result.data[0].token_id, 'token_0'); assert.equal(result.total, 200);
  assert.equal(result.truncated, false); assert.equal(result.coverage, 'exact_token');
  assert.deepEqual(projectLegacyTokens(registry(rows), {tokenId: 'missing'}).data, []);
});
test('unsafe supply integers remain exact and escaped strings are untouched', () => {
  const text = '{"success":true,"data":[{"token_id":"exact","name":"A \\"12345678901234567890\\"","decimals":9,"max_supply":18446744073709551615,"current_supply":200307010815068434,"created_slot":12}]}';
  const result = projectLegacyTokens(text).data[0];
  assert.equal(result.current_supply, '200307010815068434');
  assert.equal(result.max_supply, '18446744073709551615');
  assert.equal(result.name, 'A "12345678901234567890"');
});
test('large legacy registry is projected to a bounded response', () => {
  const rows = Array.from({length: 64_084}, (_, i) => ({...token('token_' + i, i), unused_metadata: 'x'.repeat(80)}));
  const text = registry(rows);
  assert.ok(text.length > 4 * 1024 * 1024 && text.length < LEGACY_REGISTRY_MAX_BYTES);
  const result = projectLegacyTokens(text);
  assert.equal(result.data.length, 100); assert.equal(result.data[0].token_id, 'token_64083');
  assert.ok(JSON.stringify(result).length < 100_000);
});
test('malformed, ambiguous, unbounded or unsuccessful registries are rejected', () => {
  for (const text of ['[01]', '{"success":false,"data":[]}', registry([token('same'), token('same')]),
    registry([{...token('bad'), decimals: 19}]),
    registry([{...token('bad'), current_supply: '-1'}]), registry([{...token('bad'), max_supply: '18446744073709551616'}])]) assert.throws(() => projectLegacyTokens(text));
  assert.throws(() => projectLegacyTokens(' '.repeat(LEGACY_REGISTRY_MAX_BYTES + 1)));
  assert.throws(() => projectLegacyTokens(registry([]), {tokenId: '../other'}));
  assert.throws(() => projectLegacyTokens(registry([]), {limit: 101}));
});
test('unrouteable historical IDs are explicitly counted, not silently represented as complete', () => {
  const result = projectLegacyTokens(registry([token('valid'), token('with spaces'), token(''), token('bad/id')]));
  assert.equal(result.total, 4); assert.equal(result.omitted_count, 3);
  assert.equal(result.truncated, true); assert.deepEqual(result.data.map(row => row.token_id), ['valid']);
});
