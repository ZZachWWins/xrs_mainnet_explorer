"""Asserted repairs for the supplied compiled views after build.py's base repairs.

No original source is claimed: the maintained loaders/navigation own behavior;
these bounded transforms connect their public results to the recovered JSX UI.
"""


def repair_views(code):
    asserted = 0

    def one(text, before, after, label):
        nonlocal asserted
        count = text.count(before)
        if count != 1:
            raise RuntimeError(f'{label}: expected one match, found {count}')
        asserted += 1
        return text.replace(before, after, 1)

    def span(text, start, end, after, label):
        if text.count(start) != 1 or text.count(end) != 1:
            raise RuntimeError(f'{label}: scoped span is no longer unique')
        left = text.index(start)
        right = text.index(end, left) + len(end)
        return one(text, text[left:right], after, label)

    def view(name, following, transform):
        nonlocal code
        start, end = f'function {name}(', f'function {following}('
        if code.count(start) != 1 or code.count(end) != 1:
            raise RuntimeError(f'{name}: view boundary changed')
        left, right = code.index(start), code.index(end, code.index(start))
        code = code[:left] + transform(code[left:right]) + code[right:]

    def loading(message):
        return 'a.jsxs("div",{className:"view-loading",role:"status",children:[a.jsx("span",{className:"loading-circle","aria-hidden":true}),a.jsx("span",{children:"' + message + '"})]})'

    # Complete component replacement, bounded by the original adjacent helper.
    view('ev', 'Nt', lambda text: one(text, text, 'const ev=window.XerisExplorerNavigation(v,A,Dr,Qd);', 'navigation component'))

    def details(text, call, variable, label):
        old = f'v.useEffect(()=>{{{call}(e).then({variable}=>{{n({variable}),l(!1)}}).catch({variable}=>{{console.error({variable}),o("Failed to fetch {label} details"),l(!1)}})}},[e])'
        new = f'v.useEffect(()=>{{let alive=true;n(null);l(true);o(null);{call}(e).then(value=>{{if(alive){{n(value);l(false);if(!value)o("No matching {label} record was found.")}}}}).catch(()=>{{if(alive){{o("We could not refresh this {label} yet. Try again.");l(false)}}}});return()=>{{alive=false}}}},[e])'
        text = one(text, old, new, label + ' route lifetime')
        if label != 'contract':
            text = one(text, 'a.jsx("div",{className:"flex justify-center items-center min-h-[50vh]",children:a.jsx("div",{className:"animate-spin rounded-full h-12 w-12 border-b-2 border-brand-vibrant"})})', loading('Loading ' + label + ' details…'), label + ' loading message')
        else:
            text = one(text, 'a.jsx("div",{className:"text-white text-center py-20",children:"Loading contract details..."})', loading('Loading contract details…'), 'contract loading message')
        return text

    view('sv', 'dl', lambda text: details(text, 'tn', 'u', 'block'))
    view('av', 'Xs', lambda text: details(text, 'tg', 'c', 'transaction'))
    view('dv', 'fv', lambda text: details(text, 'og', 'J', 'contract'))

    def account(text):
        text = one(text, 'function ov(){const{address:e}', 'function ov(){const[historyStatus,setHistoryStatus]=v.useState("loading"),lastAddress=v.useRef(null);const{address:e}', 'account history state')
        effect = '''v.useEffect(()=>{const changed=lastAddress.current!==e;if(changed){lastAddress.current=e;n(null);c(true);h(null);l([]);g(null);setHistoryStatus("loading");x({page:1,total_pages:1,total:null});if(m.page!==1)return}h(null);l([]);g(null);setHistoryStatus("loading");return window.XerisExplorerViews.loadAccountView(window.XerisExplorerAPI,e,m.page,{account:value=>{n(value);c(false)},accountError:()=>{n(null);h("We could not refresh this account yet. Try again.");c(false)},history:(rows,pagination)=>{l(rows);x(previous=>({...previous,...pagination}));setHistoryStatus("ready");const oldest=rows[rows.length-1];g(oldest&&oldest.timestamp||null)},historyError:()=>{l([]);setHistoryStatus("unavailable");x(previous=>({...previous,total:null,total_pages:1}));g(null)}})},[e,m.page])'''
        text = span(text, 'v.useEffect(()=>{c(!0),Promise.all(', '},[e,m.page])', effect, 'independent account/history loading')
        text = one(text, 'return i?a.jsx("div",{className:"flex justify-center items-center min-h-[50vh]",children:a.jsx("div",{className:"animate-spin rounded-full h-12 w-12 border-b-2 border-brand-vibrant"})})', 'return i||lastAddress.current!==e?' + loading('Loading account…'), 'account loading message')
        text = one(text, 't?t.balance_xrs!==void 0?y(t.balance_xrs):y(t.balance/1e9):"0"', 't&&t.balance!=null?window.XerisExplorerFormat(t.balance,9,9):"—"', 'exact balance without fabricated zero')
        text = one(text, 'children:m.total>0?m.total.toLocaleString():(t==null?void 0:t.txCount)||r.length||0', 'children:historyStatus==="ready"&&Number.isSafeInteger(m.total)?m.total.toLocaleString():"—"', 'indexed history coverage')
        text = one(text, 'children:"Total Sent (visible)"', 'children:"Staked XRS"', 'account stake label')
        text = one(text, 'children:[s.sent.toLocaleString(void 0,{maximumFractionDigits:4})," XRS"]', 'children:[t&&t.stake!=null?window.XerisExplorerFormat(t.stake,9,9):"—",t&&t.stake!=null?" XRS":""]', 'account actual stake')
        text = one(text, 'children:"Total Received (visible)"', 'children:"Blocks Proposed"', 'account proposed label')
        text = one(text, 'children:[s.received.toLocaleString(void 0,{maximumFractionDigits:4})," XRS"]', 'children:t&&t.blocks_proposed!=null?String(t.blocks_proposed):"—"', 'account actual blocks')
        text = one(text, 'children:"First Seen"', 'children:"Oldest listed activity"', 'no fabricated first activity')
        text = one(text, 'children:w?new Date(w).toLocaleString():r.length===0?"No transactions":"Loading..."', 'children:w?new Date(w).toLocaleString():historyStatus==="loading"?"Loading…":historyStatus==="unavailable"?"—":r.length===0?"No indexed transactions":"—"', 'oldest listed activity state')
        text = one(text, 'a.jsx("span",{children:"No recent transactions found"})', 'historyStatus==="loading"?' + loading('Loading account history…') + ':a.jsx("span",{children:historyStatus==="unavailable"?"Account history is updating. Try again shortly.":"No indexed transactions found"})', 'history states')
        text = one(text, 'disabled:m.page===1||i', 'disabled:m.page===1||i||historyStatus==="loading"', 'history previous disabled while loading')
        text = one(text, 'disabled:m.page===m.total_pages||i', 'disabled:m.page===m.total_pages||i||historyStatus==="loading"', 'history next disabled while loading')
        text = one(text, 'children:[a.jsxs(A,{to:"/balances"', 'children:[u&&a.jsx("p",{role:"status",className:"text-text-dim mb-6",children:u}),a.jsxs(A,{to:"/balances"', 'account unavailable message')
        return text
    view('ov', 'iv', account)

    def transactions(text):
        text = one(text, 'function rv(){const[e,t]', 'function rv(){const[historyError,setHistoryError]=v.useState(null);const[e,t]', 'transaction history error state')
        effect = '''v.useEffect(()=>{r(true);t([]);setHistoryError(null);return window.XerisExplorerViews.loadTransactionsView(window.XerisExplorerAPI,l.page,{rows:(rows,pagination)=>{t(rows);s(previous=>({...previous,...pagination}));r(false)},error:()=>{t([]);r(false);setHistoryError("Recent transactions are updating. Try again shortly.")}})},[l.page])'''
        text = span(text, 'v.useEffect(()=>{r(!0),of(', '},[l.page])', effect, 'transaction page lifetime and enrichment')
        text = one(text, 'n?[...Array(10)].map((o,i)=>a.jsx("tr",{className:"animate-pulse",children:a.jsx("td",{colSpan:"6",className:"py-4 border-b border-white/5 h-12"})},i))', 'n?a.jsx("tr",{children:a.jsx("td",{colSpan:6,children:' + loading('Loading recent transactions…') + '})})', 'transaction loading message')
        text = one(text, 'children:"No transactions found in recent blocks."', 'children:historyError||"No transactions found in the retained block window."', 'transaction failure distinct from empty')
        text = one(text, 'o.timestamp?new Date(o.timestamp).toLocaleTimeString():a.jsx("span",{className:"animate-pulse",children:"..."})', 'o.timestamp?new Date(o.timestamp).toLocaleTimeString():"—"', 'timestamp not infinite loading')
        return text
    view('rv', 'ul', transactions)

    def home(text):
        text = one(text, 'function tv(){var d,f,p,k;', 'function tv(){var d,f,p,k;const[blocksStatus,setBlocksStatus]=v.useState("loading"),[statsStatus,setStatsStatus]=v.useState("loading"),[activityStatus,setActivityStatus]=v.useState("loading");', 'dashboard independent states')
        effect = '''v.useEffect(()=>{const loader=window.XerisExplorerViews.dashboardLoader(window.XerisExplorerAPI,{blocks:rows=>{t(rows);r(false);setBlocksStatus("ready");w(Date.now());y(0)},blocksError:()=>{r(false);setBlocksStatus(value=>value==="ready"||value==="stale"?"stale":"unavailable")},stats:value=>{s(value);setStatsStatus("ready")},statsError:()=>{setStatsStatus(value=>value==="ready"||value==="stale"?"stale":"unavailable")},transactions:rows=>{i(rows);setActivityStatus("ready")},transactionsError:()=>{setActivityStatus(value=>value==="ready"||value==="stale"?"stale":"unavailable")}});loader.refresh();const refresh=setInterval(()=>loader.refresh(),window.XerisExplorerAPI.network==="mainnet"?10000:30000),age=setInterval(()=>y(value=>value+1),1000);return()=>{loader.dispose();clearInterval(refresh);clearInterval(age)}},[])'''
        text = span(text, 'v.useEffect(()=>{const b=()=>{eg()', '},[])', effect, 'dashboard lifetime and refresh serialization')
        text = one(text, 'value:S.toLocaleString()', 'value:blocksStatus==="ready"||blocksStatus==="stale"?S.toLocaleString():"—"', 'no initial fake transaction zero')
        text = one(text, '||((p=(f=e[0])==null?void 0:f.slot)==null?void 0:p.toLocaleString())||"..."', '||((p=(f=e[0])==null?void 0:f.slot)==null?void 0:p.toLocaleString())||"—"', 'slot availability')
        text = one(text, 'value:l!=null&&l.total_staked?', 'value:l!=null&&l.total_staked!=null?', 'valid zero stake')
        text = one(text, 'n?[...Array(5)].map((b,C)=>a.jsx("tr",{className:"animate-pulse",children:a.jsx("td",{colSpan:"4",className:"py-4 border-b border-white/5 h-12"})},C))', 'n?a.jsx("tr",{children:a.jsx("td",{colSpan:4,children:' + loading('Loading recent blocks…') + '})})', 'blocks loading message')
        text = one(text, 'children:"Failed to load blocks. Backend update in progress..."', 'children:blocksStatus==="unavailable"?"Recent blocks are updating.":"No blocks found in the retained window."', 'blocks error distinct from empty')
        text = one(text, 'children:n?[...Array(3)].map((b,C)=>a.jsx("div",{className:"h-10 bg-brand-deep/20 animate-pulse rounded-sm"},C))', 'children:activityStatus==="loading"?' + loading('Loading recent activity…'), 'activity independent loading message')
        text = one(text, 'children:"Awaiting activity..."', 'children:activityStatus==="unavailable"?"Recent activity is updating.":"No recent activity in the retained window."', 'activity empty versus failed')
        return text
    view('tv', 'nv', home)

    def validators(text):
        text = one(text, 'v.useEffect(()=>{cf().then(o=>{t(o||[]),r(!1)}).catch(o=>{console.error(o),s("Failed to load validators"),r(!1)})},[])', 'v.useEffect(()=>{let alive=true;cf().then(rows=>{if(alive){t(rows);r(false)}}).catch(()=>{if(alive){s("Validators are updating. Try again shortly.");r(false)}});return()=>{alive=false}},[])', 'validator lifetime')
        text = one(text, 'children:"Active nodes securing the Xeris network."', 'children:"Validator identities and stake recorded on the selected network."', 'validator registry description')
        text = one(text, 'children:"Vote Credits"', 'children:"Blocks Proposed"', 'validator actual metric label')
        text = one(text, 'children:(o.vote_credits||0).toLocaleString()', 'children:o.blocks_proposed!=null?String(o.blocks_proposed):"—"', 'validator actual metric')
        text = one(text, 'children:(parseInt(o.stake||0)/1e9).toLocaleString(void 0,{maximumFractionDigits:0})', 'children:o.stake!=null?window.XerisExplorerFormat(o.stake,9,0):"—"', 'validator exact stake')
        text = span(text, 'children:o.active!==!1?', '}),a.jsx("td",{className:"py-4 text-right text-text-dim font-mono text-sm"', 'children:a.jsx("span",{className:"text-xs text-text-dim",children:"Stake recorded"})}),a.jsx("td",{className:"py-4 text-right text-text-dim font-mono text-sm"', 'no inferred validator liveness')
        return text
    view('mv', 'hv', validators)

    def analytics(text):
        text = one(text, 'function lv(){const[e,t]', 'function lv(){const[statsStatus,setStatsStatus]=v.useState("loading"),[validatorStatus,setValidatorStatus]=v.useState("loading");const[e,t]', 'analytics section status')
        effect = '''v.useEffect(()=>{let alive=true,busy=false;const update=()=>{if(!alive||busy)return;busy=true;sf().then(value=>{if(alive){t(value);setStatsStatus("ready")}}).catch(()=>{if(alive)setStatsStatus(value=>value==="ready"||value==="stale"?"stale":"unavailable")}).finally(()=>{busy=false})};update();cf().then(rows=>{if(alive){r(rows);setValidatorStatus("ready")}}).catch(()=>{if(alive)setValidatorStatus(value=>value==="ready"||value==="stale"?"stale":"unavailable")});const refresh=setInterval(update,10000),expiry=setInterval(()=>{if(alive)t(value=>value?Object.create(Object.getPrototypeOf(value),Object.getOwnPropertyDescriptors(value)):value)},1000);return()=>{alive=false;clearInterval(refresh);clearInterval(expiry)}},[])'''
        text = span(text, 'v.useEffect(()=>{const update=()=>sf()', '},[])', effect, 'analytics lifetime and nonoverlap')
        text = one(text, 'children:"Active Validators"', 'children:"Registered Validators"', 'registered validator label')
        text = one(text, 'children:n.filter(o=>o.active!==!1).length||n.length||"..."', 'children:validatorStatus==="ready"?n.length.toLocaleString():"—"', 'registered validator count')
        text = one(text, 'value:n.length.toString()', 'value:validatorStatus==="ready"?n.length.toString():"—"', 'listed validators availability')
        text = one(text, 'children:o.identity_pubkey?q(o.identity_pubkey).slice(0,10)+"...":"Validator "+(i+1)', 'children:o.address?q(o.address).slice(0,10)+"…":"—"', 'validator address field')
        text = one(text, 'children:["Vote: ",o.vote_account?q(o.vote_account).slice(0,8):"..."]', 'children:["Blocks proposed: ",o.blocks_proposed!=null?String(o.blocks_proposed):"—"]', 'analytics actual validator metric')
        text = one(text, '"Validating Ledger..."', 'validatorStatus==="loading"?"Loading registered validators…":validatorStatus==="unavailable"?"Validator list is updating":"No registered validators returned"', 'validator empty versus loading')
        text = one(text, 'e.tps_estimate.toFixed(1):e?"—":"..."', 'e.tps_estimate.toFixed(1):"—"', 'analytics TPS availability')
        return text
    view('lv', 'Xo', analytics)
    # Source explorer.rs:390-511,712-727: amount is not always native money.
    # Receipt-history types add one sent:/received: prefix (explorer.rs:1430).
    amount_before = 'function hs(e){const t=e.amount_xrs!==void 0&&e.amount_xrs!==null?e.amount_xrs:(e.amount||0)/1e9;return t===0&&!e.from?"—":t.toLocaleString(void 0,{maximumFractionDigits:9})+" XRS"}'
    amount_after = 'function XerisNativeAmount(raw){if(typeof raw!=="string"&&typeof raw!=="number"||typeof raw==="number"&&!Number.isSafeInteger(raw))return null;const text=String(raw);if(!/^(0|[1-9][0-9]*)$/.test(text)||text.length>20||BigInt(text)>18446744073709551615n)return null;return window.XerisExplorerFormat(text,9,9)+" XRS"}function hs(row){const kind=row&&typeof row.tx_type==="string"?row.tx_type.replace(/^(sent|received):/,""):"";return["native_transfer","legacy_transfer","stake","unstake"].includes(kind)?XerisNativeAmount(row.amount)||"—":"See details"}'
    code = one(code, amount_before, amount_after, 'asset-aware exact instruction amount')
    code = one(code, 'const f=d.tx_type==="received"||!d.tx_type&&d.to===e,p=d.tx_type==="sent"||!d.tx_type&&d.from===e,', 'const f=d.tx_type==="received"||d.tx_type?.startsWith("received:")||!d.tx_type&&d.to===e,p=d.tx_type==="sent"||d.tx_type?.startsWith("sent:")||!d.tx_type&&d.from===e,', 'indexed receipt direction prefixes')
    code = one(code, 'children:[f?"+":p?"−":"",hs(d)]', 'children:hs(d).endsWith(" XRS")?[f?"+":p?"−":"",hs(d)]:hs(d)', 'no signed unavailable amount labels')
    code = one(code, 'children:[(u.amount_xrs!==void 0?u.amount_xrs:u.amount/1e9).toLocaleString(void 0,{maximumFractionDigits:9})," XRS"]', 'children:hs(u)', 'block transaction asset denomination')
    code = one(code, 'children:[(((i=t==null?void 0:t.meta)==null?void 0:i.fee)||(t==null?void 0:t.fee)||1e6)/1e9," XRS"]', 'children:XerisNativeAmount(t?.meta?.fee??t?.fee)??"—"', 'reported fee only without fabricated default')

    # The original presentation treated a missing outcome as a green success.
    status_condition = '(t==null?void 0:t.status)==="confirmed"||(t==null?void 0:t.status)==="success"||!(t!=null&&t.status)?"text-green-400":"text-yellow-400"'
    status_color = 'window.XerisExplorerViews.transactionStatus(t?.status).color'
    def transaction_status(text):
        if text.count(status_condition) != 2:
            raise RuntimeError('Transaction outcome color boundaries changed')
        text = text.replace(status_condition, status_color)
        return one(text, 'children:(t==null?void 0:t.status)||"Unknown"', 'children:window.XerisExplorerViews.transactionStatus(t?.status).label', 'explicit transaction outcome labels')
    view('av', 'Xs', transaction_status)

    code = one(code, '(parseInt(o.max_supply||o.supply)/Math.pow(10,o.decimals||0)).toLocaleString()',
        'Number.isInteger(o.decimals)?window.XerisExplorerFormat(o.max_supply??o.supply,o.decimals,o.decimals):"—"', 'exact token maximum supply')
    code = one(code, 'const x=t.decimals||0,w=S=>(parseInt(S)/Math.pow(10,x)).toLocaleString(),',
        'const x=Number.isInteger(t.decimals)?t.decimals:null,w=S=>window.XerisExplorerFormat(S,x,x),', 'exact holder token balances')
    code = one(code, 'function Sc(e,t=9){return e?(Number(e)/Math.pow(10,t)).toLocaleString(void 0,{maximumFractionDigits:2}):"0"}',
        'function Sc(e,t){const known=Number.isInteger(t)&&t>=0&&t<=18;const amount=window.XerisExplorerFormat(e,known?t:0,known?t:0);return amount==="—"?"—":amount+(known?"":" raw units")}', 'no guessed pool precision')
    def pools(text):
        text = one(text, 'function pv(){const[e,t]', 'function pv(){const[poolError,setPoolError]=v.useState(false);const[e,t]', 'pool error state')
        text = span(text, 'v.useEffect(()=>{Promise.all([cg(),Ur()])', '},[])',
            'v.useEffect(()=>window.XerisExplorerViews.loadPoolsView(window.XerisExplorerAPI,{pools:rows=>{t(rows);s(false);setPoolError(false)},error:()=>{t([]);s(false);setPoolError(true)},decimals:r}),[])', 'independent pool and metadata reads')
        text = one(text, 'Sc(o.reserve_a,n[o.token_a]||9)', 'Sc(o.reserve_a,n[o.token_a])', 'pool A precision')
        text = one(text, 'Sc(o.reserve_b,n[o.token_b]||6)', 'Sc(o.reserve_b,n[o.token_b])', 'pool B precision')
        text = one(text, 'l?[...Array(3)].map((o,i)=>a.jsx("div",{className:"glass-card h-32 animate-pulse"},i))', 'l?' + loading('Loading pools…'), 'named pool loading state')
        text = one(text, 'children:"No Pools Found"', 'children:poolError?"Pools are updating":"No Pools Found"', 'pool failure distinct from empty')
        text = one(text, 'children:"There are currently no active liquidity pools on the network."', 'children:poolError?"Try again shortly while the explorer refreshes pool records.":"No pool records were returned for this network."', 'pool coverage wording')
        return text
    view('pv', 'mv', pools)

    fallback = 'a.jsx(Ce,{path:"*",element:a.jsxs("main",{className:"connection-panel",children:[a.jsx("h1",{children:"Page not found"}),a.jsx("p",{children:"Check the address or return to the overview."}),a.jsx(A,{to:"/",children:"Back to overview"})]})})'
    code = one(code, 'a.jsx(Ce,{path:"/validators",element:a.jsx(mv,{})})]})', 'a.jsx(Ce,{path:"/validators",element:a.jsx(mv,{})}),' + fallback + ']})', 'unknown-route recovery')
    # Keep the skip/focus destination after Navigation, including routes whose
    # initial loading output is a div rather than a main landmark.
    layout_start = code.index('function hv(){')
    layout_end = code.index('Gs.createRoot(', layout_start)
    layout = code[layout_start:layout_end]
    layout = one(layout, 'children:[a.jsx(ev,{}),a.jsxs(Wh,{children:[',
        'children:[a.jsx(ev,{}),a.jsx("section",{id:"explorer-content",tabIndex:-1,"aria-label":"Explorer content",children:a.jsxs(Wh,{children:[',
        'stable route content after navigation')
    layout = one(layout, ']})]})})}', ']})})]})})}', 'stable route content close')
    code = code[:layout_start] + layout + code[layout_end:]
    boundary = 'class XerisExplorerBoundary extends v.Component{constructor(props){super(props);this.state={failed:false}}static getDerivedStateFromError(){return{failed:true}}render(){return this.state.failed?a.jsxs("main",{className:"connection-panel",role:"alert",children:[a.jsx("h1",{children:"This view could not be displayed"}),a.jsx("p",{children:"Please retry the page or return to the overview. No other network was selected."}),a.jsx("button",{type:"button",onClick:()=>location.reload(),children:"Retry page"}),a.jsx("a",{href:"/?network="+window.XerisExplorerAPI.network,children:"Back to overview"})]}):this.props.children}}'
    boundary = boundary.replace('className:"connection-panel",role:"alert"', 'id:"explorer-content",tabIndex:-1,className:"connection-panel",role:"alert"')
    mount = 'Gs.createRoot(document.getElementById("root")).render(a.jsx(Fc.StrictMode,{children:a.jsx(hv,{})}));'
    code = one(code, mount, boundary + 'Gs.createRoot(document.getElementById("root")).render(a.jsx(Fc.StrictMode,{children:a.jsx(XerisExplorerBoundary,{children:a.jsx(hv,{})})}));', 'render failure recovery boundary')
    code, mainnet_assertions = repair_mainnet_views(code)
    return code, asserted + mainnet_assertions


