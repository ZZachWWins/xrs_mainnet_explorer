import {createHistoryBlobAdapter} from '../../services/history-index/blobs.mjs';
import {createHistoryApiHandler} from '../../services/history-index/read-api.mjs';
import {parsePublicJSON} from '../../src/network.mjs';
import {validateCoverage} from '../../src/history-client.mjs';

const CHAIN='xeris-mainnet-v4', CLOUD='https://mainnetrpc.xerisweb.com/history';
const MAX_BYTES=4_194_304, ID=/^[A-Za-z0-9_-]{1,128}$/, BASE58=/^[1-9A-HJ-NP-Za-km-z]+$/;
const HASH=/^[a-f0-9]{64}$/, CURSOR=/^[A-Za-z0-9_-]{1,1024}$/;
class RequestError extends Error {constructor(status,message){super(message);this.status=status;}}
class BindingError extends Error {}
const need=(ok,message)=>{if(!ok)throw new RequestError(400,message);};
function base58Size(id,expected){
  if(!BASE58.test(id)||id.length<expected||id.length>Math.ceil(expected*1.366))return false;
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let value=0n;
  for(const char of id)value=value*58n+BigInt(alphabet.indexOf(char));
  return id.match(/^1*/)[0].length+(value===0n?0:Math.ceil(value.toString(16).length/2))===expected;
}
const address=id=>base58Size(id,32),signature=id=>base58Size(id,64);
const slot=id=>/^[1-9][0-9]{0,15}$/.test(id)&&Number.isSafeInteger(Number(id));
function route(request){
  if(request.method!=='GET')throw new RequestError(405,'Only GET is supported.');
  need(typeof request.url==='string'&&request.url.length<=4096&&!request.url.includes('\\'),'Invalid URL.');
  const url=new URL(request.url);
  if(url.pathname.startsWith('/.netlify/functions/history/'))url.pathname='/api/history/'+url.pathname.slice('/.netlify/functions/history/'.length);
  const match=/^\/api\/history\/(coverage|blocks|transactions|search|block|transaction|address)(?:\/([^/]+))?$/.exec(url.pathname);
  if(!match)throw new RequestError(404,'Unknown history endpoint.');
  const [,kind,id]=match;
  need((id!==undefined)===['block','transaction','address'].includes(kind),'Invalid identifier.');
  if(id){need(ID.test(id),'Invalid identifier.');need(kind==='block'?(slot(id)||HASH.test(id)):kind==='transaction'?signature(id):address(id),'Invalid identifier.');}
  const allowed=kind==='search'?['q']:['blocks','transactions','address'].includes(kind)?['cursor']:[];
  for(const key of url.searchParams.keys())need(allowed.includes(key)&&url.searchParams.getAll(key).length===1,'Unknown or repeated query parameter.');
  if(kind==='search'){
    const q=url.searchParams.get('q');need(typeof q==='string'&&ID.test(q)&&(HASH.test(q)||slot(q)||signature(q)||address(q)),'Unsupported search identifier.');
  }
  let continuation=null;
  if(url.searchParams.has('cursor')){
    const encoded=url.searchParams.get('cursor');need(CURSOR.test(encoded),'Invalid cursor.');
    try{
      const bytes=Buffer.from(encoded,'base64url');need(bytes.toString('base64url')===encoded,'Noncanonical cursor.');
      continuation=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      need(continuation&&Object.keys(continuation).sort().join(',')==='cursor,key,source,v'&&continuation.v===1&&['cloud','blobs'].includes(continuation.source)&&continuation.key===kind+':'+(id||'')&&typeof continuation.cursor==='string'&&continuation.cursor.length<=640&&CURSOR.test(continuation.cursor),'Mismatched cursor.');
    }catch(error){if(error instanceof RequestError)throw error;throw new RequestError(400,'Invalid cursor.');}
    url.searchParams.set('cursor',continuation.cursor);
  }
  return {url,kind,id,continuation};
}
function wrappedCursor(cursor,source,key){
  if(cursor===null||cursor===undefined)return cursor;
  if(typeof cursor!=='string'||cursor.length>640||!CURSOR.test(cursor))throw new Error('Invalid upstream cursor');
  const encoded=Buffer.from(JSON.stringify({v:1,source,key,cursor})).toString('base64url');
  if(encoded.length>1024)throw new Error('Oversized wrapped cursor');return encoded;
}
function stamp(body,source,selected,now,tipTimestamp=null){
  if(body?.coverage?.chain_id&&body.coverage.chain_id!==CHAIN)throw new BindingError('History body network mismatch');
  if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid clock');
  validateCoverage(body);
  body.coverage={...body.coverage,source,
    snapshot_tip_timestamp_ms:tipTimestamp,
    snapshot_age_ms:tipTimestamp===null?null:Math.max(0,now-tipTimestamp)};
  if(source==='blobs')body.coverage.stale=true;
  if(selected.kind==='coverage')body.data=body.coverage;
  if(Object.hasOwn(body,'cursor'))body.cursor=wrappedCursor(body.cursor,source,selected.kind+':'+(selected.id||''));
  if(selected.kind==='search'&&body.type==='address'){
    if(!body.data||body.data.address!==selected.url.searchParams.get('q'))throw new Error('Address result mismatch');
    body.data.cursor=wrappedCursor(body.data.cursor,source,'address:'+body.data.address);
  }
  return body;
}
function response(status,body,extra={}){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-xeris-network':'mainnet','x-xeris-chain-id':CHAIN,...extra}});
}
async function readBody(result,signal=null){
  if(!result.body||Number(result.headers.get('content-length')||0)>MAX_BYTES)throw new Error('Invalid response size');
  const reader=result.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw new Error('Response too large');chunks.push(value);}
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    return parsePublicJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch(error){cancel();throw error;}
  finally{signal?.removeEventListener('abort',cancel);}
}
async function deadline(operation,ms,abort=()=>{}){
  let timer;
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>{abort();reject(new Error('History request timed out'));},ms);})]);}
  finally{clearTimeout(timer);}
}

