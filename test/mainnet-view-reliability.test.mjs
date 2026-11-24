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
  const state=[],refs=[],effects=[],pending=[];let at=0,refAt=0,effectAt=0,dirty=false;
  const React={Fragment:'Fragment',useState(initial){const index=at++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return[state[index],value=>{const next=typeof value==='function'?value(state[index]):value;if(!Object.is(next,state[index])){state[index]=next;dirty=true;}}];},
    useRef(initial){const index=refAt++;return refs[index]||(refs[index]={current:initial});},
    useEffect(effect,deps){const index=effectAt++,old=effects[index];if(!old||deps.some((value,i)=>value!==old.deps[i])){pending.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:effect()};});}},
    createElement:(type,props,...values)=>jsx(type,{...props,children:values})};
  // Icon identifiers from the recovered bundle are opaque elements in this
  // harness. Actual component bodies, hooks, loaders and formatting still run.
  const knownGlobals=new Set(Object.getOwnPropertyNames(globalThis));const scope={};
  for(const word of componentSource.matchAll(/\b[A-Za-z_$][\w$]*\b/g))if(!knownGlobals.has(word[0]))scope[word[0]]=word[0];
  const defaults={network:'mainnet',balances:async()=>({}),tokens:async()=>[],contracts:async()=>[],pools:async()=>[],
    account:async address=>({address,balance:'0',stake:'0',blocks_proposed:0}),accountTransactions:async()=>({data:[],pagination:{page:1,total_pages:1,total:0}}),
    block:async()=>null,contract:async()=>null};
  const selected={...defaults,...api};
  Object.assign(scope,{a:{jsx,jsxs:jsx},v:React,A:'Link',$r:()=>params,console:{error(){},warn(){},log(){}},
    window:{XerisExplorerAPI:selected,XerisExplorerFormat:rawUnits,XerisExplorerViews:loaders,
      XerisExplorerNavigation:()=>()=>null,XerisExplorerHistory:()=>()=>null},
    uf:selected.balances,Ur:selected.tokens,ag:selected.contracts,cg:selected.pools,ng:selected.account,yc:selected.accountTransactions,og:selected.contract,tn:selected.block});
  vm.runInNewContext(componentSource+';globalThis.__testedView='+name,scope,{timeout:1000});
  return{render(){for(let pass=0;pass<10;pass++){dirty=false;at=refAt=effectAt=0;const tree=scope.__testedView();while(pending.length)pending.shift()();if(!dirty)return tree;}assert.fail('View did not settle after synchronous effect updates');},
    async settled(){await tick();await tick();return this.render();},dispose(){for(const item of effects)item?.cleanup?.();}};
}

test('Accounts has named loading, retry on failure, and an explicit successful-empty state',async()=>{
  let attempt=deferred(),calls=0;const ui=harness('nv',{balances:()=>{calls++;return attempt.promise;}});
  try{
    loading(ui.render(),/loading.*account/i);attempt.reject(Error('offline'));let tree=await ui.settled();
    assert.match(text(tree),/unavailable|could not|failed/i);assert.doesNotMatch(text(tree),/no (accounts|balances|holders)/i);
    attempt=deferred();button(tree,/retry/i).props.onClick();loading(ui.render(),/loading.*account/i);attempt.resolve({});tree=await ui.settled();
    assert.equal(calls,2);assert.match(text(tree),/no (accounts|balances|holders)/i);assert.doesNotMatch(text(tree),/unavailable|could not|failed/i);
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
