import {parsePublicJSON} from './network.mjs';
const CHAIN = 'xeris-mainnet-v4', HASH = /^[a-f0-9]{64}$/;
// The direct Function route remains usable when a site's SPA rewrite shadows /api.
const HISTORY_BASE='/.netlify/functions/history';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const retryAfterMilliseconds=(value,clock)=>{if(typeof value!=='string'||value.length>128)return 0;
  const delay=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-clock;
  return Number.isFinite(delay)?Math.min(86_400_000,Math.max(0,Math.ceil(delay))):0};
export class HistoryError extends Error {
  constructor(code, message, {coverage = null, generation = null, retryAfterMs = 0, status = null} = {}) {
    super(message);this.code=code;this.coverage=coverage;this.generation=generation;this.retryAfterMs=retryAfterMs;this.status=status;
  }
}
export function validateCoverage(body) {
  const c=body?.coverage;
  if (!body || typeof body.generation!=='string' || !HASH.test(body.generation) || !c || c.chain_id!==CHAIN
    || !integer(c.indexed_from) || c.indexed_from<1 || !integer(c.tip?.slot) || c.tip.slot<c.indexed_from || !HASH.test(c.tip?.hash)
    || !integer(c.counts?.blocks) || c.counts.blocks<1 || !integer(c.counts?.transactions)
    || c.list_page_size!==100 || c.block_shard_size!==1000 || !Array.isArray(c.gaps)) throw new HistoryError('INVALID_ARCHIVE','Historical archive identity or coverage is invalid.');
  if (c.block_shard_size!==1000 || c.gaps.some(g=>!integer(g.from)||!integer(g.to)||g.from<1||g.to<g.from||g.to>c.tip.slot)) throw new HistoryError('INVALID_ARCHIVE','Historical archive coverage is invalid.');
  if(c.source!==undefined&&(!['cloud','blobs'].includes(c.source)||c.source==='blobs'&&c.stale!==true)
    ||c.stale!==undefined&&typeof c.stale!=='boolean'
    ||c.snapshot_age_ms!=null&&!integer(c.snapshot_age_ms)
    ||c.snapshot_tip_timestamp_ms!=null&&!integer(c.snapshot_tip_timestamp_ms))throw new HistoryError('INVALID_ARCHIVE','Historical archive provenance is invalid.');
  return c;
}
function validateRecord(kind,row,coverage) {
  if(!row||typeof row!=='object'||!integer(row.slot)||row.slot<coverage.indexed_from||row.slot>coverage.tip.slot)throw new HistoryError('INVALID_ARCHIVE','Historical record is outside its declared coverage.');
  if(kind==='block'){
    if(typeof row.hash!=='string'||!HASH.test(row.hash)||!integer(row.transaction_count)||!Array.isArray(row.transactions)||row.transactions.length!==row.transaction_count||row.transactions.some(v=>typeof v!=='string')||typeof row.proposer!=='string')throw new HistoryError('INVALID_ARCHIVE','Historical block is malformed.');
  }else if(typeof row.signature!=='string'||typeof row.signer!=='string'||!Array.isArray(row.instructions)||row.instructions.some(v=>!v||typeof v!=='object'||!integer(v.index))||typeof row.wire_base64!=='string')throw new HistoryError('INVALID_ARCHIVE','Historical transaction is malformed.');
  return row;
}
export function createHistoryClient(network,{fetchImpl=fetch,timeoutMs=10_000,cacheStorage,now=Date.now}={}) {
  if (!['mainnet','testnet'].includes(network)) throw new Error('Unknown network');
  if(cacheStorage===undefined){try{cacheStorage=globalThis.localStorage}catch{cacheStorage=null}}
  const retryNotBefore=new Map(),retryFailures=new Map();
  const cacheKey=path=>'xeris:explorer:history:v1:'+encodeURIComponent(path);
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
  const cached=path=>{try{
    if(!cacheStorage?.getItem)return null;const raw=cacheStorage.getItem(cacheKey(path));if(raw===null)return null;
    if(typeof raw!=='string'||raw.length>1_048_576)throw Error('invalid cache');const envelope=parsePublicJSON(raw);
    if(!exact(envelope,['version','path','observedAtMs','value'])||envelope.version!==1||envelope.path!==path||!integer(envelope.observedAtMs)||
      envelope.observedAtMs<1||envelope.observedAtMs>now()+2000||!envelope.value||typeof envelope.value!=='object'||Array.isArray(envelope.value))throw Error('invalid cache');
    validateCoverage(envelope.value);return envelope;
  }catch{try{cacheStorage?.removeItem?.(cacheKey(path))}catch{}return null}};
  const remember=(path,value)=>{try{if(!cacheStorage?.setItem)return;const encoded=JSON.stringify({version:1,path,observedAtMs:now(),value});
    if(encoded.length<=1_048_576)cacheStorage.setItem(cacheKey(path),encoded)}catch{}};
  const retained=path=>{const stored=cached(path);if(!stored)return null;const age=Math.max(0,now()-stored.observedAtMs);
    return{...stored.value,coverage:{...stored.value.coverage,stale:true,snapshot_age_ms:age}}};
  async function read(path) {
    if(network!=='mainnet') throw new HistoryError('DISABLED','Historical archive is available on Mainnet. Testnet remains selected.');
    if(!/^\/(coverage|blocks|transactions|block\/[^/?]+|transaction\/[^/?]+|address\/[^/?]+)(\?cursor=[A-Za-z0-9_-]+)?$/.test(path)&&!/^\/search\?q=[A-Za-z0-9_-]{1,128}$/.test(path)) throw new HistoryError('INVALID_REQUEST','Unsupported history request.');
    const notBefore=retryNotBefore.get(path)||0;
    if(notBefore>now()){
      const fallback=retained(path);if(fallback)return fallback;
      throw retryFailures.get(path)||new HistoryError('UNAVAILABLE','Historical archive is temporarily unavailable.',{retryAfterMs:notBefore-now()});
    }
    if(notBefore){retryNotBefore.delete(path);retryFailures.delete(path)}
    const controller=new AbortController();let timer,reader;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new HistoryError('UNAVAILABLE','Historical archive request timed out.'));},timeoutMs);});
    try {
      const response=await Promise.race([fetchImpl(HISTORY_BASE+path,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal}),deadline]);
      if(response.headers.get('x-xeris-network')!=='mainnet'||response.headers.get('x-xeris-chain-id')!==CHAIN) throw new HistoryError('INVALID_ARCHIVE','Historical archive network binding failed.');
      if(!response.body||Number(response.headers.get('content-length')||0)>4_194_304) throw new HistoryError('INVALID_ARCHIVE','Historical archive response is invalid.');
      reader=response.body.getReader();const chunks=[];let size=0;
      while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>4_194_304)throw new HistoryError('INVALID_ARCHIVE','Historical archive response is too large.');chunks.push(value);}
      const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
      const body=parsePublicJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(!response.ok){
        if(response.status===404&&body.coverage){validateCoverage(body);throw new HistoryError('NOT_INDEXED','No matching record in this archive generation.',body);}
        const retryAfterMs=response.status===429||response.status===503?retryAfterMilliseconds(response.headers.get('retry-after'),now()):0;
        throw new HistoryError(response.status===410?'EXPIRED':'UNAVAILABLE',response.status===410?'This archive page expired. Start again from the latest snapshot.':'Historical archive is not published or is temporarily unavailable.',{retryAfterMs,status:response.status});
      }
      validateCoverage(body);retryNotBefore.delete(path);retryFailures.delete(path);remember(path,body);return body;
    }catch(error){if(reader)void reader.cancel().catch(()=>{});const failure=error instanceof HistoryError?error:new HistoryError('UNAVAILABLE','Historical archive is not published or is temporarily unavailable.');
      if(failure.code==='UNAVAILABLE'&&failure.retryAfterMs>0){retryNotBefore.set(path,now()+failure.retryAfterMs);retryFailures.set(path,failure)}
      const fallback=failure.code==='UNAVAILABLE'?retained(path):null;if(fallback)return fallback;throw failure;}
    finally{clearTimeout(timer);}
  }
  const id=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new HistoryError('INVALID_REQUEST','Invalid history identifier.');return value;};
  return Object.freeze({network,
    readiness:async()=>{if(network!=='mainnet')return{ready:false,reason:'disabled'};try{const value=await read('/coverage');return{ready:true,...value};}catch(error){return{ready:false,reason:error.code,error};}},
    page:async(kind,cursor=null,address=null)=>{
      if(!['blocks','transactions','address'].includes(kind)||cursor!==null&&(typeof cursor!=='string'||cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor)))throw new HistoryError('INVALID_REQUEST','Invalid history page.');
      const value=await read('/'+(kind==='address'?'address/'+id(address):kind)+(cursor?'?cursor='+cursor:''));
      if(!Array.isArray(value.data)||value.data.length>100||value.cursor!==null&&(typeof value.cursor!=='string'||value.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(value.cursor)))throw new HistoryError('INVALID_ARCHIVE','Historical archive page is invalid.');
      if(!integer(value.snapshot_tip?.slot)||value.snapshot_tip.slot<value.coverage.indexed_from||value.snapshot_tip.slot>value.coverage.tip.slot||!HASH.test(value.snapshot_tip.hash)||value.data.some(row=>row?.slot>value.snapshot_tip.slot))throw new HistoryError('INVALID_ARCHIVE','Historical page snapshot is invalid.');
      value.data.forEach(row=>validateRecord(kind==='blocks'?'block':'transaction',row,value.coverage));
      return value;
    },
    search:async(identifier)=>{
      const query=id(String(identifier)),value=await read('/search?q='+query);
      if(value.type==='address'){
        const row=value.data;
        if(!row||row.address!==query||!Array.isArray(row.transactions)||row.transactions.length>100||row.cursor!==null&&(typeof row.cursor!=='string'||row.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(row.cursor)))throw new HistoryError('INVALID_ARCHIVE','Historical address search is invalid.');
        if(!integer(row.snapshot_tip?.slot)||row.snapshot_tip.slot<value.coverage.indexed_from||row.snapshot_tip.slot>value.coverage.tip.slot||!HASH.test(row.snapshot_tip.hash)||row.transactions.some(tx=>tx?.slot>row.snapshot_tip.slot))throw new HistoryError('INVALID_ARCHIVE','Historical address snapshot is invalid.');
        row.transactions.forEach(tx=>validateRecord('transaction',tx,value.coverage));
      }else{
        if(!['block','transaction'].includes(value.type))throw new HistoryError('INVALID_ARCHIVE','Historical search type is invalid.');
        const row=validateRecord(value.type,value.data,value.coverage);
        if(value.type==='transaction'?row.signature!==query:HASH.test(query)?row.hash!==query:row.slot!==Number(query))throw new HistoryError('INVALID_ARCHIVE','Historical search does not match this query.');
      }
      return value;
    },
    record:async(kind,identifier)=>{
      if(!['block','transaction'].includes(kind))throw new HistoryError('INVALID_REQUEST','Invalid record type.');
      const value=await read('/'+kind+'/'+id(String(identifier)));const row=validateRecord(kind,value.data,value.coverage);
      if(!row||typeof row!=='object'||(kind==='transaction'?row.signature!==identifier:/^[a-f0-9]{64}$/.test(String(identifier))?row.hash!==identifier:row.slot!==Number(identifier)))throw new HistoryError('INVALID_ARCHIVE','Historical archive record does not match this link.');
      return value;
    }
  });
}
