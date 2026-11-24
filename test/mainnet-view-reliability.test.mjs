import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {rawUnits} from '../src/network.mjs';
import * as loaders from '../src/view-loaders.mjs';

// The explicit override lets the author test a pure repair into a scratch file;
// normal repository tests always exercise the generated deployment bundle.
const bundle=readFileSync(process.env.XERIS_TEST_BUNDLE || new URL('../dist/assets/explorer-ui.js',import.meta.url),'utf8');
const start=bundle.indexOf('function XerisNativeAmount('),end=bundle.indexOf('function hv(){',start);
assert.ok(start>=0&&end>start,'Expected generated explorer component boundaries');
const componentSource=bundle.slice(start,end);
const owner='11111111111111111111111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const children=value=>(Array.isArray(value)?value.flat(Infinity):[value]).filter(v=>v!==false&&v!=null);
const jsx=(type,props={})=>({type,props,children:children(props.children)});
function nodes(node,predicate){return node&&typeof node==='object'?[...(predicate(node)?[node]:[]),...(node.children||[]).flatMap(child=>nodes(child,predicate))]:[];}
function text(node){return typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'?(node.children||[]).map(text).join(' '):'';}
function button(tree,label){const matches=nodes(tree,n=>n.type==='button'&&label.test(text(n)));assert.equal(matches.length,1,'Expected one '+label+' button');return matches[0];}
function loading(tree,name){const messages=nodes(tree,n=>n.props.className==='view-loading'&&n.props.role==='status');assert.equal(messages.length,1);assert.match(text(messages[0]),name);assert.equal(nodes(messages[0],n=>n.props.className==='loading-circle'&&String(n.props['aria-hidden'])==='true').length,1);}

function harness(name,api={},params={}){
  const state=[],refs=[],effects=[],pending=[],timers=new Map();let at=0,refAt=0,effectAt=0,dirty=false,clock=Date.now(),timerId=0;
  const React={Fragment:'Fragment',useState(initial){const index=at++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return[state[index],value=>{const next=typeof value==='function'?value(state[index]):value;if(!Object.is(next,state[index])){state[index]=next;dirty=true;}}];},
    useRef(initial){const index=refAt++;return refs[index]||(refs[index]={current:initial});},
    useEffect(effect,deps){const index=effectAt++,old=effects[index];if(!old||deps.some((value,i)=>value!==old.deps[i])){pending.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:effect()};});}},
    createElement:(type,props,...values)=>jsx(type,{...props,children:values})};
  // Icon identifiers from the recovered bundle are opaque elements in this
  // harness. Actual component bodies, hooks, loaders and formatting still run.
  const knownGlobals=new Set(Object.getOwnPropertyNames(globalThis));const scope={};
  for(const word of componentSource.matchAll(/\b[A-Za-z_$][\w$]*\b/g))if(!knownGlobals.has(word[0]))scope[word[0]]=word[0];
  const defaults={network:'mainnet',balances:async()=>({}),accountAges:async()=>({data:[],basis:'earliest_indexed_activity',truncated:false}),accountPrice:async()=>null,tokens:async()=>[],contracts:async()=>[],pools:async()=>[],
    account:async address=>({address,balance:'0',stake:'0',blocks_proposed:0}),accountTransactions:async()=>({data:[],pagination:{page:1,total_pages:1,total:0}}),
    block:async()=>null,contract:async()=>null};
  const selected={...defaults,...api};
  Object.assign(scope,{Date:class extends Date{static now(){return clock}},setInterval:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearInterval:id=>timers.delete(id),a:{jsx,jsxs:jsx},v:React,A:'Link',$r:()=>params,console:{error(){},warn(){},log(){}},
    window:{XerisExplorerAPI:selected,XerisExplorerFormat:rawUnits,XerisExplorerViews:loaders,
      XerisExplorerNavigation:()=>()=>null,XerisExplorerHistory:()=>()=>null},
    uf:selected.balances,Ur:selected.tokens,ag:selected.contracts,cg:selected.pools,ng:selected.account,yc:selected.accountTransactions,og:selected.contract,tn:selected.block});
  vm.runInNewContext(componentSource+';globalThis.__testedView='+name,scope,{timeout:1000});
  return{render(){for(let pass=0;pass<10;pass++){dirty=false;at=refAt=effectAt=0;const tree=scope.__testedView();while(pending.length)pending.shift()();if(!dirty)return tree;}assert.fail('View did not settle after synchronous effect updates');},
    async settled(){await tick();await tick();return this.render();},setNow(value){clock=value;},timer(delay){for(const timer of timers.values())if(timer.delay===delay)timer.callback();},timerCount(){return timers.size;},dispose(){for(const item of effects)item?.cleanup?.();}};
}

