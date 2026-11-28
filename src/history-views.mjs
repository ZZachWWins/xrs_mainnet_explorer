import {transactionStatus} from './view-loaders.mjs';

const MAX_CACHED_PAGES=20;
const XRS_DECIMALS=9;
const U64_MAX=18_446_744_073_709_551_615n;

export function shortIdentifier(value, leading=12, trailing=10) {
  const text=String(value??'—');
  return text.length>leading+trailing+3?text.slice(0,leading)+'…'+text.slice(-trailing):text;
}

export function formatHistoryTimestamp(value) {
  return typeof value==='number'&&Number.isFinite(value)&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():'—';
}

export function relativeHistoryAge(value, now=Date.now()) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>now+60_000)return'—';
  const elapsed=Math.max(0,now-value);
  if(elapsed<60_000)return'Less than a minute ago';
  if(elapsed<3_600_000)return`${Math.floor(elapsed/60_000)}m ago`;
  if(elapsed<86_400_000)return`${Math.floor(elapsed/3_600_000)}h ago`;
  return`${Math.floor(elapsed/86_400_000)}d ago`;
}

export function formatRawXrs(value) {
  if(typeof value!=='string'||!/^(?:0|[1-9]\d{0,19})$/.test(value))return null;
  const raw=BigInt(value);
  if(raw>U64_MAX)return null;
  const base=10n**BigInt(XRS_DECIMALS),whole=raw/base,fraction=String(raw%base).padStart(XRS_DECIMALS,'0').replace(/0+$/,'');
  return`${whole.toLocaleString('en-US')}${fraction?'.'+fraction:''} XRS`;
}

export function adjacentArchivedSlots(slot,coverage) {
  if(!Number.isSafeInteger(slot)||!Number.isSafeInteger(coverage?.indexed_from)||!Number.isSafeInteger(coverage?.tip?.slot))return{previous:null,next:null,previousState:'unavailable',nextState:'unavailable'};
  const missing=candidate=>Array.isArray(coverage.gaps)&&coverage.gaps.some(gap=>Number.isSafeInteger(gap?.from)&&Number.isSafeInteger(gap?.to)&&candidate>=gap.from&&candidate<=gap.to);
  const previous=slot>coverage.indexed_from&&!missing(slot-1)?slot-1:null,next=slot<coverage.tip.slot&&!missing(slot+1)?slot+1:null;
  return{previous,next,previousState:previous!==null?'available':slot===coverage.indexed_from?'boundary':'unavailable',
    nextState:next!==null?'available':slot===coverage.tip.slot?'boundary':'unavailable'};
}

export function instructionLabel(decoded) {
  const labels={native_transfer:'Native transfer',token_transfer:'Token transfer',token_mint:'Token mint',token_burn:'Token burn',
    wrap_xrs:'Wrap XRS',unwrap_xrs:'Unwrap XRS',contract_call:'Contract call',contract_deploy:'Contract deployment',
    stake:'Stake',unstake:'Unstake',attestation:'Attestation',pq_transfer:'Post-quantum transfer',zk_private_transfer:'Private transfer'};
  return labels[decoded?.type]||'Unparsed instruction';
}

