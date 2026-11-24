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
        new = f'v.useEffect(()=>{{let alive=true;n(null);l(true);o(null);{call}(e).then(value=>{{if(alive){{n(value);l(false);if(!value)o("{label.capitalize()} record unavailable")}}}}).catch(()=>{{if(alive){{o("{label.capitalize()} details are unavailable. Please retry.");l(false)}}}});return()=>{{alive=false}}}},[e])'
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
        effect = '''v.useEffect(()=>{const changed=lastAddress.current!==e;if(changed){lastAddress.current=e;n(null);c(true);h(null);l([]);g(null);setHistoryStatus("loading");x({page:1,total_pages:1,total:null});if(m.page!==1)return}h(null);l([]);g(null);setHistoryStatus("loading");return window.XerisExplorerViews.loadAccountView(window.XerisExplorerAPI,e,m.page,{account:value=>{n(value);c(false)},accountError:()=>{n(null);h("Account balance is unavailable. Please retry.");c(false)},history:(rows,pagination)=>{l(rows);x(previous=>({...previous,...pagination}));setHistoryStatus("ready");const oldest=rows[rows.length-1];g(oldest&&oldest.timestamp||null)},historyError:()=>{l([]);setHistoryStatus("unavailable");x(previous=>({...previous,total:null,total_pages:1}));g(null)}})},[e,m.page])'''
        text = span(text, 'v.useEffect(()=>{c(!0),Promise.all(', '},[e,m.page])', effect, 'independent account/history loading')
        text = one(text, 'return i?a.jsx("div",{className:"flex justify-center items-center min-h-[50vh]",children:a.jsx("div",{className:"animate-spin rounded-full h-12 w-12 border-b-2 border-brand-vibrant"})})', 'return i||lastAddress.current!==e?' + loading('Loading account…'), 'account loading message')
        text = one(text, 't?t.balance_xrs!==void 0?y(t.balance_xrs):y(t.balance/1e9):"0"', 't&&t.balance!=null?window.XerisExplorerFormat(t.balance,9,9):"Unavailable"', 'exact balance without fabricated zero')
        text = one(text, 'children:m.total>0?m.total.toLocaleString():(t==null?void 0:t.txCount)||r.length||0', 'children:historyStatus==="ready"&&Number.isSafeInteger(m.total)?m.total.toLocaleString():historyStatus==="loading"?"Loading…":"Unavailable"', 'indexed history coverage')
        text = one(text, 'children:"Total Sent (visible)"', 'children:"Staked XRS"', 'account stake label')
        text = one(text, 'children:[s.sent.toLocaleString(void 0,{maximumFractionDigits:4})," XRS"]', 'children:[t&&t.stake!=null?window.XerisExplorerFormat(t.stake,9,9):"Unavailable",t&&t.stake!=null?" XRS":""]', 'account actual stake')
        text = one(text, 'children:"Total Received (visible)"', 'children:"Blocks Proposed"', 'account proposed label')
        text = one(text, 'children:[s.received.toLocaleString(void 0,{maximumFractionDigits:4})," XRS"]', 'children:t&&t.blocks_proposed!=null?String(t.blocks_proposed):"Unavailable"', 'account actual blocks')
        text = one(text, 'children:"First Seen"', 'children:"Oldest listed activity"', 'no fabricated first activity')
        text = one(text, 'children:w?new Date(w).toLocaleString():r.length===0?"No transactions":"Loading..."', 'children:w?new Date(w).toLocaleString():historyStatus==="loading"?"Loading…":historyStatus==="unavailable"?"Unavailable":r.length===0?"No indexed transactions":"Timestamp unavailable"', 'oldest listed activity state')
        text = one(text, 'a.jsx("span",{children:"No recent transactions found"})', 'historyStatus==="loading"?' + loading('Loading account history…') + ':a.jsx("span",{children:historyStatus==="unavailable"?"Account history is unavailable. Please retry.":"No indexed transactions found"})', 'history states')
        text = one(text, 'disabled:m.page===1||i', 'disabled:m.page===1||i||historyStatus==="loading"', 'history previous disabled while loading')
        text = one(text, 'disabled:m.page===m.total_pages||i', 'disabled:m.page===m.total_pages||i||historyStatus==="loading"', 'history next disabled while loading')
        text = one(text, 'children:[a.jsxs(A,{to:"/balances"', 'children:[u&&a.jsx("p",{role:"status",className:"text-text-dim mb-6",children:u}),a.jsxs(A,{to:"/balances"', 'account unavailable message')
        return text
    view('ov', 'iv', account)

    def transactions(text):
        text = one(text, 'function rv(){const[e,t]', 'function rv(){const[historyError,setHistoryError]=v.useState(null);const[e,t]', 'transaction history error state')
        effect = '''v.useEffect(()=>{r(true);t([]);setHistoryError(null);return window.XerisExplorerViews.loadTransactionsView(window.XerisExplorerAPI,l.page,{rows:(rows,pagination)=>{t(rows);s(previous=>({...previous,...pagination}));r(false)},error:()=>{t([]);r(false);setHistoryError("Recent transaction data is unavailable. Please retry.")}})},[l.page])'''
        text = span(text, 'v.useEffect(()=>{r(!0),of(', '},[l.page])', effect, 'transaction page lifetime and enrichment')
        text = one(text, 'n?[...Array(10)].map((o,i)=>a.jsx("tr",{className:"animate-pulse",children:a.jsx("td",{colSpan:"6",className:"py-4 border-b border-white/5 h-12"})},i))', 'n?a.jsx("tr",{children:a.jsx("td",{colSpan:6,children:' + loading('Loading recent transactions…') + '})})', 'transaction loading message')
        text = one(text, 'children:"No transactions found in recent blocks."', 'children:historyError||"No transactions found in the retained block window."', 'transaction failure distinct from empty')
        text = one(text, 'o.timestamp?new Date(o.timestamp).toLocaleTimeString():a.jsx("span",{className:"animate-pulse",children:"..."})', 'o.timestamp?new Date(o.timestamp).toLocaleTimeString():"Unavailable"', 'timestamp not infinite loading')
        return text
    view('rv', 'ul', transactions)

    def home(text):
        text = one(text, 'function tv(){var d,f,p,k;', 'function tv(){var d,f,p,k;const[blocksStatus,setBlocksStatus]=v.useState("loading"),[statsStatus,setStatsStatus]=v.useState("loading"),[activityStatus,setActivityStatus]=v.useState("loading");', 'dashboard independent states')
        effect = '''v.useEffect(()=>{const loader=window.XerisExplorerViews.dashboardLoader(window.XerisExplorerAPI,{blocks:rows=>{t(rows);r(false);setBlocksStatus("ready");w(Date.now());y(0)},blocksError:()=>{t([]);r(false);setBlocksStatus("unavailable");w(null)},stats:value=>{s(value);setStatsStatus("ready")},statsError:()=>{s(null);setStatsStatus("unavailable")},transactions:rows=>{i(rows);setActivityStatus("ready")},transactionsError:()=>{i([]);setActivityStatus("unavailable")}});loader.refresh();const refresh=setInterval(()=>loader.refresh(),window.XerisExplorerAPI.network==="mainnet"?10000:30000),age=setInterval(()=>y(value=>value+1),1000);return()=>{loader.dispose();clearInterval(refresh);clearInterval(age)}},[])'''
        text = span(text, 'v.useEffect(()=>{const b=()=>{eg()', '},[])', effect, 'dashboard lifetime and refresh serialization')
        text = one(text, 'value:S.toLocaleString()', 'value:blocksStatus==="ready"?S.toLocaleString():blocksStatus==="loading"?"Loading…":"Unavailable"', 'no initial fake transaction zero')
        text = one(text, '||((p=(f=e[0])==null?void 0:f.slot)==null?void 0:p.toLocaleString())||"..."', '||((p=(f=e[0])==null?void 0:f.slot)==null?void 0:p.toLocaleString())||(statsStatus==="loading"?"Loading…":"Unavailable")', 'slot availability')
        text = one(text, 'value:window.XerisExplorerAPI.network==="testnet"?((l==null?void 0:l.total_accounts)??"..."):l!=null&&l.circulating_supply?`${(l.circulating_supply/1e15).toFixed(1)}M`:l?"Unavailable":"..."', 'value:window.XerisExplorerAPI.network==="testnet"?((l==null?void 0:l.total_accounts)??(statsStatus==="loading"?"Loading…":"Unavailable")):l!=null&&l.circulating_supply?`${(l.circulating_supply/1e15).toFixed(1)}M`:statsStatus==="loading"?"Loading…":"Unavailable"', 'supply/account unavailable state')
        text = one(text, 'value:l!=null&&l.total_staked?', 'value:l!=null&&l.total_staked!=null?', 'valid zero stake')
        text = one(text, 'n?[...Array(5)].map((b,C)=>a.jsx("tr",{className:"animate-pulse",children:a.jsx("td",{colSpan:"4",className:"py-4 border-b border-white/5 h-12"})},C))', 'n?a.jsx("tr",{children:a.jsx("td",{colSpan:4,children:' + loading('Loading recent blocks…') + '})})', 'blocks loading message')
        text = one(text, 'children:"Failed to load blocks. Backend update in progress..."', 'children:blocksStatus==="unavailable"?"Recent blocks are unavailable. Please retry.":"No blocks found in the retained window."', 'blocks error distinct from empty')
        text = one(text, 'children:n?[...Array(3)].map((b,C)=>a.jsx("div",{className:"h-10 bg-brand-deep/20 animate-pulse rounded-sm"},C))', 'children:activityStatus==="loading"?' + loading('Loading recent activity…'), 'activity independent loading message')
        text = one(text, 'children:"Awaiting activity..."', 'children:activityStatus==="unavailable"?"Recent activity is unavailable. Please retry.":"No recent activity in the retained window."', 'activity empty versus failed')
        return text
    view('tv', 'nv', home)

    def validators(text):
        text = one(text, 'v.useEffect(()=>{cf().then(o=>{t(o||[]),r(!1)}).catch(o=>{console.error(o),s("Failed to load validators"),r(!1)})},[])', 'v.useEffect(()=>{let alive=true;cf().then(rows=>{if(alive){t(rows);r(false)}}).catch(()=>{if(alive){s("Validator data is unavailable. Please retry.");r(false)}});return()=>{alive=false}},[])', 'validator lifetime')
        text = one(text, 'children:"Active nodes securing the Xeris network."', 'children:"Validator identities and stake recorded on the selected network."', 'validator registry description')
        text = one(text, 'children:"Vote Credits"', 'children:"Blocks Proposed"', 'validator actual metric label')
        text = one(text, 'children:(o.vote_credits||0).toLocaleString()', 'children:o.blocks_proposed!=null?String(o.blocks_proposed):"Unavailable"', 'validator actual metric')
        text = one(text, 'children:(parseInt(o.stake||0)/1e9).toLocaleString(void 0,{maximumFractionDigits:0})', 'children:o.stake!=null?window.XerisExplorerFormat(o.stake,9,0):"Unavailable"', 'validator exact stake')
        text = span(text, 'children:o.active!==!1?', '}),a.jsx("td",{className:"py-4 text-right text-text-dim font-mono text-sm"', 'children:a.jsx("span",{className:"text-xs text-text-dim",children:"Stake recorded"})}),a.jsx("td",{className:"py-4 text-right text-text-dim font-mono text-sm"', 'no inferred validator liveness')
        return text
    view('mv', 'hv', validators)

    def analytics(text):
        text = one(text, 'function lv(){const[e,t]', 'function lv(){const[statsStatus,setStatsStatus]=v.useState("loading"),[validatorStatus,setValidatorStatus]=v.useState("loading");const[e,t]', 'analytics section status')
        effect = '''v.useEffect(()=>{let alive=true,busy=false;const update=()=>{if(!alive||busy)return;busy=true;sf().then(value=>{if(alive){t(value);setStatsStatus("ready")}}).catch(()=>{if(alive){t(null);setStatsStatus("unavailable")}}).finally(()=>{busy=false})};update();cf().then(rows=>{if(alive){r(rows);setValidatorStatus("ready")}}).catch(()=>{if(alive){r([]);setValidatorStatus("unavailable")}});const refresh=setInterval(update,10000),expiry=setInterval(()=>{if(alive)t(value=>value?Object.create(Object.getPrototypeOf(value),Object.getOwnPropertyDescriptors(value)):value)},1000);return()=>{alive=false;clearInterval(refresh);clearInterval(expiry)}},[])'''
        text = span(text, 'v.useEffect(()=>{const update=()=>sf()', '},[])', effect, 'analytics lifetime and nonoverlap')
        text = one(text, 'children:"Active Validators"', 'children:"Registered Validators"', 'registered validator label')
        text = one(text, 'children:n.filter(o=>o.active!==!1).length||n.length||"..."', 'children:validatorStatus==="ready"?n.length.toLocaleString():validatorStatus==="loading"?"Loading…":"Unavailable"', 'registered validator count')
        text = one(text, 'value:n.length.toString()', 'value:validatorStatus==="ready"?n.length.toString():validatorStatus==="loading"?"Loading…":"Unavailable"', 'listed validators availability')
        text = one(text, 'children:o.identity_pubkey?q(o.identity_pubkey).slice(0,10)+"...":"Validator "+(i+1)', 'children:o.address?q(o.address).slice(0,10)+"…":"Address unavailable"', 'validator address field')
        text = one(text, 'children:["Vote: ",o.vote_account?q(o.vote_account).slice(0,8):"..."]', 'children:["Blocks proposed: ",o.blocks_proposed!=null?String(o.blocks_proposed):"Unavailable"]', 'analytics actual validator metric')
        text = one(text, '"Validating Ledger..."', 'validatorStatus==="loading"?"Loading registered validators…":validatorStatus==="unavailable"?"Validator data is unavailable":"No registered validators returned"', 'validator empty versus loading')
        text = one(text, 'e.tps_estimate.toFixed(1):e?"—":"..."', 'e.tps_estimate.toFixed(1):statsStatus==="loading"?"Loading…":"Unavailable"', 'analytics TPS availability')
        return text
    view('lv', 'Xo', analytics)
    # Source explorer.rs:390-511,712-727: amount is not always native money.
    # Receipt-history types add one sent:/received: prefix (explorer.rs:1430).
    amount_before = 'function hs(e){const t=e.amount_xrs!==void 0&&e.amount_xrs!==null?e.amount_xrs:(e.amount||0)/1e9;return t===0&&!e.from?"—":t.toLocaleString(void 0,{maximumFractionDigits:9})+" XRS"}'
    amount_after = 'function XerisNativeAmount(raw){if(typeof raw!=="string"&&typeof raw!=="number"||typeof raw==="number"&&!Number.isSafeInteger(raw))return null;const text=String(raw);if(!/^(0|[1-9][0-9]*)$/.test(text)||text.length>20||BigInt(text)>18446744073709551615n)return null;return window.XerisExplorerFormat(text,9,9)+" XRS"}function hs(row){const kind=row&&typeof row.tx_type==="string"?row.tx_type.replace(/^(sent|received):/,""):"";return["native_transfer","legacy_transfer","stake","unstake"].includes(kind)?XerisNativeAmount(row.amount)||"Unavailable":"See details"}'
    code = one(code, amount_before, amount_after, 'asset-aware exact instruction amount')
    code = one(code, 'const f=d.tx_type==="received"||!d.tx_type&&d.to===e,p=d.tx_type==="sent"||!d.tx_type&&d.from===e,', 'const f=d.tx_type==="received"||d.tx_type?.startsWith("received:")||!d.tx_type&&d.to===e,p=d.tx_type==="sent"||d.tx_type?.startsWith("sent:")||!d.tx_type&&d.from===e,', 'indexed receipt direction prefixes')
    code = one(code, 'children:[f?"+":p?"−":"",hs(d)]', 'children:hs(d).endsWith(" XRS")?[f?"+":p?"−":"",hs(d)]:hs(d)', 'no signed unavailable amount labels')
    code = one(code, 'children:[(u.amount_xrs!==void 0?u.amount_xrs:u.amount/1e9).toLocaleString(void 0,{maximumFractionDigits:9})," XRS"]', 'children:hs(u)', 'block transaction asset denomination')
    code = one(code, 'children:[(((i=t==null?void 0:t.meta)==null?void 0:i.fee)||(t==null?void 0:t.fee)||1e6)/1e9," XRS"]', 'children:XerisNativeAmount(t?.meta?.fee??t?.fee)??"Unavailable"', 'reported fee only without fabricated default')

    fallback = 'a.jsx(Ce,{path:"*",element:a.jsxs("main",{className:"connection-panel",children:[a.jsx("h1",{children:"Page not found"}),a.jsx("p",{children:"This explorer link is unavailable. Check the address or return to the overview."}),a.jsx(A,{to:"/",children:"Back to overview"})]})})'
    code = one(code, 'a.jsx(Ce,{path:"/validators",element:a.jsx(mv,{})})]})', 'a.jsx(Ce,{path:"/validators",element:a.jsx(mv,{})}),' + fallback + ']})', 'unknown-route recovery')
    boundary = 'class XerisExplorerBoundary extends v.Component{constructor(props){super(props);this.state={failed:false}}static getDerivedStateFromError(){return{failed:true}}render(){return this.state.failed?a.jsxs("main",{className:"connection-panel",role:"alert",children:[a.jsx("h1",{children:"This view could not be displayed"}),a.jsx("p",{children:"Please retry the page or return to the overview. No other network was selected."}),a.jsx("button",{type:"button",onClick:()=>location.reload(),children:"Retry page"}),a.jsx("a",{href:"/?network="+window.XerisExplorerAPI.network,children:"Back to overview"})]}):this.props.children}}'
    mount = 'Gs.createRoot(document.getElementById("root")).render(a.jsx(Fc.StrictMode,{children:a.jsx(hv,{})}));'
    code = one(code, mount, boundary + 'Gs.createRoot(document.getElementById("root")).render(a.jsx(Fc.StrictMode,{children:a.jsx(XerisExplorerBoundary,{children:a.jsx(hv,{})})}));', 'render failure recovery boundary')
    return code, asserted