test('Accounts has named loading, retry on failure, and an explicit successful-empty state',async()=>{
  let attempt=deferred(),calls=0;const ui=harness('nv',{balances:()=>{calls++;return attempt.promise;}});
  try{
    loading(ui.render(),/loading.*account/i);attempt.reject(Error('offline'));let tree=await ui.settled();
    assert.match(text(tree),/unavailable|could not|failed/i);assert.doesNotMatch(text(tree),/no (accounts|balances|holders)/i);
    attempt=deferred();button(tree,/retry/i).props.onClick();loading(ui.render(),/loading.*account/i);attempt.resolve({});tree=await ui.settled();
    assert.equal(calls,2);assert.match(text(tree),/no (accounts|balances|holders)/i);assert.doesNotMatch(text(tree),/Accounts data is unavailable|Accounts data could not|Accounts data failed/i);
  }finally{ui.dispose();}
});

test('Accounts retains the last valid rows while refresh is pending and after a refresh failure',async()=>{
  let refresh=null;const ui=harness('nv',{balances:()=>refresh?refresh.promise:Promise.resolve({[owner]:'123000000000'})});
  try{
    ui.render();let tree=await ui.settled();assert.match(text(tree),new RegExp(owner));
    refresh=deferred();button(tree,/refresh/i).props.onClick();tree=ui.render();assert.match(text(tree),new RegExp(owner));
    refresh.reject(Error('temporary failure'));tree=await ui.settled();assert.match(text(tree),new RegExp(owner));assert.match(text(tree),/unavailable|could not|failed/i);
    assert.equal(nodes(tree,n=>n.type==='Link'&&n.props.to==='/account/'+owner).length,1);
  }finally{ui.dispose();}
});

for(const [name,method,label,row] of [['iv','tokens','tokens',{token_id:'xrs_native',symbol:'wXRS',decimals:9,max_supply:'18446744073709551615'}],['uv','contracts','contracts',{contract_id:'pool',contract_type:'Swap',owner}]]){
  test(label+' use a named loading circle and recover through Retry',async()=>{
    let attempt=deferred(),calls=0;const ui=harness(name,{[method]:()=>{calls++;return attempt.promise;}});
    try{
      loading(ui.render(),new RegExp('loading.*'+label,'i'));attempt.reject(Error('offline'));let tree=await ui.settled();assert.match(text(tree),/unavailable|could not|failed/i);
      attempt=deferred();button(tree,/retry/i).props.onClick();loading(ui.render(),new RegExp('loading.*'+label,'i'));attempt.resolve([row]);tree=await ui.settled();
      assert.equal(calls,2);assert.match(text(tree),new RegExp(row.token_id||row.contract_id));assert.doesNotMatch(text(tree),/unavailable|could not|failed/i);
    }finally{ui.dispose();}
  });
}

test('contract list links only real 32-byte base58 owners and leaves reserved owners as text',async()=>{
  const ui=harness('uv',{contracts:async()=>[
    {contract_id:'system-contract',contract_type:'System',owner:'SYSTEM'},
    {contract_id:'protocol-contract',contract_type:'Swap',owner:'protocol-owner'},
    {contract_id:'bad-address-contract',contract_type:'Swap',owner:'1'.repeat(44)},
    {contract_id:'wallet-contract',contract_type:'Swap',owner}
  ]});
  try{
    ui.render();const tree=await ui.settled();for(const value of ['SYSTEM','protocol-owner','1'.repeat(44)]){assert.match(text(tree),new RegExp(value));assert.equal(nodes(tree,n=>n.type==='Link'&&n.props.to==='/account/'+value).length,0);}
    assert.equal(nodes(tree,n=>n.type==='Link'&&n.props.to==='/account/'+owner).length,1);
  }finally{ui.dispose();}
});

test('contract detail retains raw contract type and does not turn a reserved owner into an account link',async()=>{
  const ui=harness('dv',{contract:async()=>({contract_id:'recorded',owner:'SYSTEM',contract_type:'Recorded contract',raw_contract_type:'TimeLock',state:{TimeLock:{token_id:'xrs_native'}}})},{id:'recorded'});
  try{ui.render();const tree=await ui.settled();const badges=nodes(tree,n=>n.props.className?.includes('bg-brand-accent/10'));assert.equal(badges.length,1);assert.equal(text(badges[0]),'TimeLock');assert.match(text(tree),/SYSTEM/);assert.equal(nodes(tree,n=>n.type==='Link'&&n.props.to==='/account/SYSTEM').length,0);}
  finally{ui.dispose();}
});

