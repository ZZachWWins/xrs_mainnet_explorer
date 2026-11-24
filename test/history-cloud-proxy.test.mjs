import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryFunction} from '../netlify/functions/history.mjs';
import {createHistoryClient} from '../src/history-client.mjs';

const generation='a'.repeat(64),chain='xeris-mainnet-v4',now=1_800_000_000_000;
const address='11111111111111111111111111111111',signature='1'.repeat(64);
const tip={slot:101,hash:'b'.repeat(64)};
const coverage={chain_id:chain,indexed_from:1,tip,counts:{blocks:101,transactions:1},gaps:[],block_shard_size:1000,list_page_size:100,stale:false};
const block={slot:101,hash:tip.hash,proposer:address,transaction_count:0,transactions:[],poh_timestamp:now-3_600_000};
const tx={slot:101,signature,signer:address,instructions:[{index:0,decoded:{amount_raw:'18446744073709551615'}}],wire_base64:'AA=='};
const payload=data=>({generation,coverage:structuredClone(coverage),data});
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-xeris-network':'mainnet','x-xeris-chain-id':chain,...headers}});
const offline=async()=>{throw Error('offline fixture');};
function fixture(){
  const page=(data,cursor=null)=>({data,cursor,snapshot_tip:tip});
  const files=new Map([
    ['blocks/0.json',{'101':block}],['hashes/bb.json',{[tip.hash]:101}],
    ['lists/blocks/1.json',page([block],'next')],['lists/blocks/2.json',page([block])],
    ['lists/transactions/1.json',page([tx])],[`transactions/${signature}.json`,tx],
    [`addresses/${address}/1.json`,page([tx],'next')],[`addresses/${address}/2.json`,page([tx])]
  ]);
  const manifest={generation,coverage,indexed_from:1,tip,files:[...files.keys()].map(path=>({path}))};
  const calls=[];
  const adapter={
    async readCurrent(){calls.push(['current']);return {manifest};},
    async readGeneration(id){calls.push(['generation',id]);assert.equal(id,generation);return manifest;},
    async readJSON(path,{generation:id}){calls.push(['json',path,id]);assert.equal(id,generation);if(!files.has(path))throw Error('missing');return {generation:id,data:structuredClone(files.get(path))};}
  };
  return {adapter,calls,files};
}
async function request(handle,path,init){const response=await handle(new Request('https://explorer.example'+path,init));return {status:response.status,headers:response.headers,body:await response.json()};}
const handler=(fetchImpl,options={})=>{const store=fixture();return {...store,handle:createHistoryFunction({adapter:store.adapter,fetchImpl,clock:()=>now,...options})};};

