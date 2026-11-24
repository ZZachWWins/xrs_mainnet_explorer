import {transactionStatus} from './view-loaders.mjs';

const MAX_CACHED_PAGES=20;

export function loadHistoryRoute(client, {kind, id, cursor}, emit) {
  let active=true;
  Promise.resolve().then(()=>client.readiness()).then(async gate=>{
    if(!active)return;
    if(!gate.ready){emit({status:'unavailable',gate});return;}
    try {
      const response=await (['block','transaction'].includes(kind)?client.record(kind,id):client.page(kind,cursor,kind==='address'?id:null));
      if(active)emit({status:'ready',response});
    }catch(error){if(active)emit({status:'error',error});}
  }).catch(error=>{if(active)emit({status:'error',error});});
  return()=>{active=false;};
}

export function createHistoryViews(React,Link,useLocation,client) {
  const h=React.createElement;
  const titles={blocks:'Block history',transactions:'Transaction history',block:'Archived block',transaction:'Archived transaction',address:'Address history'};
  const short=value=>typeof value==='string'&&value.length>24?value.slice(0,12)+'…'+value.slice(-10):String(value??'Unavailable');
  const link=(to,text)=>h(Link,{to},text);
  const timestamp=value=>typeof value==='number'&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():'Unavailable';
  const age=value=>value==null?'Age unavailable':value<60_000?'Less than a minute old':value<3_600_000?`${Math.floor(value/60_000)} minutes old`:value<86_400_000?`${Math.floor(value/3_600_000)} hours old`:`${Math.floor(value/86_400_000)} days old`;
  const coverage=value=>value?h('aside',{className:'history-coverage'},
    h('strong',null,`Indexed blocks ${value.indexed_from.toLocaleString()}–${value.tip.slot.toLocaleString()}`),
    h('span',null,`${value.counts.blocks.toLocaleString()} blocks · ${value.counts.transactions.toLocaleString()} transactions · ${value.gaps.length} reported gaps`),
    h('p',null,value.source==='cloud'?'Source: cloud archive.':value.source==='blobs'?`Source: verified stored snapshot. ${age(value.snapshot_age_ms)}.`:'This is a captured Mainnet archive.'),
    value.stale&&h('p',{role:'status'},'Archive updates are delayed. Newer activity may not yet appear.'),
    value.gaps.length>0&&h('details',null,h('summary',null,'Coverage gaps'),h('pre',null,JSON.stringify(value.gaps,null,2)))):null;
  const details=(label,value)=>h('div',{className:'history-detail'},h('dt',null,label),h('dd',null,value));
  function transactionTable(rows) {
    return h('div',{className:'history-table-wrap'},h('table',{className:'history-table'},
      h('thead',null,h('tr',null,...['Transaction','Block','Instruction','Outcome'].map(v=>h('th',{key:v,scope:'col'},v)))),
      h('tbody',null,...rows.map(tx=>h('tr',{key:tx.signature},
        h('td',{title:tx.signature},link('/tx/'+tx.signature,short(tx.signature))),
        h('td',null,link('/block/'+tx.slot,tx.slot.toLocaleString())),
        h('td',null,tx.instructions?.map(ix=>ix.decoded?.type||'Unparsed').join(', ')||'Unavailable'),
        h('td',null,transactionStatus(tx.status).label))))));
  }
  function blockTable(rows) {
    return h('div',{className:'history-table-wrap'},h('table',{className:'history-table'},
      h('thead',null,h('tr',null,...['Block','Hash','Transactions','Time (UTC)'].map(v=>h('th',{key:v,scope:'col'},v)))),
      h('tbody',null,...rows.map(b=>h('tr',{key:b.hash},h('td',null,link('/block/'+b.slot,b.slot.toLocaleString())),
        h('td',{title:b.hash},link('/history/block/'+b.hash,short(b.hash))),h('td',null,String(b.transaction_count)),h('td',null,timestamp(b.poh_timestamp)))))));
  }
  function record(kind,value) {
    if(kind==='block')return h('section',null,h('dl',{className:'history-details'},
      details('Slot',String(value.slot)),details('Hash',value.hash),details('Previous hash',value.previous_hash?link('/history/block/'+value.previous_hash,value.previous_hash):'First produced block'),
      details('Proposer',link('/history/address/'+value.proposer,value.proposer)),details('Time (UTC)',timestamp(value.poh_timestamp)),details('Transactions',String(value.transaction_count))),
      value.transactions.length?h('ul',null,...value.transactions.map(sig=>h('li',{key:sig},link('/tx/'+sig,sig)))):h('p',null,'No transactions in this block.'));
    return h('section',null,h('dl',{className:'history-details'},details('Signature',value.signature),details('Block',link('/block/'+value.slot,String(value.slot))),
      details('Outcome',transactionStatus(value.status).label),details('Signer',link('/history/address/'+value.signer,value.signer))),
      h('h2',null,'Instructions'),...value.instructions.map(ix=>h('article',{className:'history-instruction',key:ix.index},h('h3',null,`${ix.index+1}. ${ix.decoded?.type||'Unparsed instruction'}`),
        h('pre',null,JSON.stringify(ix.decoded,null,2)))),
      h('details',null,h('summary',null,'Signed transaction data'),h('pre',null,value.wire_base64)));
  }
  return function HistoryRoute({kind='blocks',Fallback=null}) {
    const location=useLocation(), key=kind+':'+location.pathname;
    const id=location.pathname.split('/').filter(Boolean).at(-1);
    const live=Fallback&&new URLSearchParams(location.search).get('source')==='live';
    const [pages,setPages]=React.useState({key,stack:[null]}),[stored,setState]=React.useState({status:'loading'});
    const cache=React.useRef(new Map());
    const stack=pages.key===key?pages.stack:[null],cursor=stack.at(-1),cacheKey=key+':'+(cursor||'first');
    const state=stored.key===cacheKey?stored:{status:'loading'};
    React.useEffect(()=>{
      if(client.network!=='mainnet'||live)return;
      if(cache.current.has(cacheKey)){
        const cached=cache.current.get(cacheKey);
        cache.current.delete(cacheKey);cache.current.set(cacheKey,cached);
        setState(cached);return;
      }
      setState({status:'loading',key:cacheKey});
      return loadHistoryRoute(client,{kind,id,cursor},value=>{
        const tagged={...value,key:cacheKey};
        if(value.status==='ready'){
          cache.current.set(cacheKey,tagged);
          while(cache.current.size>MAX_CACHED_PAGES)cache.current.delete(cache.current.keys().next().value);
        }
        setState(tagged);
      });
    },[key,cursor,live]);
    if(client.network!=='mainnet')return Fallback?h(Fallback):h('main',{className:'history-view'},h('h1',null,'Historical archive'),h('p',null,'Testnet is selected. Choose Mainnet to view its historical archive.'));
    if(live)return h(Fallback);
    const response=state.response, isList=['blocks','transactions','address'].includes(kind);
    const livePath=kind==='transaction'?'/tx/'+id:kind==='block'&&/^\d+$/.test(id)?'/block/'+id:kind==='address'?'/account/'+id:null;
    if(state.status==='unavailable'&&Fallback)return h(React.Fragment,null,
      h('aside',{className:'history-fallback',role:'status'},'The historical archive is not published or is unavailable. Showing the live endpoint’s recent data.'),h(Fallback));
    return h('main',{className:'history-view','aria-busy':state.status==='loading'},
      h('p',{className:'history-eyebrow'},'Mainnet archive'),h('h1',null,titles[kind]),
      h('nav',{'aria-label':'Historical views',className:'history-tabs'},link('/history/blocks','Blocks'),link('/history/transactions','Transactions'),livePath&&link(livePath+'?source=live','Live record')),
      kind==='address'&&h('p',{className:'history-identifier'},id),
      coverage(response?.coverage||state.error?.coverage),
      isList&&response?.snapshot_tip&&h('p',null,`These pages use the archive snapshot through block ${response.snapshot_tip.slot.toLocaleString()}.`),
      state.status==='loading'?h('div',{className:'view-loading',role:'status','aria-live':'polite'},
        h('span',{className:'loading-circle','aria-hidden':'true'}),h('span',null,`Loading ${titles[kind].toLowerCase()}… Checking archive coverage.`)):
      state.status==='unavailable'?h('section',{role:'status'},h('h2',null,'Historical archive unavailable'),h('p',null,'The archive has not been published or cannot be reached. Recent explorer views remain available.'),link('/','Open live overview')):
      state.status==='error'?h('section',{role:'status'},h('h2',null,state.error.code==='NOT_INDEXED'?'Record not in this archive':'Archive data unavailable'),h('p',null,state.error.message),h('button',{type:'button',onClick:()=>{cache.current.clear();setPages({key,stack:[null]});locationReload();}},'Retry archive')):
      isList?h(React.Fragment,null,response.data.length?(kind==='blocks'?blockTable(response.data):transactionTable(response.data)):h('p',null,'No matching transactions in this archive generation.'),
        h('div',{className:'history-pagination'},h('button',{type:'button',disabled:stack.length===1,onClick:()=>setPages({key,stack:stack.slice(0,-1)})},'Previous'),h('span',null,`Page ${stack.length}`),
          h('button',{type:'button',disabled:!response.cursor,onClick:()=>setPages({key,stack:[...stack,response.cursor]})},'Next'))):record(kind,response.data));
  };
}
function locationReload(){globalThis.location?.reload();}
