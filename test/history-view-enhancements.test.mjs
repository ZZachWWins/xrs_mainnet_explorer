import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {adjacentArchivedSlots,formatHistoryTimestamp,formatRawXrs,instructionAmount,instructionLabel,relativeHistoryAge,shortIdentifier} from '../src/history-views.mjs';
import {searchDestination} from '../src/navigation.mjs';
import {transactionStatus} from '../src/view-loaders.mjs';

test('history presentation preserves exact identifiers, timestamps and native u64 amounts',()=>{
  assert.equal(shortIdentifier('a'.repeat(40)),'aaaaaaaaaaaa…aaaaaaaaaa');
  assert.equal(formatRawXrs('18446744073709551615'),'18,446,744,073.709551615 XRS');
  assert.equal(formatRawXrs('1'),'0.000000001 XRS');
  assert.equal(formatRawXrs('not-an-integer'),null);
  assert.equal(formatRawXrs('18446744073709551616'),null);
  assert.equal(formatRawXrs('9'.repeat(100_000)),null);
  assert.equal(formatRawXrs('01'),null);
  assert.equal(formatHistoryTimestamp(1_800_000_000_000),'2027-01-15T08:00:00.000Z');
  assert.equal(relativeHistoryAge(1_799_999_880_000,1_800_000_000_000),'2m ago');
});

test('adjacent archive navigation never links into declared coverage gaps',()=>{
  const coverage={indexed_from:1,tip:{slot:20},gaps:[{from:9,to:11}]};
  assert.deepEqual(adjacentArchivedSlots(8,coverage),{previous:7,next:null,previousState:'available',nextState:'unavailable'});
  assert.deepEqual(adjacentArchivedSlots(12,coverage),{previous:null,next:13,previousState:'unavailable',nextState:'available'});
  assert.deepEqual(adjacentArchivedSlots(20,coverage),{previous:19,next:null,previousState:'available',nextState:'boundary'});
  assert.deepEqual(adjacentArchivedSlots(1,coverage),{previous:null,next:2,previousState:'boundary',nextState:'available'});
});

test('history instruction summaries never denominate unknown token precision as native XRS',()=>{
  assert.equal(instructionLabel({type:'native_transfer'}),'Native transfer');
  assert.equal(instructionAmount({type:'native_transfer',amount_raw:'1000000000'}),'1 XRS');
  assert.equal(instructionAmount({type:'token_transfer',amount_raw:'1000000000'}),'1000000000 raw units');
  assert.equal(instructionAmount({type:'unparsed_instruction'}),'—');
});

test('pool search opens the existing read-only contract detail and included transactions remain outcome-neutral',()=>{
  assert.equal(searchDestination('xrs-xusdc-mainnet-v1','pool'),'/contract/xrs-xusdc-mainnet-v1');
  assert.deepEqual(transactionStatus('included'),{label:'Included',color:'text-text-dim'});
});

test('built explorer carries compact mobile network, navigation and history table protections',async()=>{
  const css=await readFile(new URL('../dist/explorer.css',import.meta.url),'utf8');
  const history=await readFile(new URL('../dist/history-views.mjs',import.meta.url),'utf8');
  assert.match(css,/@media\(max-width:480px\)[\s\S]*\.network-bar\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/@media\(max-width:900px\)[\s\S]*\.explorer-navigation\.is-open\{display:grid/);
  assert.match(css,/\.history-table-wrap:focus-visible/);
  assert.match(css,/\.history-table td\[data-label\]::before\{content:attr\(data-label\)/);
  assert.match(css,/\.accounts-copy\{min-height:44px/);
  assert.match(css,/\.history-copy svg,\.accounts-copy svg\{/);
  assert.match(history,/viewBox:'0 0 24 24'/);
  assert.doesNotMatch(history,/aria-live':'polite'\},text\)/);
});
