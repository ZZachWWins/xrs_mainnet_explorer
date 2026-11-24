import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHistoryClient} from '../src/history-client.mjs';
import {loadHistoryRoute} from '../src/history-views.mjs';
import {createHistoryFunction} from '../netlify/functions/history.mjs';
import {searchDestination} from '../src/navigation.mjs';

const generation='a'.repeat(64);
const coverage={chain_id:'xeris-mainnet-v4',indexed_from:1,tip:{slot:47625,hash:'b'.repeat(64)},counts:{blocks:47625,transactions:16},gaps:[],block_shard_size:1000,list_page_size:100};
const body=data=>({generation,coverage,data});
const response=(data,status=200,network='mainnet')=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-xeris-network':network,'x-xeris-chain-id':'xeris-mainnet-v4'}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('unpublished manifest produces honest 503 and fixed Mainnet identity without writes',async()=>{
  let reads=0;const handle=createHistoryFunction({fetchImpl:async()=>{throw Error('offline fixture');},adapter:{async readCurrent(){reads++;return null;},async readGeneration(){throw Error('unexpected');},async readJSON(){throw Error('unexpected');}}});
  const result=await handle(new Request('https://example.test/api/history/coverage'));assert.equal(result.status,503);assert.equal(result.headers.get('x-xeris-network'),'mainnet');
  const data=await result.json();assert.equal(data.coverage,null);assert.equal(data.generation,null);assert.equal(reads,1);
  const alias=await handle(new Request('https://example.test/.netlify/functions/history/coverage'));assert.equal(alias.status,503);
});
test('Function refuses network overrides and writes before accessing storage',async()=>{
  let calls=0;const handle=createHistoryFunction({fetchImpl:async()=>{throw Error('offline fixture');},adapter:{async readCurrent(){calls++;},async readGeneration(){calls++;},async readJSON(){calls++;}}});
  assert.equal((await handle(new Request('https://example.test/api/history/coverage?network=testnet'))).status,400);
  assert.equal((await handle(new Request('https://example.test/api/history/coverage',{method:'POST'}))).status,405);
  assert.equal((await handle(new Request('https://example.test/networks/testnet/history'))).status,404);assert.equal(calls,0);
});
test('Testnet does not contact the Mainnet archive, including explicit history routes',async()=>{
  const client=createHistoryClient('testnet',{fetchImpl:async()=>{throw Error('network must not be contacted');}});
  assert.deepEqual(await client.readiness(),{ready:false,reason:'disabled'});
  await assert.rejects(client.page('blocks'),e=>e.code==='DISABLED');
});
test('ready archive requires matching chain, layout, nonempty bounded coverage and network headers',async()=>{
  for(const [data,network] of [[body(coverage),'testnet'],[{...body(coverage),coverage:{...coverage,chain_id:'xeris-testnet'}},'mainnet'],[{...body(coverage),coverage:{...coverage,tip:null}},'mainnet']]){
    const client=createHistoryClient('mainnet',{fetchImpl:async()=>response(data,200,network)});assert.equal((await client.readiness()).ready,false);
  }
  const requests=[];const client=createHistoryClient('mainnet',{fetchImpl:async(path,options)=>{requests.push({path,options});return response(body(coverage));}});
  assert.equal((await client.readiness()).ready,true);assert.equal(requests[0].path,'/.netlify/functions/history/coverage');assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.credentials,'omit');
});
test('archive unavailable signals explicit recent-view fallback without requesting archive rows',async()=>{
  const events=[];let rows=0;loadHistoryRoute({readiness:async()=>({ready:false,reason:'UNAVAILABLE'}),page:async()=>{rows++;}}, {kind:'transactions'},value=>events.push(value));
  await tick();assert.equal(events[0].status,'unavailable');assert.equal(rows,0);
});
test('old transaction absent from activated archive stays not-indexed, never silently falls back',async()=>{
  const paths=[];const signature='3XjqbLivVquemCZEiKfbYbcxku9a12NMbyNpbFsSFjT4Am4FTfrttjyRPE1KB6xaQK4SDxGV2VvBccyxMMhhkn36';
  const client=createHistoryClient('mainnet',{fetchImpl:async path=>{paths.push(path);return path.endsWith('/coverage')?response(body(coverage)):response({...body(null),error:{code:'not_indexed'}},404);}});
  const events=[];loadHistoryRoute(client,{kind:'transaction',id:signature},value=>events.push(value));
  await tick();await tick();assert.equal(events[0].status,'error');assert.equal(events[0].error.code,'NOT_INDEXED');assert.equal(events[0].error.coverage.indexed_from,1);assert.equal(paths.length,2);assert.ok(paths.every(p=>p.startsWith('/.netlify/functions/history/')));
});
test('stale route responses cannot replace a newer page',async()=>{
  let finish;const client={readiness:async()=>({ready:true}),record:()=>new Promise(resolve=>{finish=resolve;})};const events=[];
  const dispose=loadHistoryRoute(client,{kind:'block',id:'1'},v=>events.push(v));await tick();dispose();finish(body({slot:1}));await tick();assert.deepEqual(events,[]);
});
test('Mainnet search keeps live-capable slot, signature and account routes; only hashes require archive',()=>{
  const opts={history:true};assert.equal(searchDestination('1','auto',opts),'/block/1');
  assert.equal(searchDestination('F'.repeat(64),'auto',opts),'/history/block/'+'f'.repeat(64));
  assert.equal(searchDestination('3'.repeat(88),'tx',opts),'/tx/'+'3'.repeat(88));
  assert.equal(searchDestination('H'.repeat(44),'account',opts),'/account/'+'H'.repeat(44));
  assert.equal(searchDestination('1'),'/block/1');assert.throws(()=>searchDestination('f'.repeat(64),'block'));
});
test('build includes history routes and keeps source/SDK server-only with pinned dependency',async()=>{
  const bundle=await readFile(new URL('../dist/assets/explorer-ui.js',import.meta.url),'utf8');assert.match(bundle,/path:"\/history\/address\/:id"/);assert.match(bundle,/kind:"transaction",Fallback:av/);
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');assert.match(html,/data-network="testnet" aria-pressed="true"/);assert.doesNotMatch(html,/@netlify|history-index\/blobs/);
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url)));
  assert.equal(pkg.dependencies['@netlify/blobs'],'11.1.11');assert.equal(lock.packages['node_modules/@netlify/blobs'].version,'11.1.11');assert.ok(lock.packages['node_modules/@netlify/blobs'].integrity.startsWith('sha512-'));
});

