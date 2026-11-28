import test from 'node:test';
import assert from 'node:assert/strict';
import {searchDestination} from '../src/navigation.mjs';
test('search routes exact identifiers without a remote discovery request',()=>{
  assert.equal(searchDestination(' 027201 '),'/block/27201');
  assert.equal(searchDestination('xeris_usdc'),'/token/xeris_usdc');
  assert.equal(searchDestination('xrs-xusdc-mainnet-v1'),'/contract/xrs-xusdc-mainnet-v1');
  assert.equal(searchDestination('plain','token'),'/token/plain');
  assert.equal(searchDestination('4p897nUzAxU9xbaQH69fa3S3hvtn9o1STiobHX4vnLoL'),'/account/4p897nUzAxU9xbaQH69fa3S3hvtn9o1STiobHX4vnLoL');
});
test('ambiguous, oversized, unsafe and malformed search terms remain in the form',()=>{
  for(const [value,scope] of [['plain','auto'],['<script>','token'],['../../path','contract'],['https://other.example','token'],['9007199254740992','block'],['0invalid','account'],['x'.repeat(129),'token']])assert.throws(()=>searchDestination(value,scope));
});

import {createNavigation,activeSection} from '../src/navigation.mjs';
import {readFile} from 'node:fs/promises';
function navigationHarness(pathname='/') {
  const state=[],refs=[],effects=[],pending=[];let stateAt=0,refAt=0,effectAt=0;
  const location={pathname},navigations=[];
  const React={
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat().filter(child=>child!==false&&child!=null)}),
    useState(initial){const index=stateAt++;if(!(index in state))state[index]=initial;return[state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];},
    useRef(initial){const index=refAt++;return refs[index]??=({current:initial});},
    useEffect(fn,deps){const index=effectAt++,old=effects[index];if(!old||deps.some((value,i)=>value!==old[i])){effects[index]=deps;pending.push(fn);}},
  };
  const View=createNavigation(React,'Link',()=>location,()=>value=>navigations.push(value));
  return {location,navigations,render(){stateAt=refAt=effectAt=0;const tree=View();while(pending.length)pending.shift()();return tree;}};
}
function nodes(tree,predicate){return tree&&typeof tree==='object'?[...(predicate(tree)?[tree]:[]),...(tree.children||[]).flatMap(child=>nodes(child,predicate))]:[];}
const one=(tree,predicate)=>{const result=nodes(tree,predicate);assert.equal(result.length,1);return result[0];};
const click=(detail=0,extra={})=>({button:0,detail,...extra});
test('detail routes retain section context without claiming a parent link is the current page',()=>{
  for(const [path,section] of [['/block/27201','/'],['/tx/signature','/transactions'],['/account/owner','/balances'],['/token/xeris_usdc','/tokens'],['/contract/pool','/contracts'],['/pools','/pools'],['/stats','/stats'],['/unknown',null]]) {
    assert.equal(activeSection(path),section);
    const harness=navigationHarness(path),tree=harness.render();
    const current=nodes(tree,node=>node.type==='Link'&&node.props['aria-current']);assert.equal(current.length,section?1:0);
    if(section){assert.equal(current[0].props.to,section);assert.equal(current[0].props['aria-current'],path===section?'page':'location');}
    assert.deepEqual(harness.navigations,[]);
  }
});
test('Escape closes an open menu and returns focus; a closed menu does not capture Escape',()=>{
  const harness=navigationHarness();let tree=harness.render(),focused=0,prevented=0;
  let button=one(tree,node=>node.props.className==='explorer-menu');button.props.ref.current={focus(){focused++;}};
  tree.props.onKeyDown({key:'Escape',preventDefault(){prevented++;}});assert.equal(focused,0);assert.equal(prevented,0);
  button.props.onClick();tree=harness.render();assert.equal(one(tree,node=>node.props.className==='explorer-menu').props['aria-expanded'],true);
  tree.props.onKeyDown({key:'Escape',preventDefault(){prevented++;}});tree=harness.render();
  assert.equal(one(tree,node=>node.props.className==='explorer-menu').props['aria-expanded'],false);assert.equal(focused,1);assert.equal(prevented,1);
});
test('only explicit keyboard route selection focuses content and polling rerenders never refocus',()=>{
  const original=globalThis.document,calls=[];globalThis.document={getElementById:id=>{assert.equal(id,'explorer-content');return{focus:options=>calls.push(options)};}};
  try {
    const harness=navigationHarness();let tree=harness.render();assert.equal(calls.length,0);
    one(tree,node=>node.type==='Link'&&node.props.to==='/tokens').props.onClick(click());harness.location.pathname='/tokens';tree=harness.render();assert.deepEqual(calls,[{preventScroll:true}]);
    harness.render();harness.render();assert.equal(calls.length,1);
    one(tree,node=>node.type==='Link'&&node.props.to==='/pools').props.onClick(click(1));harness.location.pathname='/pools';tree=harness.render();assert.equal(calls.length,1);
    one(tree,node=>node.type==='Link'&&node.props.to==='/contracts').props.onClick(click(0,{metaKey:true}));harness.location.pathname='/contracts';harness.render();assert.equal(calls.length,1);
  } finally {if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
test('search errors are associated with the field and clear on edits without navigating',()=>{
  const harness=navigationHarness();let tree=harness.render();
  one(tree,node=>node.type==='input').props.onChange({target:{value:'ambiguous'}});tree=harness.render();one(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=harness.render();
  assert.equal(one(tree,node=>node.type==='input').props['aria-invalid'],true);assert.equal(one(tree,node=>node.props.role==='alert').props.id,'explorer-search-error');assert.deepEqual(harness.navigations,[]);
  one(tree,node=>node.type==='input').props.onChange({target:{value:'027201'}});tree=harness.render();
  assert.equal(one(tree,node=>node.type==='input').props['aria-invalid'],false);assert.equal(nodes(tree,node=>node.props.role==='alert').length,0);assert.deepEqual(harness.navigations,[]);
  one(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=harness.render();assert.deepEqual(harness.navigations,['/block/27201']);assert.equal(one(tree,node=>node.type==='input').props.value,'');
});
test('built skip targets remain after navigation for every route and reachable during startup',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  assert.match(html,/<a id="skip-to-content" class="skip-to-content" href="#startup-loader">/);
  assert.match(html,/<main class="startup-loader" id="startup-loader" tabindex="-1"/);
  const source=await readFile(new URL('../dist/assets/explorer-ui.js',import.meta.url),'utf8');
  const start=source.indexOf('function hv(){'),end=source.indexOf('class XerisExplorerBoundary',start);assert.ok(start>=0&&end>start);
  const jsx=(type,props)=>({type,props});
  const names=['Zh','ev','Wh','Ce','tv','nv','rv','lv','sv','av','ov','iv','cv','uv','dv','pv','mv','A','XerisHistoryRoute'];
  const shell=Function('a',...names,source.slice(start,end)+';return hv;')({jsx,jsxs:jsx},...names.map(name=>name))();
  const children=shell.props.children.props.children;
  assert.equal(children.length,2);assert.equal(children[0].type,'ev');
  const content=children[1];assert.equal(content.type,'section');assert.equal(content.props.id,'explorer-content');assert.equal(content.props.tabIndex,-1);
  assert.equal(content.props.children.type,'Wh');const routes=content.props.children.props.children;
  for(const path of ['/','/block/:slot','/tx/:signature','/account/:address','/token/:id','/contract/:id','*'])assert.ok(routes.some(route=>route.props.path===path));
  const boundaryText=source.slice(end,source.indexOf('Gs.createRoot(',end));
  const Boundary=Function('v','a','window',boundaryText+';return XerisExplorerBoundary;')({Component:class{constructor(props){this.props=props;}}},{jsx,jsxs:jsx},{XerisExplorerAPI:{network:'testnet'}});
  const boundary=new Boundary({children:null});boundary.state.failed=true;const fallback=boundary.render();
  assert.equal(fallback.type,'main');assert.equal(fallback.props.id,'explorer-content');assert.equal(fallback.props.tabIndex,-1);
});

test('startup completion hands skip focus to content only while the loader still owns focus',async()=>{
  const source=await readFile(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const finishStartup = () => {'),end=source.indexOf('let retryTimer,',start);assert.ok(start>=0&&end>start);
  const startup={hidden:false},skipLink={href:'#startup-loader'},root={setAttribute(name,value){assert.equal(name,'aria-busy');assert.equal(value,'false');}};
  let focused=0,active=startup;const content={focus(options){assert.deepEqual(options,{preventScroll:true});focused++;}};
  const document={get activeElement(){return active;},getElementById(id){assert.equal(id,'explorer-content');return content;}};
  const finish=Function('startup','skipLink','root','document',source.slice(start,end)+';return finishStartup;')(startup,skipLink,root,document);
  finish();assert.equal(focused,1);assert.equal(skipLink.href,'#explorer-content');assert.equal(startup.hidden,true);
  active={};finish();assert.equal(focused,1);
});