test('raw public contract state is collapsed and preserves both params and state',async()=>{
  const value={contract_id:'public-registry',owner:'protocol',contract_type:'Recorded contract',raw_contract_type:'PQRegistry',params:{name:'Public registry'},state:{public_keys:['fixture-public-key']}};
  const ui=harness('dv',{contract:async()=>value},{id:'public-registry'});
  try{
    ui.render();const tree=await ui.settled(),details=nodes(tree,n=>n.type==='details');assert.equal(details.length,1);assert.notEqual(details[0].props.open,true);
    assert.match(text(details[0]),/Raw contract state/);const raw=nodes(details[0],n=>n.type==='pre');assert.equal(raw.length,1);
    assert.deepEqual(JSON.parse(text(raw[0])),{params:value.params,state:value.state});
  }finally{ui.dispose();}
});

test('account history renders unknown and partial outcomes using the shared status labels and colors',async()=>{
  const rows=['unrecognized','partial'].map((status,index)=>({signature:String(index+2).repeat(88),block_slot:index+1,from:owner,to:owner,amount:'0',tx_type:'contract_call',timestamp:1,status}));
  const ui=harness('ov',{accountTransactions:async()=>({data:rows,pagination:{page:1,total_pages:1,total:2}})},{address:owner});
  try{
    ui.render();const tree=await ui.settled();for(const status of ['unrecognized','partial']){const expected=loaders.transactionStatus(status),matches=nodes(tree,n=>n.props.title===expected.label);assert.equal(matches.length,1);assert.ok(matches[0].props.className.includes(expected.color));assert.ok(!matches[0].props.className.includes('text-green-400')&&!matches[0].props.className.includes('bg-green-400'));}
  }finally{ui.dispose();}
});

test('swap detail preserves exact raw u64 reserves and a legitimate zero fee',async()=>{
  const params={token_a:'xrs_native',token_b:'xeris_usdc',reserve_a:'18446744073709551615',reserve_b:'0',fee_bps:0};
  const ui=harness('dv',{contract:async()=>({contract_id:'zero-fee-pool',owner,contract_type:'swap',params,state:params})},{id:'zero-fee-pool'});
  try{
    ui.render();const tree=await ui.settled();const value=label=>{const fields=nodes(tree,n=>n.props.label===label);assert.equal(fields.length,1);return fields[0].props.value;};
    assert.equal(value('Reserve A'),'18,446,744,073,709,551,615 raw units');assert.equal(value('Reserve B'),'0 raw units');assert.equal(value('Fee'),'0.00%');
    assert.equal(nodes(tree,n=>n.type==='Link'&&n.props.to==='/account/'+owner).length,1);
  }finally{ui.dispose();}
});