import {createHistoryViews} from '../src/history-views.mjs';
function viewHarness(client,pathname='/history/blocks'){
  const state=[],refs=[],effects=[];let at=0,refAt=0,effectAt=0;const location={pathname,search:'?network=mainnet'};
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props||{},children:children.flat().filter(v=>v!==false&&v!=null)}),
    useState(initial){const n=at++;if(!(n in state))state[n]=initial;return[state[n],v=>{state[n]=typeof v==='function'?v(state[n]):v;}];},
    useRef(initial){const n=refAt++;return refs[n]||(refs[n]={current:initial});},
    useEffect(fn,deps){const n=effectAt++,old=effects[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();effects[n]={deps,cleanup:fn()};}}};
  const View=createHistoryViews(React,'Link',()=>location,client);
  return {location,render(props={kind:'blocks'}){at=0;refAt=0;effectAt=0;return View(props);}};
}
function textOf(node){if(typeof node==='string'||typeof node==='number')return String(node);return node&&typeof node==='object'?(node.children||[]).map(textOf).join(' '):'';}
function findNodes(node,predicate){return node&&typeof node==='object'?[...(predicate(node)?[node]:[]),...(node.children||[]).flatMap(child=>findNodes(child,predicate))]:[];}
test('ready view renders honest coverage, records, paging, and never stale records across routes',async()=>{
  const block={slot:47625,hash:'b'.repeat(64),transaction_count:0,transactions:[],proposer:'1'.repeat(32),poh_timestamp:1795545129854};
  const client={network:'mainnet',readiness:async()=>({ready:true}),page:async()=>({...body([block]),cursor:'next_cursor'}),record:async()=>body({...block,slot:1})};
  const ui=viewHarness(client);ui.render();await tick();await tick();let tree=ui.render();assert.match(textOf(tree),/Indexed blocks 1–47,625/);assert.match(textOf(tree),/16 transactions/);assert.match(textOf(tree),/47,625/);
  const next=findNodes(tree,n=>n.type==='button'&&textOf(n)==='Next')[0];assert.equal(next.props.disabled,false);next.props.onClick();ui.render();await tick();await tick();assert.match(textOf(ui.render()),/Page 2/);
  ui.location.pathname='/history/block/1';tree=ui.render({kind:'block'});assert.match(textOf(tree),/Checking archive coverage/);assert.doesNotMatch(textOf(tree),/47,625/);
  await tick();await tick();tree=ui.render({kind:'block'});assert.match(textOf(tree),/No transactions in this block/);
});
test('view fallback is explicit; Testnet returns its existing component without archive reads',async()=>{
  const Fallback=()=>null;let calls=0;const ui=viewHarness({network:'mainnet',readiness:async()=>{calls++;return{ready:false};}});
  ui.render({kind:'transactions',Fallback});await tick();const tree=ui.render({kind:'transactions',Fallback});assert.match(textOf(tree),/Showing the live endpoint/);assert.ok(findNodes(tree,n=>n.type===Fallback).length);
  const testnet=viewHarness({network:'testnet',readiness:async()=>{throw Error('must not call');}});assert.equal(testnet.render({Fallback}).type,Fallback);assert.equal(calls,1);
});
test('unpublished Mainnet searches resolve built live fallbacks and preserve the account balance route',async()=>{
  const source=await readFile(new URL('../dist/assets/explorer-ui.js',import.meta.url),'utf8');
  const start=source.indexOf('function hv(){'),end=source.indexOf('class XerisExplorerBoundary',start);
  const jsx=(type,props)=>({type,props}),names=['Zh','ev','Wh','Ce','tv','nv','rv','lv','sv','av','ov','iv','cv','uv','dv','pv','mv','A','XerisHistoryRoute'];
  const shell=Function('a',...names,source.slice(start,end)+';return hv;')({jsx,jsxs:jsx},...names.map(name=>name))();
  const routes=shell.props.children.props.children[1].props.children.props.children;
  let manifestReads=0;
  const client=createHistoryClient('mainnet',{fetchImpl:async path=>{assert.equal(path,'/.netlify/functions/history/coverage');manifestReads++;return response({error:{code:'unavailable'},coverage:null,generation:null},503);}});
  for(const [input,scope,pattern,fallback] of [['1','block','/block/:slot','sv'],['3'.repeat(88),'tx','/tx/:signature','av']]){
    const path=searchDestination(input,scope,{history:true}),route=routes.find(v=>v.props.path===pattern);
    assert.equal(path.split('/')[1],pattern.split('/')[1]);assert.equal(route.props.element.type,'XerisHistoryRoute');assert.equal(route.props.element.props.Fallback,fallback);
    const ui=viewHarness(client,path),props=route.props.element.props;ui.render(props);await tick();await tick();
    const tree=ui.render(props);assert.match(textOf(tree),/Showing the live endpoint/);assert.equal(findNodes(tree,n=>n.type===fallback).length,1);
  }
  assert.equal(manifestReads,2);
  const address='H'.repeat(44);assert.equal(searchDestination(address,'auto',{history:true}),'/account/'+address);
  const account=routes.find(v=>v.props.path==='/account/:address');assert.equal(account.props.element.type,'ov');assert.deepEqual(account.props.element.props,{});
  const linkExpression=source.match(/window\.XerisExplorerAPI\.network==="mainnet"&&a\.jsx\(A,\{to:`\/history\/address\/\$\{e\}`,className:"[^"]+",children:"Address history"\}\)/)?.[0];assert.ok(linkExpression);
  const renderLink=Function('window','a','A','e','return '+linkExpression);
  assert.equal(renderLink({XerisExplorerAPI:{network:'testnet'}},{jsx},'Link',address),false);
  const link=renderLink({XerisExplorerAPI:{network:'mainnet'}},{jsx},'Link',address);assert.equal(link.props.to,'/history/address/'+address);assert.equal(link.props.children,'Address history');
});
test('history loading names the view and reuses the accessible existing loading circle',()=>{
  const ui=viewHarness({network:'mainnet',readiness:()=>new Promise(()=>{})},'/history/address/'+'H'.repeat(44));
  const tree=ui.render({kind:'address'}),loading=findNodes(tree,n=>n.props.className==='view-loading')[0];
  assert.equal(loading.props.role,'status');assert.equal(loading.props['aria-live'],'polite');assert.match(textOf(loading),/Loading address history/);
  const circle=findNodes(loading,n=>n.props.className==='loading-circle')[0];assert.equal(circle.props['aria-hidden'],'true');
});
test('history page cache retains recent pages but evicts older data beyond 20 entries',async()=>{
  const calls=[];const client={network:'mainnet',readiness:async()=>({ready:true}),page:async(kind,cursor)=>{
    calls.push(cursor);const page=cursor===null?0:Number(cursor);
    return {...body([{slot:page+1,hash:String(page).padStart(64,'0'),transaction_count:0,poh_timestamp:1795545129854}]),cursor:String(page+1)};
  }};
  const ui=viewHarness(client);async function ready(){ui.render();await tick();await tick();return ui.render();}
  let tree=await ready();
  for(let page=1;page<=20;page++){findNodes(tree,n=>n.type==='button'&&textOf(n)==='Next')[0].props.onClick();tree=await ready();}
  assert.equal(calls.length,21);assert.match(textOf(tree),/Page 21/);
  findNodes(tree,n=>n.type==='button'&&textOf(n)==='Previous')[0].props.onClick();tree=await ready();assert.equal(calls.length,21);
  for(let page=18;page>=0;page--){findNodes(tree,n=>n.type==='button'&&textOf(n)==='Previous')[0].props.onClick();tree=await ready();}
  assert.match(textOf(tree),/Page 1/);assert.equal(calls.length,22);assert.equal(calls.at(-1),null);
});
test('history view labels source, stale snapshot age and pagination snapshot separately',async()=>{
  const client={network:'mainnet',readiness:async()=>({ready:true}),page:async()=>({...body([]),coverage:{...coverage,source:'blobs',stale:true,snapshot_age_ms:7_200_000},snapshot_tip:{slot:47600,hash:'c'.repeat(64)},cursor:null})};
  const ui=viewHarness(client);ui.render();await tick();await tick();const text=textOf(ui.render());
  assert.match(text,/Source: verified stored snapshot\. 2 hours old/);assert.match(text,/Archive updates are delayed/);assert.match(text,/snapshot through block 47,600/);assert.match(text,/Indexed blocks 1–47,625/);
});