// Fixed public sources only. Requests cannot select an upstream, network, token or store.
export function createHistoryFunction({adapter=createHistoryBlobAdapter({chainId:CHAIN}),fetchImpl=fetch,clock=Date.now,cloudTimeoutMs=3500,fallbackTimeoutMs=4500}={}){
  const snapshot=createHistoryApiHandler({adapter,basePath:'/api/history'});
  async function cloud(selected){
    const controller=new AbortController();
    return deadline(async()=>{
      const path=selected.url.pathname.slice('/api/history'.length)+selected.url.search;
      const result=await fetchImpl(CLOUD+path,{method:'GET',headers:{accept:'application/json','cache-control':'no-cache'},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      const network=result.headers.get('x-xeris-network'),chain=result.headers.get('x-xeris-chain-id');
      if(network&&network!=='mainnet'||chain&&chain!==CHAIN){if(result.body)void result.body.cancel().catch(()=>{});throw new BindingError('Cloud history network mismatch');}
      if(!['application/json','application/json; charset=utf-8'].includes((result.headers.get('content-type')||'').toLowerCase())||network!=='mainnet'||chain!==CHAIN||![200,404,410].includes(result.status)){
        if(result.body)void result.body.cancel().catch(()=>{});throw new Error('Cloud history unavailable');
      }
      const body=await readBody(result,controller.signal);
      if(result.status===410)return response(410,{generation:null,coverage:null,error:{code:'expired',message:'Restart history pagination.'}});
      return response(result.status,stamp(body,'cloud',selected,clock()));
    },cloudTimeoutMs,()=>controller.abort());
  }
  async function blobs(selected){
    return deadline(async()=>{
      const result=await snapshot(new Request(selected.url));const body=await readBody(result);
      if(body.coverage){
        let timestamp=null;
        // Tip time is read from the same integrity-checked immutable generation.
        const slot=body.coverage.tip.slot;
        const shard=await adapter.readJSON(`blocks/${Math.floor(slot/1000)}.json`,{generation:body.generation});
        const value=shard?.data?.[String(slot)]?.poh_timestamp;
        if(Number.isSafeInteger(value)&&value>0&&value<=clock())timestamp=value;
        stamp(body,'blobs',selected,clock(),timestamp);
      }
      return response(result.status,body);
    },fallbackTimeoutMs);
  }
  return async request=>{
    try{
      const selected=route(request);
      if(selected.continuation?.source==='blobs')return await blobs(selected);
      try{return await cloud(selected);}
      catch(error){
        // A continuation never changes data source. Explicit wrong-chain evidence
        // also fails closed, rather than being hidden behind a snapshot.
        if(error instanceof BindingError||selected.continuation)throw error;
        return await blobs(selected);
      }
    }catch(error){
      const status=error instanceof RequestError?error.status:503;
      return response(status,{generation:null,coverage:null,error:{code:status===503?'archive_unavailable':'invalid_request',message:status===503?'Historical archive is temporarily unavailable.':error.message}},status===405?{allow:'GET'}:{});
    }
  };
}
export default createHistoryFunction();