for(const decimals of [null,0]){
  test('pool price '+(decimals===null?'stays unavailable without token precision':'honors zero-decimal token metadata'),async()=>{
    const ui=harness('pv',{pools:async()=>[{pool_id:'precision-pool',token_a:'A',token_b:'B',reserve_a:'1',reserve_b:'2',fee_bps:0,price_a_in_b:'2'}],
      tokens:async()=>decimals===null?[]:[{token_id:'A',decimals},{token_id:'B',decimals}]});
    try{
      ui.render();const tree=await ui.settled();const field=nodes(tree,n=>n.children?.length>=2&&n.children[0]?.type==='span'&&/^Price \(/.test(text(n.children[0]).trim()));assert.equal(field.length,1);
      assert.equal(text(field[0].children[1]),decimals===null?'Unavailable':'2');
    }finally{ui.dispose();}
  });
}

const accountAddress = index => '1'.repeat(31) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[index];
const accountRows = tree => nodes(tree,node=>node.type==='tr'&&node.props.className==='data-table-row');
const accountLinks = tree => nodes(tree,node=>node.type==='Link'&&node.props.to?.startsWith('/account/')).map(node=>text(node));
const usdCells = tree => nodes(tree,node=>node.props.className==='accounts-number accounts-usd').map(text);
const accountQuote = {numerator:'10000000',denominator:'1000000000',observedAtMs:'9000',expiresAtMs:'29000'};

test('Accounts replaces wealth-ranking labels and defaults to oldest known activity with unknown ages last',async()=>{
  const addresses=[0,1,2,3].map(accountAddress),balances={
    [addresses[0]]:'2000000000',[addresses[1]]:'1000000000',[addresses[2]]:'0',[addresses[3]]:'200165828090408815'};
  const ages={basis:'earliest_indexed_activity',truncated:true,data:[
    {address:addresses[0],first_seen_slot:10,first_seen_timestamp_ms:null},
    {address:addresses[1],first_seen_slot:1,first_seen_timestamp_ms:1000},
    {address:addresses[2],first_seen_slot:10,first_seen_timestamp_ms:10000}]};
  const ui=harness('nv',{balances:async()=>balances,accountAges:async()=>ages,accountPrice:async()=>accountQuote});ui.setNow(10000);
  try{
    ui.render();let tree=await ui.settled();
    assert.equal(text(nodes(tree,node=>node.type==='h1')[0]),'Accounts');assert.doesNotMatch(bundle,/Rich List|Top Holder/);
    assert.deepEqual(accountLinks(tree),[addresses[1],addresses[0],addresses[2],addresses[3]]);
    assert.match(text(tree),/First-seen coverage is partial/);assert.match(text(tree),/200,165,828\.090408815/);
    assert.ok(usdCells(tree).includes('$2,001,658,280.90'));assert.ok(usdCells(tree).includes('$0.00'));
    assert.match(text(tree),/xUSDC valued at US\$1/);assert.match(text(tree),/Actual trade proceeds vary with fees and price impact/);
    for(const row of accountRows(tree))assert.equal(nodes(row,node=>node.props['data-label']==='Est. value (USD)').length,1);
    button(tree,/Balance \(XRS\)/).props.onClick();tree=ui.render();
    assert.deepEqual(accountLinks(tree),[addresses[3],addresses[0],addresses[1],addresses[2]]);
  }finally{ui.dispose();}
});

test('optional age and price reads can remain pending or fail without removing native balance rows',async()=>{
  const ages=deferred(),price=deferred();const ui=harness('nv',{balances:async()=>({[owner]:'9007199254740993'}),accountAges:()=>ages.promise,accountPrice:()=>price.promise});
  try{
    ui.render();let tree=await ui.settled();assert.deepEqual(accountLinks(tree),[owner]);assert.match(text(tree),/9,007,199\.254740993/);
    assert.deepEqual(usdCells(tree),['Loading…']);
    assert.match(text(nodes(tree,node=>node.props['data-source']==='ages')[0]),/Loading first-seen history/);
    ages.reject(Error('history offline'));price.reject(Error('invalid quote'));tree=await ui.settled();
    assert.deepEqual(accountLinks(tree),[owner]);assert.deepEqual(usdCells(tree),['Unavailable']);
    assert.match(text(tree),/First-seen history is unavailable/);assert.match(text(tree),/Estimated USD values are unavailable/);
    assert.doesNotMatch(text(tree),/Accounts data is unavailable/);
  }finally{ui.dispose();}
});

test('transient price failure retains only the originally valid quote and the one-second expiry removes its values',async()=>{
  let failure=false;const ui=harness('nv',{balances:async()=>({[owner]:'1000000000'}),accountPrice:async()=>{if(failure)throw Object.assign(Error('temporary'),{retryable:true});return accountQuote;}});ui.setNow(10000);
  try{
    ui.render();let tree=await ui.settled();assert.deepEqual(usdCells(tree),['$10.00']);
    failure=true;ui.timer(10000);tree=await ui.settled();assert.deepEqual(usdCells(tree),['$10.00']);assert.match(text(tree),/original expiry/);
    ui.setNow(29000);ui.timer(1000);tree=ui.render();assert.deepEqual(usdCells(tree),['Unavailable']);assert.deepEqual(accountLinks(tree),[owner]);
  }finally{ui.dispose();}
});

test('invalid or wrong-chain price failures clear the prior quote before its expiry',async()=>{
  for(const code of ['INVALID_RESPONSE','NETWORK_MISMATCH']){
    let invalid=false;const ui=harness('nv',{balances:async()=>({[owner]:'1000000000'}),accountPrice:async()=>{if(invalid)throw Object.assign(Error('invalid'),{code,retryable:false});return accountQuote;}});ui.setNow(10000);
    try{
      ui.render();assert.deepEqual(usdCells(await ui.settled()),['$10.00']);invalid=true;ui.timer(10000);
      const tree=await ui.settled();assert.deepEqual(usdCells(tree),['Unavailable']);assert.deepEqual(accountLinks(tree),[owner]);
    }finally{ui.dispose();}
  }
});

test('price polling and manual refresh share an in-flight read and dispose both timers',async()=>{
  const price=deferred();let calls=0;const ui=harness('nv',{balances:async()=>({[owner]:'1'}),accountPrice:()=>{calls++;return price.promise;}});ui.setNow(10000);
  ui.render();let tree=await ui.settled();assert.equal(calls,1);ui.timer(10000);ui.timer(10000);assert.equal(calls,1);
  button(tree,/Refresh accounts/).props.onClick();ui.render();tree=await ui.settled();assert.equal(calls,1);
  price.resolve(accountQuote);tree=await ui.settled();assert.deepEqual(usdCells(tree),['<$0.01']);
  ui.dispose();assert.equal(ui.timerCount(),0);
});

test('Testnet Accounts never requests or reuses Mainnet age and valuation metadata',async()=>{
  let optional=0;const ui=harness('nv',{network:'testnet',balances:async()=>({[owner]:'1000000000'}),
    accountAges:async()=>{optional++;throw Error('must not call');},accountPrice:async()=>{optional++;throw Error('must not call');}});
  try{
    ui.render();const tree=await ui.settled();assert.equal(optional,0);assert.equal(ui.timerCount(),0);assert.deepEqual(accountLinks(tree),[owner]);
    assert.deepEqual(usdCells(tree),['Unavailable']);assert.match(text(tree),/unavailable on Testnet/);
  }finally{ui.dispose();}
});

test('Accounts pagination makes every returned account reachable and search resets to its first page',async()=>{
  const addresses=Array.from({length:51},(_,index)=>accountAddress(index));const balances=Object.fromEntries(addresses.map((address,index)=>[address,String(index+1)]));
  const ui=harness('nv',{network:'testnet',balances:async()=>balances});
  try{
    ui.render();let tree=await ui.settled();assert.equal(accountLinks(tree).length,50);
    button(tree,/Next accounts/).props.onClick();tree=ui.render();assert.equal(accountLinks(tree).length,1);
    const last=accountLinks(tree)[0];const search=nodes(tree,node=>node.type==='input'&&node.props.type==='search')[0];search.props.onChange({target:{value:last}});
    tree=ui.render();assert.deepEqual(accountLinks(tree),[last]);assert.match(text(tree),/1–1 of 1 matching accounts/);
  }finally{ui.dispose();}
});

test('mobile Accounts exposes labeled sorting synchronized with desktop headers and hides unfocusable headers',async()=>{
  const addresses=[0,1,2].map(accountAddress),balances=Object.fromEntries(addresses.map((address,index)=>[address,String(3-index)]));
  const ages={basis:'earliest_indexed_activity',truncated:false,data:addresses.slice(0,2).map((address,index)=>({address,first_seen_slot:index+1,first_seen_timestamp_ms:null}))};
  const ui=harness('nv',{balances:async()=>balances,accountAges:async()=>ages});
  const control=tree=>nodes(tree,node=>node.type==='select'&&node.props['aria-label']==='Sort accounts')[0];
  try{
    ui.render();let tree=await ui.settled();assert.equal(control(tree).props.value,'age:asc');
    assert.equal(nodes(tree,node=>node.type==='label'&&node.props.className==='accounts-mobile-sort').length,1);
    const expected=[['age:desc',[addresses[1],addresses[0],addresses[2]]],['balance:asc',[addresses[2],addresses[1],addresses[0]]],
      ['balance:desc',addresses],['address:asc',addresses],['address:desc',[...addresses].reverse()],['age:asc',addresses]];
    assert.deepEqual(nodes(control(tree),node=>node.type==='option').map(node=>node.props.value),['age:asc','age:desc','balance:desc','balance:asc','address:asc','address:desc']);
    for(const [value,order] of expected){control(tree).props.onChange({target:{value}});tree=ui.render();assert.deepEqual(accountLinks(tree),order);assert.equal(control(tree).props.value,value);}
    button(tree,/Balance \(XRS\)/).props.onClick();tree=ui.render();assert.equal(control(tree).props.value,'balance:desc');
    const css=readFileSync(new URL('../src/explorer.css',import.meta.url),'utf8');
    const mobile=css.slice(css.lastIndexOf('@media(max-width:767px)'));
    assert.match(mobile,/\.accounts-table thead\{display:none\}/);assert.match(mobile,/\.accounts-mobile-sort\{display:grid/);
    assert.match(mobile,/grid-template-columns:minmax\(0,1\.4fr\) minmax\(0,1fr\)/);
  }finally{ui.dispose();}
});