test('cloud primary is fixed, anonymous, read-only and supports direct Function path',async()=>{
  let call;const {handle,calls}=handler(async(url,options)=>{call={url,options};return response(payload(coverage));});
  const result=await request(handle,'/.netlify/functions/history/coverage',{headers:{authorization:'must-not-forward',cookie:'must-not-forward'}});
  assert.equal(result.status,200);assert.equal(call.url,'https://mainnetrpc.xerisweb.com/history/coverage');
  assert.deepEqual(call.options.headers,{accept:'application/json','cache-control':'no-cache'});assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.method,'GET');
  assert.equal(result.body.coverage.source,'cloud');assert.equal(result.body.coverage.stale,false);assert.equal(result.headers.get('cache-control'),'no-store');assert.deepEqual(calls,[]);
});
test('invalid requests fail before any source reads',async()=>{
  let reads=0;const {handle,calls}=handler(async()=>{reads++;throw Error('unexpected');});
  for(const path of ['/api/history/coverage?network=testnet','/api/history/search?q=1&q=2','/api/history/blocks?limit=20','/api/history/block/0','/api/history/block/9007199254740992','/api/history/address/'+'1'.repeat(44),'/api/history/transaction/'+'1'.repeat(63),'/api/history/search?q=https://example.com','/api/history/blocks?cursor=bad']){
    assert.equal((await request(handle,path)).status,400,path);
  }
  const post=await request(handle,'/api/history/coverage',{method:'POST'});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');assert.equal(reads,0);assert.deepEqual(calls,[]);
});
test('cloud not-indexed and expired outcomes never silently switch to Blobs',async()=>{
  const {handle,calls}=handler(async url=>url.includes('transaction')?response({...payload(null),error:{code:'not_indexed'}},404):response({error:{code:'expired'}},410));
  const missing=await request(handle,'/api/history/transaction/'+signature);assert.equal(missing.status,404);assert.equal(missing.body.coverage.source,'cloud');
  assert.equal((await request(handle,'/api/history/blocks')).status,410);assert.deepEqual(calls,[]);
});
test('offline or HTML cloud falls back to a labelled same-generation stored snapshot',async()=>{
  for(const fetchImpl of [offline,async()=>new Response('<html>SPA</html>',{headers:{'content-type':'text/html'}})]){
    const {handle,calls}=handler(fetchImpl);const result=await request(handle,'/api/history/coverage');
    assert.equal(result.status,200);assert.equal(result.body.coverage.source,'blobs');assert.equal(result.body.coverage.stale,true);assert.equal(result.body.coverage.snapshot_age_ms,3_600_000);assert.deepEqual(result.body.data,result.body.coverage);
    assert.ok(calls.some(v=>v[0]==='json'&&v[1]==='blocks/0.json'&&v[2]===generation));
  }
});
test('explicit wrong-chain evidence fails closed without concealing it with a snapshot',async()=>{
  for(const fetchImpl of [async()=>response(payload(coverage),200,{'x-xeris-network':'testnet'}),async()=>response({...payload(coverage),coverage:{...coverage,chain_id:'wrong'}})]){
    const {handle,calls}=handler(fetchImpl);assert.equal((await request(handle,'/api/history/coverage')).status,503);assert.deepEqual(calls,[]);
  }
});
test('cloud continuation remains on cloud and forwards only the inner cursor',async()=>{
  let healthy=true;const urls=[];const {handle,calls}=handler(async url=>{urls.push(url);if(!healthy)throw Error('down');return response({...payload([block]),cursor:'cloud_inner'});});
  const first=await request(handle,'/api/history/blocks');const cursor=first.body.cursor;
  assert.notEqual(cursor,'cloud_inner');assert.equal(JSON.parse(Buffer.from(cursor,'base64url')).source,'cloud');
  assert.equal((await request(handle,'/api/history/blocks?cursor='+cursor)).status,200);assert.ok(urls.at(-1).endsWith('?cursor=cloud_inner'));
  healthy=false;assert.equal((await request(handle,'/api/history/blocks?cursor='+cursor)).status,503);assert.deepEqual(calls,[]);
  const before=urls.length;assert.equal((await request(handle,'/api/history/transactions?cursor='+cursor)).status,400);assert.equal(urls.length,before);
});
test('Blobs continuation stays on its stored generation after cloud recovers',async()=>{
  let healthy=false,reads=0;const {handle,calls}=handler(async()=>{reads++;if(!healthy)throw Error('down');return response(payload([]));});
  const first=await request(handle,'/api/history/blocks');healthy=true;
  const next=await request(handle,'/api/history/blocks?cursor='+first.body.cursor);
  assert.equal(next.status,200);assert.equal(next.body.coverage.source,'blobs');assert.equal(next.body.cursor,null);assert.equal(reads,1);assert.ok(calls.some(v=>v[0]==='generation'&&v[1]===generation));
});
test('search address cursor continues on matching address only',async()=>{
  const {handle}=handler(offline);const first=await request(handle,'/api/history/search?q='+address);
  assert.equal(first.status,200);assert.equal(first.body.type,'address');assert.equal(first.body.data.transactions[0].signature,signature);
  const cursor=first.body.data.cursor;assert.equal((await request(handle,'/api/history/address/'+address+'?cursor='+cursor)).status,200);
  assert.equal((await request(handle,'/api/history/transactions?cursor='+cursor)).status,400);
});
test('timeouts and oversized bodies are bounded and can use the verified snapshot',async()=>{
  for(const fetchImpl of [async()=>new Promise(()=>{}),async()=>response({},200,{'content-length':'4194305'}),async()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json','x-xeris-network':'mainnet','x-xeris-chain-id':chain}})]){
    const {handle}=handler(fetchImpl,{cloudTimeoutMs:10});const result=await request(handle,'/api/history/coverage');assert.equal(result.status,200);assert.equal(result.body.coverage.source,'blobs');
  }
});
test('cloud body deadline cancels an unfinished stream even if fetch ignores abort',async()=>{
  let cancelled=false;
  const fetchImpl=async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}}),{headers:{'content-type':'application/json','x-xeris-network':'mainnet','x-xeris-chain-id':chain}});
  const {handle}=handler(fetchImpl,{cloudTimeoutMs:10});const result=await request(handle,'/api/history/coverage');assert.equal(result.status,200);assert.equal(result.body.coverage.source,'blobs');assert.equal(cancelled,true);
});
test('unavailable or stalled fallback stays unavailable and does not leak internal errors',async()=>{
  const adapter={readCurrent:async()=>null,readGeneration:async()=>null,readJSON:async()=>null};
  const handle=createHistoryFunction({adapter,fetchImpl:offline});assert.equal((await request(handle,'/api/history/coverage')).status,503);
  adapter.readCurrent=async()=>new Promise(()=>{});
  const stalled=createHistoryFunction({adapter,fetchImpl:offline,fallbackTimeoutMs:10});const result=await request(stalled,'/api/history/coverage');assert.equal(result.status,503);assert.equal(result.body.coverage,null);
});
test('browser client uses direct Function, validates search and never contacts Mainnet in Testnet',async()=>{
  const {handle}=handler(async url=>{
    const q=new URL(url).searchParams.get('q');
    return response({...payload(q===signature?tx:q===address?{address,transactions:[tx],cursor:null,snapshot_tip:tip}:block),type:q===signature?'transaction':q===address?'address':'block'});
  });
  const paths=[];const fetchImpl=async(path,options)=>{paths.push(path);return handle(new Request('https://explorer.example'+path,options));};
  const client=createHistoryClient('mainnet',{fetchImpl});
  assert.equal((await client.search('101')).data.slot,101);assert.equal((await client.search(signature)).data.instructions[0].decoded.amount_raw,'18446744073709551615');assert.equal((await client.search(address)).data.address,address);
  assert.ok(paths.every(path=>path.startsWith('/.netlify/functions/history/search?q=')));
  const testnet=createHistoryClient('testnet',{fetchImpl});const count=paths.length;await assert.rejects(testnet.search('101'),e=>e.code==='DISABLED');assert.equal(paths.length,count);
  const mismatch=createHistoryClient('mainnet',{fetchImpl:async()=>response({...payload(block),type:'block'})});await assert.rejects(mismatch.search('100'),e=>e.code==='INVALID_ARCHIVE');
});
test('browser pagination validates its original snapshot when current coverage advances',async()=>{
  const later={...coverage,tip:{slot:102,hash:'c'.repeat(64)},counts:{blocks:102,transactions:1}};
  const body={generation,coverage:later,data:[block],snapshot_tip:tip,cursor:null};
  const client=createHistoryClient('mainnet',{fetchImpl:async()=>response(body)});
  const page=await client.page('blocks');assert.equal(page.coverage.tip.slot,102);assert.equal(page.snapshot_tip.slot,101);
  for(const snapshot_tip of [undefined,{slot:103,hash:tip.hash},{slot:100,hash:tip.hash},{slot:101,hash:'invalid'}]){
    const invalid=createHistoryClient('mainnet',{fetchImpl:async()=>response({...body,snapshot_tip})});await assert.rejects(invalid.page('blocks'),e=>e.code==='INVALID_ARCHIVE');
  }
});
