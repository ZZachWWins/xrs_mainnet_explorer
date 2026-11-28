import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createExplorerAPI} from '../src/explorer-api.mjs';
import {NETWORKS, rawUnits} from '../src/network.mjs';
import {loadPoolsView, transactionStatus} from '../src/view-loaders.mjs';
const reply = (data, network = 'mainnet') => new Response(JSON.stringify({success:true,data}), {headers:{'x-xeris-network':network,
  ...(network === 'mainnet' ? {'x-xeris-chain-id':NETWORKS.mainnet.chainId} : {})}});
const make = handler => createExplorerAPI('mainnet', {fetchImpl:async url => url.endsWith('/identity/checkpoint')
  ? reply({slot:27201,hash:NETWORKS.mainnet.checkpointHash}) : handler(url)});
const tick = () => new Promise(resolve=>setTimeout(resolve,0));

test('detail records must match the requested block, signature and account', async () => {
  const api = make(async url => reply(url.includes('/block/') ? {slot:5} : url.includes('/tx/') ? {signature:'other'} : {address:'other'}));
  await assert.rejects(api.block(6), e=>e.code==='RECORD_MISMATCH');
  await assert.rejects(api.transaction('wanted'), e=>e.code==='RECORD_MISMATCH');
  await assert.rejects(api.account('wanted'), e=>e.code==='RECORD_MISMATCH');
  assert.equal((await api.block('5')).slot,5);
});
test('a wrong network header after startup stops subsequent reads', async () => {
  let calls=0;
  const api=make(async()=>{calls++;return reply([], 'testnet');});
  await api.ready();
  await assert.rejects(api.validators(),e=>e.code==='NETWORK_MISMATCH');
  await assert.rejects(api.tokens(),e=>e.code==='NETWORK_MISMATCH');
  assert.equal(calls,1);
});
test('in-flight records and optional supply cannot bypass a newly latched network failure', async () => {
  let resolveValidators;
  const api=make(async url=>url.endsWith('/validators')?new Promise(resolve=>{resolveValidators=resolve;}):reply([], 'testnet'));
  await api.ready();
  const pending=api.validators();
  const rejected=assert.rejects(pending,e=>e.code==='NETWORK_MISMATCH');
  await tick();
  await assert.rejects(api.tokens(),e=>e.code==='NETWORK_MISMATCH');
  resolveValidators(reply([{address:'old-record'}]));
  await rejected;
  const supplyMismatch=make(async url=>url.endsWith('/v2/stats')?reply({current_slot:35000,validator_count:3}):reply({},'testnet'));
  await assert.rejects(supplyMismatch.stats(),e=>e.code==='NETWORK_MISMATCH');
});
test('registry pages cannot silently exceed the requested bound or use malformed cursors', async () => {
  await assert.rejects(make(async()=>reply(Array.from({length:101},(_,i)=>({token_id:String(i)})))).tokens(),/oversized/);
  const api=make(async()=>new Response(JSON.stringify({data:[],next_after:'x/y'}),{headers:{'x-xeris-network':'mainnet'}}));
  await assert.rejects(api.tokens(),/Incomplete/);
});
test('pool records survive optional metadata failure without guessed decimals', async () => {
  const emitted=[];
  loadPoolsView({pools:async()=>[{pool_id:'real-pool'}],tokens:async()=>{throw Error('unavailable');}},
    {pools:rows=>emitted.push(rows[0].pool_id),error:()=>emitted.push('error'),decimals:value=>emitted.push(Object.keys(value))});
  await tick(); assert.deepEqual(emitted,['real-pool',[]]);
});
test('pool failure is separate from an empty result and disposed responses cannot commit', async () => {
  const emitted=[];
  loadPoolsView({pools:async()=>{throw Error('unavailable');},tokens:async()=>[]},
    {pools:()=>emitted.push('empty'),error:()=>emitted.push('error'),decimals:()=>{}});
  await tick(); assert.deepEqual(emitted,['error']);
  const dispose=loadPoolsView({pools:async()=>[],tokens:async()=>[]},{pools:()=>emitted.push('late'),error:()=>{},decimals:()=>emitted.push('late')});
  dispose(); await tick(); assert.deepEqual(emitted,['error']);
});
test('reported partial/failed/unknown outcomes cannot appear as a green success',()=>{
  assert.equal(transactionStatus('confirmed').color,'text-green-400');
  assert.equal(transactionStatus('partial').label,'Partial');
  assert.equal(transactionStatus('failed').color,'text-red-400');
  for(const value of [undefined,null,'', 'unrecognized']) assert.equal(transactionStatus(value).color,'text-text-dim');
});
test('built pool formatter preserves zero-decimal and raw balances without unsafe-number rounding',()=>{
  const source=readFileSync(new URL('../dist/assets/explorer-ui.js',import.meta.url),'utf8');
  const formatter=source.slice(source.indexOf('function Sc('),source.indexOf('function pv('));
  const scope={window:{XerisExplorerFormat:rawUnits}};vm.runInNewContext(formatter,scope);
  assert.equal(scope.Sc('123456789',0),'123,456,789');
  assert.equal(scope.Sc('18446744073709551615',9),'18,446,744,073.709551615');
  assert.equal(scope.Sc('1000000',undefined),'1,000,000 raw units');
  assert.equal(scope.Sc(Number.MAX_SAFE_INTEGER+1,0),'—');
  assert.equal(rawUnits('18446744073709551616'),'—');
});
test('built explorer presents the scoped security audit status on every route',()=>{
  const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../dist/explorer.css',import.meta.url),'utf8');
  assert.match(html,/SECURITY AUDITED/);
  assert.match(html,/Built on the CertiK-audited Xeris L1 core\./);
  assert.match(html,/class="network-audit" aria-label="Security audit status"/);
  assert.match(css,/\.network-audit\{/);
});