export function instructionAmount(decoded) {
  if(!decoded||typeof decoded.amount_raw!=='string')return'—';
  return['native_transfer','wrap_xrs','unwrap_xrs','stake','unstake'].includes(decoded.type)?formatRawXrs(decoded.amount_raw)||'—':`${decoded.amount_raw} raw units`;
}

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
  const titles={blocks:'Verified block history',transactions:'Verified transaction history',block:'Block details',transaction:'Transaction details',address:'Address activity'};
  const loadingTitles={...titles,address:'Address history'};
  const link=(to,text,props={})=>h(Link,{to,...props},text);
  const duration=value=>value==null?'—':value<60_000?'Less than a minute old':value<3_600_000?`${Math.floor(value/60_000)} minutes old`:value<86_400_000?`${Math.floor(value/3_600_000)} hours old`:`${Math.floor(value/86_400_000)} days old`;
  const numeric=value=>Number.isSafeInteger(value)?value.toLocaleString():'—';

  function CopyButton({value,label='Copy'}) {
    const [state,setState]=React.useState('idle');
    async function copy() {
      try {
        if(!globalThis.navigator?.clipboard?.writeText)throw Error('Clipboard unavailable');
        await globalThis.navigator.clipboard.writeText(String(value));
        setState('copied');globalThis.setTimeout(()=>setState('idle'),1800);
      }catch{setState('error');globalThis.setTimeout(()=>setState('idle'),2200);}
    }
    const text=state==='copied'?'Copied':state==='error'?'Try again':label;
    return h('button',{type:'button',className:`history-copy${state==='copied'?' is-copied':''}`,onClick:copy,
      'aria-label':`${label} ${shortIdentifier(value)}`,'aria-live':'polite'},text);
  }

  function Identifier({value,to=null,compact=false,label='Copy'}) {
    const shown=compact?shortIdentifier(value):String(value??'—');
    const content=to?link(to,shown,{title:String(value)}):h('code',{title:String(value)},shown);
    return h('span',{className:`history-identifier-row${compact?' is-compact':''}`},content,h(CopyButton,{value,label}));
  }

  function Time({value,relative=true}) {
    const exact=formatHistoryTimestamp(value);
    if(exact==='—')return'—';
    return h('time',{dateTime:exact,title:exact},relative?relativeHistoryAge(value):exact);
  }

  function Coverage({value}) {
    if(!value)return null;
    return h('section',{className:'history-coverage','aria-label':'Archive coverage'},
      h('div',{className:'history-coverage-heading'},h('div',null,h('p',{className:'history-panel-kicker'},'VERIFIED ARCHIVE COVERAGE'),
        h('h2',null,`Blocks ${numeric(value.indexed_from)}–${numeric(value.tip?.slot)}`)),
        h('span',{className:`history-status${value.stale?' is-delayed':' is-confirmed'}`},value.stale?'Updating':'Snapshot verified')),
      h('p',{className:'sr-only'},`Indexed blocks ${numeric(value.indexed_from)}–${numeric(value.tip?.slot)}`),
      h('p',{className:'sr-only'},`${numeric(value.counts?.transactions)} transactions`),
      h('dl',{className:'history-metrics'},
        h('div',null,h('dt',null,'Indexed blocks'),h('dd',null,numeric(value.counts?.blocks))),
        h('div',null,h('dt',null,'Transactions'),h('dd',null,numeric(value.counts?.transactions))),
        h('div',null,h('dt',null,'History range'),h('dd',null,`From block ${numeric(value.indexed_from)}`)),
        h('div',null,h('dt',null,'Reported gaps'),h('dd',null,numeric(value.gaps?.length)))),
      h('p',{className:'history-provenance'},value.source==='cloud'?'Source: current cloud archive.':value.source==='blobs'?`Source: verified stored snapshot. ${duration(value.snapshot_age_ms)}.`:'Source: captured Mainnet archive.'),
      value.stale&&h('p',{className:'history-delay',role:'status'},'The records below remain visible while newer activity is added.'),
      value.gaps.length>0&&h('details',{className:'history-gaps'},h('summary',null,'Review coverage gaps'),h('pre',null,JSON.stringify(value.gaps,null,2))));
  }

  const details=(label,value)=>h('div',{className:'history-detail'},h('dt',null,label),h('dd',null,value));
  const statusTone=status=>['confirmed','success'].includes(status)?' is-positive':['failed'].includes(status)?' is-negative':['partial','pending','queued'].includes(status)?' is-pending':' is-neutral';
  const statusBadge=status=>{const value=transactionStatus(status);return h('span',{className:'history-outcome'+statusTone(status),title:value.label},value.label);};
  const firstDecoded=tx=>tx?.instructions?.find(ix=>ix?.decoded)?.decoded||null;
  const transactionType=tx=>{
    const labels=(tx?.instructions||[]).map(ix=>instructionLabel(ix?.decoded));
    return labels.length>1?`${labels[0]} +${labels.length-1}`:labels[0]||'Recorded transaction';
  };
  const transactionAmount=tx=>{
    const effects=Array.isArray(tx?.effects)?tx.effects:[];
    if(effects.length===1&&typeof effects[0].amount_raw==='string')return ['native_transfer','stake','unstake'].includes(effects[0].tx_type)?formatRawXrs(effects[0].amount_raw)||'—':`${effects[0].amount_raw} raw units`;
    if(effects.length>1)return'Multiple effects';
    return instructionAmount(firstDecoded(tx));
  };

  function transactionTable(rows,{address=null}={}) {
    return h('div',{className:'history-table-wrap',tabIndex:0,role:'region','aria-label':'Verified transactions table'},h('table',{className:'history-table history-transaction-table'},
      h('caption',{className:'sr-only'},address?'Verified transactions involving this address':'Verified archived transactions'),
      h('thead',null,h('tr',null,...['Transaction','Block','Type','Signer','Amount','Outcome'].map(v=>h('th',{key:v,scope:'col'},v)))),
      h('tbody',null,...rows.map(tx=>h('tr',{key:tx.signature},
        h('td',{'data-label':'Transaction'},h(Identifier,{value:tx.signature,to:'/tx/'+tx.signature,compact:true,label:'Copy transaction signature'})),
        h('td',{'data-label':'Block'},link('/block/'+tx.slot,numeric(tx.slot))),
        h('td',{'data-label':'Type'},transactionType(tx)),
        h('td',{'data-label':'Signer'},tx.signer?h(Identifier,{value:tx.signer,to:'/history/address/'+tx.signer,compact:true,label:'Copy signer address'}):'—'),
        h('td',{'data-label':'Amount',className:'history-number'},transactionAmount(tx)),
        h('td',{'data-label':'Outcome'},statusBadge(tx.status)))))));
  }

  function blockTable(rows) {
    return h('div',{className:'history-table-wrap',tabIndex:0,role:'region','aria-label':'Verified blocks table'},h('table',{className:'history-table history-block-table'},
      h('caption',{className:'sr-only'},'Verified archived blocks'),
      h('thead',null,h('tr',null,...['Block','Hash','Proposer','Transactions','Age'].map(v=>h('th',{key:v,scope:'col'},v)))),
      h('tbody',null,...rows.map(block=>h('tr',{key:block.hash},
        h('td',{'data-label':'Block'},link('/block/'+block.slot,numeric(block.slot))),
        h('td',{'data-label':'Hash'},h(Identifier,{value:block.hash,to:'/history/block/'+block.hash,compact:true,label:'Copy block hash'})),
        h('td',{'data-label':'Proposer'},block.proposer?h(Identifier,{value:block.proposer,to:'/history/address/'+block.proposer,compact:true,label:'Copy proposer address'}):'—'),
        h('td',{'data-label':'Transactions',className:'history-number'},numeric(block.transaction_count)),
        h('td',{'data-label':'Age'},h(Time,{value:block.poh_timestamp})))))));
  }

  function AdjacentBlocks({value,coverage}) {
    const {previous,next,previousState,nextState}=adjacentArchivedSlots(value.slot,coverage);
    return h('nav',{className:'history-adjacent','aria-label':'Adjacent archived blocks'},
      previous?link('/history/block/'+previous,`← Block ${numeric(previous)}`):h('span',null,previousState==='boundary'?'Start of retained history':'No previous archived block'),
      next?link('/history/block/'+next,`Block ${numeric(next)} →`):h('span',null,nextState==='boundary'?'Latest archived block':'No next archived block'));
  }

  function Instruction({instruction}) {
    const decoded=instruction?.decoded||{},facts=[];
    if(decoded.token_id)facts.push(['Token',link('/token/'+decoded.token_id,decoded.token_id)]);
    if(decoded.contract_id)facts.push(['Contract',link('/contract/'+decoded.contract_id,decoded.contract_id)]);
    if(decoded.method)facts.push(['Method',decoded.method]);
    for(const label of ['from','to'])if(decoded[label])facts.push([label==='from'?'From':'To',h(Identifier,{value:decoded[label],to:'/history/address/'+decoded[label],compact:true,label:`Copy ${label} address`})]);
    if(decoded.amount_raw)facts.push(['Amount',instructionAmount(decoded)]);
    return h('article',{className:'history-instruction'},
      h('div',{className:'history-instruction-heading'},h('div',null,h('span',null,`Instruction ${instruction.index+1}`),h('h3',null,instructionLabel(decoded))),
        instruction.program_id&&h(Identifier,{value:instruction.program_id,to:'/history/address/'+instruction.program_id,compact:true,label:'Copy program address'})),
      facts.length?h('dl',{className:'history-facts'},...facts.map(([label,value])=>details(label,value))):null,
      h('details',null,h('summary',null,'Decoded fields'),h('pre',null,JSON.stringify(decoded,null,2))));
  }

  function Effects({value}) {
    const effects=Array.isArray(value.effects)?value.effects:[];
    if(!effects.length)return h('p',{className:'history-empty-inline'},'No independently verified receipt effects are available for this record. Instruction data remains visible below.');
    return h('div',{className:'history-table-wrap',tabIndex:0,role:'region','aria-label':'Verified transaction effects'},h('table',{className:'history-table history-effects-table'},
      h('caption',{className:'sr-only'},'Verified transaction receipt effects'),h('thead',null,h('tr',null,...['Type','From','To','Amount','Validation'].map(v=>h('th',{key:v,scope:'col'},v)))),
      h('tbody',null,...effects.map((effect,index)=>h('tr',{key:effect.receipt_id||index},h('td',{'data-label':'Type'},effect.tx_type||'—'),
        h('td',{'data-label':'From'},effect.from?h(Identifier,{value:effect.from,to:'/history/address/'+effect.from,compact:true,label:'Copy sender address'}):'—'),
        h('td',{'data-label':'To'},effect.to?h(Identifier,{value:effect.to,to:'/history/address/'+effect.to,compact:true,label:'Copy recipient address'}):'—'),
        h('td',{'data-label':'Amount',className:'history-number'},typeof effect.amount_raw==='string'?`${effect.amount_raw} raw units`:'—'),
        h('td',{'data-label':'Validation'},effect.validation==='wire_fields_match'?'Verified':'Not reported'))))));
  }

  function RecordActions({value,livePath}) {
    return h('div',{className:'history-record-actions'},livePath&&link(livePath+'?source=live','Open live node view',{className:'history-secondary-action'}),
      h(CopyButton,{value:JSON.stringify(value,null,2),label:'Copy raw record'}));
  }

  function record(kind,value,coverage,livePath) {
    if(kind==='block')return h(React.Fragment,null,
      h(AdjacentBlocks,{value,coverage}),
      h('section',{className:'history-record-section'},h('div',{className:'history-section-heading'},h('div',null,h('p',{className:'history-panel-kicker'},'BLOCK SUMMARY'),h('h2',null,`Block ${numeric(value.slot)}`)),h(RecordActions,{value,livePath})),
        h('dl',{className:'history-details'},details('Block hash',h(Identifier,{value:value.hash,label:'Copy block hash'})),
          details('Previous hash',value.previous_hash?h(Identifier,{value:value.previous_hash,to:'/history/block/'+value.previous_hash,label:'Copy previous block hash'}):'First produced block'),
          details('Proposer',h(Identifier,{value:value.proposer,to:'/history/address/'+value.proposer,label:'Copy proposer address'})),
          details('Produced',h(Time,{value:value.poh_timestamp,relative:false})),details('Age',h(Time,{value:value.poh_timestamp})),details('Transactions',numeric(value.transaction_count)))),
      h('section',{className:'history-record-section'},h('div',{className:'history-section-heading'},h('div',null,h('p',{className:'history-panel-kicker'},'CONTENTS'),h('h2',null,'Transactions'))),
        value.transactions.length?h('ol',{className:'history-record-list'},...value.transactions.map((signature,index)=>h('li',{key:signature},h('span',null,String(index+1).padStart(2,'0')),h(Identifier,{value:signature,to:'/tx/'+signature,compact:true,label:'Copy transaction signature'})))):h('p',{className:'history-empty-inline'},'No transactions in this block.')),
      h('details',{className:'history-raw'},h('summary',null,'Raw archive record'),h('pre',null,JSON.stringify(value,null,2))));
    return h(React.Fragment,null,
      h('section',{className:'history-record-section'},h('div',{className:'history-section-heading'},h('div',null,h('p',{className:'history-panel-kicker'},'TRANSACTION SUMMARY'),h('h2',null,transactionType(value))),h(RecordActions,{value,livePath})),
        h('dl',{className:'history-details'},details('Signature',h(Identifier,{value:value.signature,label:'Copy transaction signature'})),details('Block',link('/block/'+value.slot,numeric(value.slot))),
          details('Outcome',statusBadge(value.status)),details('Signer',h(Identifier,{value:value.signer,to:'/history/address/'+value.signer,label:'Copy signer address'})),
          details('Instructions',numeric(value.instructions?.length)),details('Reported amount',transactionAmount(value)))),
      h('section',{className:'history-record-section'},h('div',{className:'history-section-heading'},h('div',null,h('p',{className:'history-panel-kicker'},'EXECUTION'),h('h2',null,'Verified effects'))),h(Effects,{value})),
      h('section',{className:'history-record-section'},h('div',{className:'history-section-heading'},h('div',null,h('p',{className:'history-panel-kicker'},'SIGNED MESSAGE'),h('h2',null,'Instructions'))),
        ...value.instructions.map(instruction=>h(Instruction,{instruction,key:instruction.index}))),
      h('details',{className:'history-raw'},h('summary',null,'Signed wire data and raw record'),h(CopyButton,{value:value.wire_base64,label:'Copy signed wire'}),h('pre',null,value.wire_base64),h('pre',null,JSON.stringify(value,null,2))));
  }

  function Pagination({stack,response,onFirst,onPrevious,onNext}) {
    return h('nav',{className:'history-pagination','aria-label':'Archive pages'},h('div',{className:'history-pagination-controls'},
      h('button',{type:'button',disabled:stack.length===1,onClick:onFirst},'First'),h('button',{type:'button',disabled:stack.length===1,onClick:onPrevious},'Previous')),
      h('span',null,`Page ${stack.length} · ${response.data.length.toLocaleString()} records`),
      h('button',{type:'button',disabled:!response.cursor,onClick:onNext},'Next'));
  }

  return function HistoryRoute({kind='blocks',Fallback=null}) {
    const location=useLocation(),key=kind+':'+location.pathname;
    const id=location.pathname.split('/').filter(Boolean).at(-1);
    const live=Fallback&&new URLSearchParams(location.search).get('source')==='live';
    const [pages,setPages]=React.useState({key,stack:[null]}),[stored,setState]=React.useState({status:'loading'}),[retry,setRetry]=React.useState(0);
    const cache=React.useRef(new Map());
    const stack=pages.key===key?pages.stack:[null],cursor=stack.at(-1),cacheKey=key+':'+(cursor||'first');
    const state=stored.key===cacheKey?stored:{status:'loading'};
    React.useEffect(()=>{
      if(client.network!=='mainnet'||live)return;
      if(cache.current.has(cacheKey)){
        const cached=cache.current.get(cacheKey);cache.current.delete(cacheKey);cache.current.set(cacheKey,cached);setState(cached);return;
      }
      setState({status:'loading',key:cacheKey});
      return loadHistoryRoute(client,{kind,id,cursor},value=>{
        const tagged={...value,key:cacheKey};
        if(value.status==='ready'){cache.current.set(cacheKey,tagged);while(cache.current.size>MAX_CACHED_PAGES)cache.current.delete(cache.current.keys().next().value);}
        setState(tagged);
      });
    },[key,cursor,live,retry]);
    if(client.network!=='mainnet')return Fallback?h(Fallback):h('main',{className:'history-view'},h('h1',null,'Historical archive'),h('p',null,'Choose Mainnet to browse its full retained history.'));
    if(live)return h(Fallback);
    const response=state.response,isList=['blocks','transactions','address'].includes(kind);
    const livePath=kind==='transaction'?'/tx/'+id:kind==='block'&&/^\d+$/.test(id)?'/block/'+id:kind==='address'?'/account/'+id:null;
    if(state.status==='unavailable'&&Fallback)return h(React.Fragment,null,
      h('aside',{className:'history-fallback',role:'status'},h('strong',null,'History is updating. '),'Recent network activity remains visible.'),h(Fallback));
    const title=kind==='address'?`Activity for ${shortIdentifier(id)}`:titles[kind];
    const pagination=response&&isList?Pagination({stack,response,onFirst:()=>setPages({key,stack:[null]}),onPrevious:()=>setPages({key,stack:stack.slice(0,-1)}),onNext:()=>setPages({key,stack:[...stack,response.cursor]})}):null;
    return h('main',{className:'history-view','aria-busy':state.status==='loading'},
      h('nav',{className:'history-breadcrumb','aria-label':'Breadcrumb'},link('/','Overview'),h('span',{'aria-hidden':'true'},'/'),link('/history','Verified archive'),h('span',{'aria-hidden':'true'},'/'),h('span',{'aria-current':'page'},title)),
      h('div',{className:'history-hero'},h('div',null,h('p',{className:'history-eyebrow'},'XERIS MAINNET · VERIFIED ARCHIVE'),h('h1',null,title),
        h('p',null,kind==='address'?'Immutable archived activity associated with this public address.':'Integrity-checked chain records with explicit archive coverage.')),
        kind==='address'&&h(Identifier,{value:id,label:'Copy address'})),
      h('nav',{'aria-label':'Historical views',className:'history-tabs'},link('/history/blocks','Verified blocks'),link('/history/transactions','Verified transactions'),livePath&&link(livePath+'?source=live','Live node view')),
      Coverage({value:response?.coverage||state.error?.coverage}),
      isList&&response?.snapshot_tip&&h('p',{className:'history-snapshot'},`These pages use the archive snapshot through block ${numeric(response.snapshot_tip.slot)} for consistent pagination.`),
      state.status==='loading'?h('div',{className:'view-loading',role:'status','aria-live':'polite'},h('span',{className:'loading-circle','aria-hidden':'true'}),h('span',null,`Loading ${loadingTitles[kind].toLowerCase()}… Checking archive coverage.`)):
      state.status==='unavailable'?h('section',{className:'history-state',role:'status'},h('h2',null,'History is updating'),h('p',null,'Recent explorer views remain available while retained records catch up.'),link('/','Open overview',{className:'history-primary-action'})):
      state.status==='error'?h('section',{className:'history-state',role:'alert'},h('h2',null,state.error.code==='NOT_INDEXED'?'Record outside retained history':'History is updating'),h('p',null,state.error.code==='NOT_INDEXED'?'This record is outside the current retained range.':'Try again shortly while the explorer refreshes this history.'),
        h('button',{type:'button',onClick:()=>{cache.current.clear();setRetry(value=>value+1);}},'Retry archive')):
      isList?h(React.Fragment,null,pagination,response.data.length?(kind==='blocks'?blockTable(response.data):transactionTable(response.data,{address:kind==='address'?id:null})):
        h('section',{className:'history-state'},h('h2',null,kind==='address'?'No archived activity':'No records on this page'),h('p',null,kind==='address'?'This address has no transactions in the currently retained archive coverage.':'There are no records in this archive page.')),pagination):record(kind,response.data,response.coverage,livePath));
  };
}
