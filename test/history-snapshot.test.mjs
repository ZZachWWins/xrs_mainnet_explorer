import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHistoryBlobAdapter} from '../services/history-index/blobs.mjs';
import {createHistorySnapshotFunction} from '../netlify/functions/history-snapshot.mjs';

const chain='xeris-mainnet-v4',generation='a'.repeat(64),hash='b'.repeat(64);
const prefix=`chains/${chain}/`,base='/.netlify/functions/history-snapshot';
const address='1'.repeat(32);
const signature=(()=>{let value=BigInt('0x'+'07'.repeat(64)),text='';const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(value){text=alphabet[Number(value%58n)]+text;value/=58n;}return text;})();
const bytes=value=>Buffer.from(JSON.stringify(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
const stream=value=>new ReadableStream({start(controller){controller.enqueue(value);controller.close();}});
function fixture({published=true}={}){
  const tip={slot:1,hash};
  const coverage={chain_id:chain,indexed_from:1,tip,counts:{blocks:1,transactions:1},gaps:[],list_page_size:100,block_shard_size:1000};
  const block={slot:1,hash,transactions:[signature],transaction_count:1,proposer:address};
  const tx={slot:1,signature,signer:address,amount_raw:'18446744073709551615',wire_base64:'AA==',instructions:[]};
  const page=data=>({data,cursor:null,snapshot_tip:tip});
  const files=new Map([
    ['blocks/0.json',bytes({'1':block})],['hashes/bb.json',bytes({[hash]:1})],
    [`transactions/${signature}.json`,bytes(tx)],['lists/blocks/1.json',bytes(page([block]))],
    ['lists/transactions/1.json',bytes(page([tx]))],[`addresses/${address}/1.json`,bytes(page([tx]))]
  ]);
  const manifest={schema_version:1,chain_id:chain,generation,indexed_from:1,tip,coverage,
    files:[...files].map(([path,data])=>({path,bytes:data.length,sha256:digest(data)}))};
  const manifestBytes=bytes(manifest),entries=new Map(),calls=[];
  for(const [path,data] of files)entries.set(prefix+`generations/${generation}/`+path,data);
  entries.set(prefix+`generations/${generation}/manifest.json`,manifestBytes);
  if(published)entries.set(prefix+'current.json',bytes({schema_version:1,chain_id:chain,generation,manifest_sha256:digest(manifestBytes),indexed_from:1,tip}));
  const store={
    async get(key,options){calls.push({operation:'get',key,options});return entries.has(key)?stream(entries.get(key)):null;},
    async getWithMetadata(key,options){calls.push({operation:'getWithMetadata',key,options});return entries.has(key)?{data:stream(entries.get(key)),etag:'fixture-etag'}:null;},
    async set(){throw Error('Read-only snapshot must never write');}
  };
  const adapter=createHistoryBlobAdapter({chainId:chain,store});
  return {handle:createHistorySnapshotFunction({adapter}),calls,entries,coverage};
}
async function request(handle,path,options){
  const response=await handle(new Request('https://explorer.example'+path,options));
  return {status:response.status,headers:response.headers,body:await response.json()};
}
test('snapshot coverage proves the actual activated CURRENT pointer through the real adapter',async()=>{
  const {handle,calls,coverage}=fixture();assert.deepEqual(calls,[]);
  const result=await request(handle,base+'/coverage');
  assert.equal(result.status,200);assert.equal(result.body.generation,generation);assert.deepEqual(result.body.coverage,coverage);assert.deepEqual(result.body.data,coverage);
  assert.deepEqual(calls.map(call=>call.key),[prefix+'current.json',prefix+`generations/${generation}/manifest.json`]);
  assert.ok(calls.every(call=>call.options.consistency==='strong'));
  assert.equal(result.headers.get('x-xeris-network'),'mainnet');assert.equal(result.headers.get('x-xeris-chain-id'),chain);assert.equal(result.headers.get('cache-control'),'no-store');
  await request(handle,base+'/coverage');assert.equal(calls.filter(call=>call.key.endsWith('/current.json')).length,2);
});
test('standard snapshot block, hash, transaction, address, list and search routes remain readable',async()=>{
  const {handle}=fixture();
  for(const path of ['/block/1','/block/'+hash,'/transaction/'+signature,'/address/'+address,'/blocks','/transactions','/search?q='+signature]){
    const result=await request(handle,base+path);assert.equal(result.status,200,path);assert.equal(result.body.generation,generation);
  }
  const tx=await request(handle,base+'/transaction/'+signature);assert.equal(tx.body.data.amount_raw,'18446744073709551615');
});
test('snapshot POST and request-selected network, source or store reject before storage access',async()=>{
  const {handle,calls}=fixture();
  const post=await request(handle,base+'/coverage',{method:'POST'});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');
  for(const query of ['network=testnet','store=other','upstream=https://example.com','token=fixture'])assert.equal((await request(handle,base+'/coverage?'+query)).status,400);
  for(const path of ['/api/history/coverage','/api/history-snapshot/coverage'])assert.equal((await request(handle,path)).status,404);assert.deepEqual(calls,[]);
});
test('unpublished snapshot stays503 even though generation files exist',async()=>{
  const {handle,calls}=fixture({published:false});const result=await request(handle,base+'/coverage');
  assert.equal(result.status,503);assert.equal(result.body.generation,null);assert.equal(result.body.coverage,null);assert.equal(result.headers.get('x-xeris-network'),'mainnet');
  assert.deepEqual(calls.map(call=>call.key),[prefix+'current.json']);
});
test('tampered snapshot files and wrong-chain activation fail closed',async()=>{
  const corrupted=fixture();corrupted.entries.set(prefix+`generations/${generation}/blocks/0.json`,bytes({'1':{slot:999,hash}}));
  assert.equal((await request(corrupted.handle,base+'/block/1')).status,503);
  const wrong=fixture(),pointer=JSON.parse(wrong.entries.get(prefix+'current.json'));
  wrong.entries.set(prefix+'current.json',bytes({...pointer,chain_id:'xeris-testnet-v2'}));
  const result=await request(wrong.handle,base+'/coverage');assert.equal(result.status,503);assert.equal(result.body.coverage,null);assert.equal(wrong.calls.length,1);
});