def repair_mainnet_views(code):
    """Small asserted presentation fixes, also independently testable in memory."""
    asserted = 0

    def one(text, before, after, label):
        nonlocal asserted
        count = text.count(before)
        if count != 1:
            raise RuntimeError(f'{label}: expected one match, found {count}')
        asserted += 1
        return text.replace(before, after, 1)

    def view(name, following, transform):
        nonlocal code
        start, end = f'function {name}(', f'function {following}('
        if code.count(start) != 1 or code.count(end) != 1:
            raise RuntimeError(f'{name}: view boundary changed')
        left, right = code.index(start), code.index(end, code.index(start))
        code = code[:left] + transform(code[left:right]) + code[right:]

    def loading(message):
        return 'a.jsxs("div",{className:"view-loading",role:"status","aria-live":"polite",children:[a.jsx("span",{className:"loading-circle","aria-hidden":true}),a.jsx("span",{children:"' + message + '"})]})'

    code, account_assertions = repair_accounts_view(code)
    asserted += account_assertions

    def registry(text, name, call, label):
        text = one(text, f'function {name}(){{const[e,t]', f'function {name}(){{const[listAttempt,setListAttempt]=v.useState(0);const[e,t]', label + ' retry state')
        text = one(text, f'v.useEffect(()=>{{{call}().then(o=>{{t(o||[]),r(!1)}}).catch(o=>{{console.error(o),s("Failed to fetch {label}"),r(!1)}})}},[])',
            f'v.useEffect(()=>{{let alive=true;r(true);s(null);Promise.resolve().then(()=>{call}()).then(rows=>{{if(alive){{t(rows);r(false)}}}}).catch(()=>{{if(alive){{s("{label.capitalize()} are updating. Try again shortly.");r(false)}}}});return()=>{{alive=false}}}},[listAttempt])', label + ' lifetime and retry')
        text = one(text, f'a.jsx("div",{{className:"text-white text-center py-20",children:"Loading {label}..."}})', loading('Loading ' + label + '…'), label + ' named loading')
        text = one(text, 'a.jsx("div",{className:"text-red-400 text-center py-20",children:l})', 'a.jsxs("div",{className:"text-center py-20",children:[a.jsx("p",{role:"status",className:"text-red-400",children:l}),a.jsx("button",{type:"button",className:"mt-4 text-brand-vibrant hover:underline",onClick:()=>setListAttempt(value=>value+1),children:"Retry ' + label + '"})]})', label + ' retry control')
        return text
    view('iv', 'cv', lambda text: registry(text, 'iv', 'Ur', 'tokens'))
    view('uv', 'dv', lambda text: registry(text, 'uv', 'ag', 'contracts'))

    helpers = '''function XerisOwnerAddress(value){if(typeof value!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let number=0n;for(const char of value)number=number*58n+BigInt(alphabet.indexOf(char));return value.match(/^1*/)[0].length+(number===0n?0:Math.ceil(number.toString(16).length/2))===32}
function XerisRawUnits(value){const text=window.XerisExplorerFormat(value,0,0);return text==="—"?"—":text+" raw units"}
function XerisPoolFee(value){return Number.isInteger(value)&&value>=0&&value<10000?(value/100).toFixed(2)+"%":"—"}
function XerisPoolPrice(pool,decimals){const a=decimals[pool.token_a],b=decimals[pool.token_b];if(![a,b].every(value=>Number.isInteger(value)&&value>=0&&value<=18)||window.XerisExplorerFormat(pool.reserve_a,0,0)==="—"||window.XerisExplorerFormat(pool.reserve_b,0,0)==="—")return"—";const denominator=BigInt(pool.reserve_a)*10n**BigInt(b),numerator=BigInt(pool.reserve_b)*10n**BigInt(a);if(denominator===0n)return"—";const scaled=numerator*1000000n/denominator;if(scaled===0n&&numerator>0n)return"<0.000001";const whole=scaled/1000000n,fraction=(scaled%1000000n).toString().padStart(6,"0").replace(/0+$/,"");return whole.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,",")+(fraction?"."+fraction:"")}
'''
    code = one(code, 'function iv(){', helpers + 'function iv(){', 'bounded owner and exact amount helpers')

    def contract_list(text):
        text = one(text, 'children:o.contract_type||o.type', 'children:o.raw_contract_type||o.contract_type||o.type||"—"', 'actual contract list type')
        owner = 'a.jsx(A,{to:`/account/${o.owner}`,className:"hover:text-brand-accent transition-colors",children:o.owner})'
        return one(text, owner, 'XerisOwnerAddress(o.owner)?' + owner + ':a.jsx("span",{children:o.owner||"—"})', 'reserved contract list owner')
    view('uv', 'dv', contract_list)

    def contract_detail(text):
        text = one(text, 'children:t.contract_type||t.type', 'children:t.raw_contract_type||t.contract_type||t.type||"—"', 'actual contract detail type')
        owner = 'a.jsx(A,{to:`/account/${t.owner}`,className:"text-brand-vibrant font-mono break-all hover:underline",children:t.owner})'
        text = one(text, owner, 'XerisOwnerAddress(t.owner)?' + owner + ':a.jsx("span",{className:"font-mono break-all",children:t.owner||"—"})', 'reserved contract detail owner')
        text = one(text, 'parseInt(((x=t.params)==null?void 0:x.reserve_a)||((w=t.state)==null?void 0:w.reserve_a)||0).toLocaleString()', 'XerisRawUnits(t.params?.reserve_a??t.state?.reserve_a)', 'exact contract reserve A')
        text = one(text, 'parseInt(((g=t.params)==null?void 0:g.reserve_b)||((y=t.state)==null?void 0:y.reserve_b)||0).toLocaleString()', 'XerisRawUnits(t.params?.reserve_b??t.state?.reserve_b)', 'exact contract reserve B')
        text = one(text, '`${((((S=t.params)==null?void 0:S.fee_bps)||((d=t.state)==null?void 0:d.fee_bps)||30)/100).toFixed(2)}%`', 'XerisPoolFee(t.params?.fee_bps??t.state?.fee_bps)', 'valid zero contract fee')
        text = one(text, 'a.jsxs("div",{className:"mt-6 pt-6 border-t border-brand-muted/10",children:[a.jsx("div",{className:"text-[10px] text-text-dim uppercase mb-2",children:"Raw Data"})', 'a.jsxs("details",{className:"mt-6 pt-6 border-t border-brand-muted/10",children:[a.jsx("summary",{className:"text-xs text-text-dim uppercase mb-2 cursor-pointer",children:"Raw contract state"})', 'collapsible raw contract data')
        text = one(text, 'JSON.stringify(t.params||t.state||{},null,2)', 'JSON.stringify({params:t.params??null,state:t.state??null},null,2)', 'retain complete public contract state')
        return text
    view('dv', 'fv', contract_detail)

    def account_status(text):
        text = one(text, 'k=!d.error&&d.status!=="failed"', 'k=window.XerisExplorerViews.transactionStatus(d.status??(d.error?"failed":undefined))', 'account transaction explicit outcome')
        return one(text, 'className:`w-1.5 h-1.5 rounded-full flex-shrink-0 ${k?"bg-green-400":"bg-red-400"}`,title:k?"Success":"Failed"', 'className:`w-1.5 h-1.5 rounded-full flex-shrink-0 ${k.color}`,style:{backgroundColor:"currentColor"},title:k.label,"aria-label":k.label', 'account unknown and partial outcome labels')
    view('ov', 'XerisOwnerAddress', account_status)
    view('pv', 'mv', lambda text: one(text, '(parseFloat(o.price_a_in_b)*Math.pow(10,(n[o.token_a]||9)-(n[o.token_b]||6))).toLocaleString(void 0,{maximumFractionDigits:6})', 'XerisPoolPrice(o,n)', 'exact pool price requires known decimals'))
    return code, asserted


