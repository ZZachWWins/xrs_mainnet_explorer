import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAccountView, enrichTransactionTimes, loadTransactionsView, dashboardLoader} from '../src/view-loaders.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

test('account balance renders while slow history remains pending', async () => {
  const history = deferred(), seen = [];
  const cancel = loadAccountView({account: async address => ({address,balance:'0'}),accountTransactions: () => history.promise}, 'owner', 1,
    {account: value => seen.push(value),accountError: assert.fail,history() {},historyError() {}});
  await tick(); assert.deepEqual(seen, [{address:'owner',balance:'0'}]); cancel(); history.resolve({data:[]});
});
test('history failure cannot replace a real balance with zero', async () => {
  const seen = [], errors = [];
  loadAccountView({account: async address => ({address,balance:'200307010815068434'}), accountTransactions: async () => {throw Error('offline');}}, 'owner', 1,
    {account:value=>seen.push(value),accountError:assert.fail,history:assert.fail,historyError:e=>errors.push(e.message)});
  await tick(); assert.equal(seen[0].balance,'200307010815068434'); assert.deepEqual(errors,['offline']);
});
test('account transport failure emits an error without fabricated account data', async () => {
  const values = [], errors = [];
  loadAccountView({account: async () => {throw Error('offline');},accountTransactions:async()=>({data:[]})}, 'owner', 1,
    {account:v=>values.push(v),accountError:e=>errors.push(e.message),history() {},historyError:assert.fail});
  await tick(); assert.deepEqual(values,[]); assert.deepEqual(errors,['offline']);
});
test('responses arriving after navigation cannot update the next account', async () => {
  const a=deferred(),h=deferred(),seen=[];
  const cancel=loadAccountView({account:()=>a.promise,accountTransactions:()=>h.promise},'old',1,
    {account:v=>seen.push(v),history:v=>seen.push(v),accountError:assert.fail,historyError:assert.fail});
  cancel();a.resolve({address:'old',balance:'99'});h.resolve({data:[]});await tick();assert.deepEqual(seen,[]);
});
test('timestamp enrichment makes at most three sequential optional reads', async () => {
  let inflight=0,maximum=0;const calls=[];
  const rows=Array.from({length:20},(_,i)=>({signature:String(i),block_slot:i}));
  const result=await enrichTransactionTimes({block:async(slot,options)=>{calls.push([slot,options]);maximum=Math.max(maximum,++inflight);await tick();inflight--;return {slot,poh_timestamp:1234567890000};}},rows);
  assert.equal(maximum,1);assert.equal(calls.length,3);assert.deepEqual(calls[0][1],{optional:true});
  assert.equal(result[0].timestamp,1234567890000);assert.equal(result[19].timestamp,undefined);
});
test('an obsolete transaction page cannot replace the current page', async () => {
  const pending=deferred(),seen=[];
  const cancel=loadTransactionsView({transactions:()=>pending.promise},1,{rows:r=>seen.push(r),error:assert.fail});
  cancel();pending.resolve({data:[]});await tick();assert.deepEqual(seen,[]);
});
test('dashboard refreshes do not overlap or erase other sections on a partial failure', async () => {
  const blocks=deferred();let count=0;const seen=[];
  const loader=dashboardLoader({blocks:()=>{count++;return blocks.promise},stats:async()=>{throw Error('offline')},transactions:async()=>({data:[]})},
    {blocks:r=>seen.push(r),blocksError:assert.fail,stats:assert.fail,statsError:e=>seen.push(e.message),transactions:r=>seen.push(r),transactionsError:assert.fail});
  const one=loader.refresh();await loader.refresh();assert.equal(count,1);blocks.resolve([{slot:1}]);await one;
  assert.ok(seen.includes('offline'));assert.ok(seen.some(v=>Array.isArray(v)&&v[0]?.slot===1));loader.dispose();
});
