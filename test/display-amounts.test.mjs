import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {rawUnits} from '../src/network.mjs';

// Exercise the financial formatters in the actual built view bundle.
const bundle = readFileSync(new URL('../dist/assets/explorer-ui.js', import.meta.url), 'utf8');
const start = bundle.indexOf('function XerisNativeAmount(');
const match = bundle.slice(start).match(/^function XerisNativeAmount\([\s\S]*?function hs\([\s\S]*?\}/);
assert.ok(start >= 0 && match, 'build the repaired UI before testing');
const scope = {window: {XerisExplorerFormat: rawUnits}};
vm.runInNewContext(match[0], scope);

test('built native amount display preserves exact raw integers above Number precision', () => {
  assert.equal(scope.hs({tx_type:'native_transfer',amount:'200100270457689476'}), '200,100,270.457689476 XRS');
  assert.equal(scope.hs({tx_type:'received:legacy_transfer',amount:'1'}), '0.000000001 XRS');
  assert.equal(scope.hs({tx_type:'sent:stake',amount:'1000000000000'}), '1,000 XRS');
});

test('built display never denominates token or other instruction quantities as native XRS', () => {
  for (const tx_type of ['token_transfer', 'received:token_transfer', 'oracle_update', 'contract_call', '', undefined]) {
    assert.equal(scope.hs({tx_type,amount:'1000000000',amount_xrs:1}), 'See details');
  }
});

test('built native display rejects malformed, unsafe, missing and over-u64 amounts', () => {
  for (const amount of [undefined,null,'',-1,Number.MAX_SAFE_INTEGER+1,'1.2','-1','1e9','18446744073709551616']) {
    assert.equal(scope.hs({tx_type:'native_transfer',amount,amount_xrs:123}), 'Unavailable');
  }
  assert.equal(scope.XerisNativeAmount('0'), '0 XRS');
  assert.equal(scope.XerisNativeAmount(undefined), null);
});