def repair_accounts_view(code):
    """Replace only the recovered Accounts view and its account return label."""
    start, end = 'function nv(', 'function rv('
    if code.count(start) != 1 or code.count(end) != 1:
        raise RuntimeError('Accounts component boundaries changed')
    left, right = code.index(start), code.index(end, code.index(start))
    original = code[left:right]
    if original.count('Rich List') != 1 or original.count('Top Holder') != 1:
        raise RuntimeError('Expected original Accounts heading before replacement')
    replacement = r'''
function XerisCopyPublicIdentifier({value,label="Copy"}){
  const[state,setState]=v.useState("idle");
  const copy=async()=>{try{if(!navigator.clipboard?.writeText)throw Error("Clipboard unavailable");await navigator.clipboard.writeText(String(value));setState("copied");setTimeout(()=>setState("idle"),1800)}catch{setState("error");setTimeout(()=>setState("idle"),2200)}};
  const text=state==="copied"?"Copied":state==="error"?"Try again":label;
  return v.createElement("button",{type:"button",className:"accounts-copy",onClick:copy,"aria-label":label+" "+value,"aria-live":"polite"},text)
}
function nv(){
  const api=window.XerisExplorerAPI,views=window.XerisExplorerViews,h=v.createElement;
  const[balances,setBalances]=v.useState({}),[ready,setReady]=v.useState(false),[busy,setBusy]=v.useState(true),[error,setError]=v.useState(null);
  const[query,setQuery]=v.useState(""),[sort,setSort]=v.useState({key:"age",direction:"asc"}),[page,setPage]=v.useState(1),[refresh,setRefresh]=v.useState(0);
  const[ages,setAges]=v.useState({data:[],basis:"unavailable",truncated:false}),[ageStatus,setAgeStatus]=v.useState(api.network==="mainnet"?"loading":"unavailable");
  const[quote,setQuote]=v.useState(null),[priceStatus,setPriceStatus]=v.useState(api.network==="mainnet"?"loading":"unavailable"),[,setClock]=v.useState(0);
  const ageRequest=v.useRef(null),priceRequest=v.useRef(null);
  const shared=(reference,read)=>{
    if(!reference.current){
      const task=Promise.resolve().then(read);reference.current=task;
      task.then(()=>{if(reference.current===task)reference.current=null},()=>{if(reference.current===task)reference.current=null});
    }
    return reference.current;
  };
  v.useEffect(()=>{
    let alive=true;setBusy(true);setError(null);
    Promise.resolve().then(()=>api.balances()).then(rows=>{
      if(alive){setBalances(rows);setReady(true);setBusy(false)}
    }).catch(()=>{if(alive){setError("We could not refresh accounts yet. Try again.");setBusy(false)}});
    return()=>{alive=false};
  },[refresh]);
  v.useEffect(()=>{
    if(api.network!=="mainnet")return;
    let alive=true;setAgeStatus("loading");
    shared(ageRequest,()=>api.accountAges()).then(value=>{
      if(alive){setAges(value);setAgeStatus("ready")}
    }).catch(()=>{if(alive){setAges({data:[],basis:"unavailable",truncated:false});setAgeStatus("error")}});
    return()=>{alive=false};
  },[refresh]);
  v.useEffect(()=>{
    if(api.network!=="mainnet")return;
    let alive=true,reading=false;
    const update=()=>{
      if(!alive||reading)return;reading=true;setPriceStatus("loading");
      shared(priceRequest,()=>api.accountPrice()).then(value=>{
        if(alive){setQuote(value);setPriceStatus(value?"ready":"unavailable")}
      }).catch(cause=>{if(alive){if(cause?.retryable!==true)setQuote(null);setPriceStatus("error")}}).finally(()=>{reading=false});
    };
    update();const timer=setInterval(update,10000),clock=setInterval(()=>{if(alive)setClock(value=>value+1)},1000);
    return()=>{alive=false;clearInterval(timer);clearInterval(clock)};
  },[refresh]);
  const entries=Object.entries(balances),filtered=entries.filter(([account])=>account.toLowerCase().includes(query.trim().toLowerCase()));
  const sorted=views.sortAccounts(filtered,ages.data,sort.key,sort.direction),pages=Math.max(1,Math.ceil(sorted.length/50)),currentPage=Math.min(page,pages);
  const visible=sorted.slice((currentPage-1)*50,currentPage*50),ageMap=new Map(ages.data.map(value=>[value.address,value]));
  const priced=views.accountUSD("0",quote,Date.now())!==null;
  const chooseSort=key=>{setSort(previous=>({key,direction:previous.key===key?(previous.direction==="asc"?"desc":"asc"):key==="balance"?"desc":"asc"}));setPage(1)};
  const indicator=key=>sort.key===key?(sort.direction==="asc"?" ↑":" ↓"):"";
  const loading=label=>h("div",{className:"view-loading",role:"status","aria-live":"polite"},h("span",{className:"loading-circle","aria-hidden":true}),h("span",null,label));
  const metadata=(kind,status,message)=>h("p",{className:"accounts-metadata-status",role:"status","data-source":kind},
    status==="loading"&&h("span",{className:"loading-circle","aria-hidden":true}),message);
  const ageMessage=api.network==="mainnet"&&ages.truncated?"First-recorded coverage is still expanding; newer accounts appear after indexed records.":null;
  const priceMessage=null;
  const sortHeader=(key,label,className)=>h("th",{scope:"col",className:"data-table-header "+className,"aria-sort":sort.key===key?(sort.direction==="asc"?"ascending":"descending"):"none"},
    h("button",{type:"button",className:"accounts-sort",onClick:()=>chooseSort(key)},label,indicator(key)));
  return h("main",{className:"accounts-view max-w-7xl mx-auto px-10 pt-16"},
    h("div",{className:"accounts-heading"},h("div",null,h("h1",{className:"text-4xl mb-2 text-white"},"Accounts"),
      h("p",{className:"text-text-dim"},"Native XRS balances on the selected network.")),
      h("label",{className:"accounts-search"},h("span",null,"Search accounts"),h("input",{type:"search",value:query,placeholder:"Search an address",maxLength:128,
        autoComplete:"off",spellCheck:false,onChange:event=>{setQuery(event.target.value);setPage(1)}}))),
    h("div",{className:"accounts-toolbar"},h("p",{className:"text-text-dim"},ready?entries.length.toLocaleString()+" accounts":"Network accounts"),
      h("button",{type:"button",className:"accounts-refresh",disabled:busy,onClick:()=>setRefresh(value=>value+1)},error?"Retry accounts":"Refresh accounts")),
    h("label",{className:"accounts-mobile-sort"},h("span",null,"Sort accounts"),
      h("select",{value:sort.key+":"+sort.direction,"aria-label":"Sort accounts",onChange:event=>{
        const[key,direction]=event.target.value.split(":");setSort({key,direction});setPage(1)}},
        h("option",{value:"age:asc"},"Oldest recorded first"),h("option",{value:"age:desc"},"Newest recorded first"),
        h("option",{value:"balance:desc"},"Highest balance first"),h("option",{value:"balance:asc"},"Lowest balance first"),
        h("option",{value:"address:asc"},"Address A–Z"),h("option",{value:"address:desc"},"Address Z–A"))),
    ready&&error&&h("p",{role:"status",className:"accounts-retained"},"Showing the latest saved account data."),
    h("div",{className:"accounts-metadata"},ageMessage&&metadata("ages",ageStatus,ageMessage),priceMessage&&metadata("price",priceStatus,priceMessage)),
    h("section",{className:"glass-card accounts-card","aria-label":"Accounts and balances"},
      h("div",{className:"accounts-table-wrap"},h("table",{className:"accounts-table"},
        h("thead",null,h("tr",null,sortHeader("address","Account","accounts-address-heading"),sortHeader("age","First recorded",""),
          sortHeader("balance","Balance (XRS)","accounts-number"),h("th",{scope:"col",className:"data-table-header accounts-number"},"Est. value (USD)"))),
        h("tbody",null,busy&&!ready?h("tr",null,h("td",{colSpan:4},loading("Loading accounts…"))):
          visible.length?visible.map(([account,raw])=>{
            const age=ageMap.get(account),usd=views.accountUSD(raw,quote,Date.now());
            return h("tr",{key:account,className:"data-table-row"},
              h("td",{className:"accounts-address","data-label":"Account"},h("div",{className:"accounts-account-control"},h(A,{to:"/account/"+account,className:"font-mono hover:underline",title:account},account),h(XerisCopyPublicIdentifier,{value:account,label:"Copy account address"}))),
              h("td",{className:"accounts-first-seen","data-label":"First recorded"},age?views.accountFirstSeen(age):"—"),
              h("td",{className:"accounts-number accounts-balance","data-label":"Balance (XRS)"},window.XerisExplorerFormat(raw,9,9),h("span",{className:"accounts-unit"}," XRS")),
              h("td",{className:"accounts-number accounts-usd","data-label":"Est. value (USD)"},usd??"—"));
          }):h("tr",null,h("td",{colSpan:4,className:"accounts-empty",role:"status"},error||(query?"No accounts match this search.":"No accounts are indexed yet.")))))),
      ready&&h("div",{className:"accounts-pagination"},h("span",null,sorted.length?`${(currentPage-1)*50+1}–${Math.min(currentPage*50,sorted.length)} of ${sorted.length} matching accounts`:"0 matching accounts"),
        pages>1&&h("div",null,h("button",{type:"button",disabled:currentPage<=1,onClick:()=>setPage(currentPage-1)},"Previous accounts"),
          h("span",null,`Page ${currentPage} of ${pages}`),h("button",{type:"button",disabled:currentPage>=pages,onClick:()=>setPage(currentPage+1)},"Next accounts")))),
    api.network==="mainnet"&&h("p",{className:"accounts-price-note"},"Estimated at the current pool price, with xUSDC valued at US$1. Actual trade proceeds vary with fees and price impact."),
    h("p",{className:"accounts-coverage-note"},"Network accounts ordered by first recorded activity.")
  );
}
'''
    code = code[:left] + replacement + code[right:]
    if code.count(' Back to Rich List') != 1:
        raise RuntimeError('Expected one account return link label')
    code = code.replace(' Back to Rich List', ' Back to Accounts', 1)
    return code, 2
