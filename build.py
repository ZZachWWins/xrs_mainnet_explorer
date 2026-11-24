"""Reproducible local build from the user's recovered compiled UI export.

Keep vendor/ byte-for-byte; scoped asserted transforms repair the data boundary
and known inaccurate labels/defaults. The original editable React source was
not included in the supplied deployment. The static UI build needs no downloads;
the Netlify history Function uses the pinned SDK dependency.
"""
import hashlib
import json
import re
from pathlib import Path
import shutil
from ui_reliability import repair_views

ROOT = Path(__file__).resolve().parent
DIST = ROOT / 'dist'
VENDOR = ROOT / 'vendor'


def build():
    default_network = re.search(r"export const DEFAULT_NETWORK = '(mainnet|testnet)';", (ROOT / 'src/network.mjs').read_text()).group(1)
    DIST.mkdir(exist_ok=True)
    (DIST / 'assets').mkdir(exist_ok=True)
    shutil.copytree(VENDOR / 'logos', DIST / 'logos', dirs_exist_ok=True)
    shutil.copyfile(VENDOR / 'favicon.ico', DIST / 'favicon.ico')
    shutil.copyfile(VENDOR / 'assets/index-bamvo4ap.css', DIST / 'assets/explorer-ui.css')
    for filename in ('accounts.mjs', 'network.mjs', 'explorer-api.mjs', 'bootstrap.mjs', 'explorer.css', 'view-loaders.mjs', 'navigation.mjs', 'history-client.mjs', 'history-views.mjs', 'connection-recovery.mjs'):
        shutil.copyfile(ROOT / 'src' / filename, DIST / filename)
    original = (VENDOR / 'assets/index-xu2oldtt.js').read_text()
    start, end = original.index(',vc=new Map;'), original.index('function hs(e)')
    aliases = {'stats': 'sf', 'blocks': 'eg', 'block': 'tn', 'transactions': 'of',
        'transaction': 'tg', 'account': 'ng', 'accountTransactions': 'yc', 'validators': 'cf',
        'search': 'rg', 'balances': 'uf', 'tokens': 'Ur', 'token': 'lg', 'holders': 'sg',
        'contracts': 'ag', 'contract': 'og', 'quote': 'ig', 'pools': 'cg'}
    adapter = ';const{' + ','.join(f'{key}:{value}' for key, value in aliases.items()) + '}=window.XerisExplorerAPI;'
    adapter += 'function q(e){return e?typeof e==="string"?e:Array.from(e).map(t=>t.toString(16).padStart(2,"0")).join(""):""}'
    code = original[:start] + adapter + original[end:]
    changes = [
        ('/logos/LogoDark.png', '/logos/logodark.png'),
        ('label:"TXS (Last 50)"', 'label:"TXS (10 Blocks)"'),
        ('placeholder:"Search..."', '"aria-label":"Search blocks, transactions or accounts",placeholder:"Search..."'),
        ('className:"md:hidden text-text-dim hover:text-white p-1",onClick:()=>n(!t)',
         '"aria-label":t?"Close navigation menu":"Open navigation menu","aria-expanded":t,className:"md:hidden text-text-dim hover:text-white p-1",onClick:()=>n(!t)'),
        ('value:(l==null?void 0:l.num_validators)||0', 'value:(l==null?void 0:l.num_validators)??"—"'),
        ('label:"Total Supply",value:l!=null&&l.total_supply?`${(l.total_supply/1e18).toFixed(1)}B`:"..."',
         'label:"Total Staked",value:l!=null&&l.total_staked?window.XerisExplorerFormat(l.total_staked,9,0)+" XRS":"—"'),
        ('children:"Success Rate"', 'children:"Recorded TXS"'),
        ('children:[h.toFixed(2),"%"]', 'children:(l==null?void 0:l.total_transactions)??"—"'),
        ('children:"Avg Fee"', 'children:"Accounts"'),
        ('children:[(c/1e9).toFixed(4)," XRS"]', 'children:(l==null?void 0:l.total_accounts)??"—"'),
        ('children:"STABLE"', 'children:"OBSERVED"'),
        ('label:"Circulating",value:l!=null&&l.circulating_supply?`${(l.circulating_supply/1e15).toFixed(1)}M`:"..."',
         'label:window.XerisExplorerAPI.network==="testnet"?"Accounts":"Circulating",value:window.XerisExplorerAPI.network==="testnet"?((l==null?void 0:l.total_accounts)??"..."):l!=null&&l.circulating_supply?`${(l.circulating_supply/1e15).toFixed(1)}M`:l?"Unavailable":"..."'),
        ('const C=setInterval(b,3e4)', 'const C=setInterval(b,window.XerisExplorerAPI.network==="mainnet"?10000:30000)'),
        ('children:"Full Ledger"', 'children:"Recent transactions"'),
        ('children:"Total Transactions"', 'children:"Indexed Transactions"'),
        ('children:"Complete list of addresses with valid Xeriscoin balances on the L1 mainnet."',
         'children:"Largest available native XRS balances on the selected network. The endpoint may limit the returned list."'),
        ('uf().then(g=>{t(g),r(!1)}).catch(g=>console.error(g))', 'uf().then(g=>{t(g),r(!1)}).catch(g=>{console.error(g),r(!1)})'),
        ('const f=o.key==="address"?g:y,p=o.key==="address"?S:d;', 'const f=o.key==="address"?g:BigInt(y),p=o.key==="address"?S:BigInt(d);'),
        ('a.jsxs("th",{className:"data-table-header text-right cursor-pointer hover:text-white transition-colors",onClick:()=>h("balance"),children:["Percentage ",a.jsx(w,{column:"balance"})]})', 'null'),
        ('a.jsx("td",{className:"py-4 text-right",children:a.jsxs("div",{className:"flex items-center justify-end gap-3 text-xs text-text-dim",children:[a.jsx("div",{className:"w-20 h-1 bg-brand-deep rounded-full overflow-hidden",children:a.jsx("div",{className:"h-full bg-brand-blue shadow-[0_0_8px_rgba(0,25,165,0.8)]",style:{width:`${Math.min(100,y/c*100*50)}%`}})}),(y/c*100).toFixed(4),"%"]})})', 'null'),
        ('Ur().then(g=>{const y=g==null?void 0:g.find(S=>S.token_id==="xrs_native"||S.id==="xrs_native");y&&u(parseInt(y.max_supply||y.supply))}).catch(console.error)', 'void 0'),
        ('children:l?l.toLocaleString(void 0,{maximumFractionDigits:0})+" XRS":"..."',
         'children:e!=null&&e.circulating_supply?window.XerisExplorerFormat(e.circulating_supply,9,0)+" XRS":"Unavailable"'),
        ('children:e!=null&&e.total_supply?(e.total_supply/1e9).toLocaleString(void 0,{maximumFractionDigits:0})+" XRS":"..."',
         'children:e!=null&&e.total_supply?window.XerisExplorerFormat(e.total_supply,9,0)+" XRS":"Unavailable"'),
        ('label:"Regional Nodes"', 'label:"Listed Validators"'),
        ('label:"L1 Consensus",value:"Hardware-Secured"', 'label:"View",value:"Read-only explorer"'),
        ('value:`${(e==null?void 0:e.avg_block_time_ms)||400}ms`', 'value:e!=null&&e.avg_block_time_ms?`${e.avg_block_time_ms}ms`:"Unavailable"'),
        ('label:"Network Load",value:"Optimal"', 'label:"Data",value:"Selected network"'),
        ('children:"Global Triple Consensus Nodes"', 'children:"Validator identities reported by the selected network"'),
        ('children:w(t.max_supply||t.supply)', 'children:t.current_supply!=null?window.XerisExplorerFormat(t.current_supply,x,x):"Unavailable"'),
        ('a.jsx(fv,{contract:t,tokenA:((Y=t.params)==null?void 0:Y.token_a)||((Z=t.state)==null?void 0:Z.token_a),tokenB:((Re=t.params)==null?void 0:Re.token_b)||((Ke=t.state)==null?void 0:Ke.token_b)})',
         'a.jsx("p",{className:"text-text-dim text-sm mt-4",children:"Pool reserves are reported in raw token units. This explorer is read-only."})'),
    ]
    for before, after in changes:
        count = code.count(before)
        if count != 1:
            raise RuntimeError(f'Expected one vendor patch match, found {count}: {before}')
        code = code.replace(before, after)
    # Analytics was a one-shot view using wrapped maximum supply as circulating.
    analytics_before = 'sf().then(t).catch(console.error),cf().then(r).catch(console.error),Ur().then(o=>{const i=o==null?void 0:o.find(c=>c.token_id==="xrs_native"||c.id==="xrs_native");i&&s(parseInt(i.max_supply||i.supply)/Math.pow(10,i.decimals||9))}).catch(console.error)'
    analytics_after = 'const update=()=>sf().then(t).catch(()=>t(null));update();cf().then(r).catch(console.error);const refresh=setInterval(update,10000),expiry=setInterval(()=>t(value=>value?Object.create(Object.getPrototypeOf(value),Object.getOwnPropertyDescriptors(value)):value),1000);return()=>{clearInterval(refresh),clearInterval(expiry)}'
    if code.count(analytics_before) != 1:
        raise RuntimeError('Analytics refresh patch no longer matches')
    code = code.replace(analytics_before, analytics_after)
    token_start, token_end = code.index('function cv('), code.index('function uv(')
    token_ui = code[token_start:token_end]
    token_changes = [
        ('function cv(){const{id:e}', 'function cv(){const[holdersStatus,setHoldersStatus]=v.useState("loading");const{id:e}'),
        ('v.useEffect(()=>{(async()=>{try{const[d,f]=await Promise.all([lg(e),sg(e)]);n(d),l(f||[]),o(!1)}catch(d){console.error(d),c("Failed to fetch token details"),o(!1)}})()},[e])',
         'v.useEffect(()=>{let alive=true;o(true);c(null);l([]);setHoldersStatus("loading");lg(e).then(d=>{if(!alive)return;n(d);o(false);sg(e).then(f=>{if(alive){l(f||[]);setHoldersStatus("ready")}}).catch(()=>{if(alive)setHoldersStatus("unavailable")})}).catch(()=>{if(alive){c("Failed to fetch token details");o(false)}});return()=>{alive=false}},[e])'),
        ('children:r.length.toLocaleString()', 'children:holdersStatus==="ready"?r.length.toLocaleString():holdersStatus==="loading"?"Loading…":"Unavailable"'),
        ('children:"No holders found"', 'children:holdersStatus==="loading"?"Loading holders…":holdersStatus==="unavailable"?"Holder data unavailable":"No holders found"'),
    ]
    for before, after in token_changes:
        if token_ui.count(before) != 1:
            raise RuntimeError('Token metadata/holder separation patch no longer matches')
        token_ui = token_ui.replace(before, after)
    code = code[:token_start] + token_ui + code[token_end:]
    code, reliability_count = repair_views(code)
    # Keep the live account balance view; Mainnet gets a separate archive link.
    account_start, account_end = code.index('function ov('), code.index('function iv(')
    account_ui = code[account_start:account_end]
    history_heading = 'a.jsxs("h2",{className:"text-lg mb-6 flex items-center gap-2 text-white",children:[a.jsx(gc,{size:18,className:"text-brand-vibrant"}),"Transaction History"]})'
    history_link = 'window.XerisExplorerAPI.network==="mainnet"&&a.jsx(A,{to:`/history/address/${e}`,className:"inline-block mb-6 text-brand-vibrant hover:underline",children:"Address history"})'
    if account_ui.count(history_heading) != 1: raise RuntimeError('Account history link boundary changed')
    account_ui = account_ui.replace(history_heading, history_heading + ',' + history_link)
    code = code[:account_start] + account_ui + code[account_end:]
    # Readable archive views wrap only Mainnet history routes; Testnet keeps the
    # recovered components. Every transform asserts its original boundary.
    routes = {
        'path:"/transactions",element:a.jsx(rv,{})': 'path:"/transactions",element:a.jsx(XerisHistoryRoute,{kind:"transactions",Fallback:rv})',
        'path:"/block/:slot",element:a.jsx(sv,{})': 'path:"/block/:slot",element:a.jsx(XerisHistoryRoute,{kind:"block",Fallback:sv})',
        'path:"/tx/:signature",element:a.jsx(av,{})': 'path:"/tx/:signature",element:a.jsx(XerisHistoryRoute,{kind:"transaction",Fallback:av})',
    }
    for before, after in routes.items():
        if code.count(before) != 1: raise RuntimeError('Archive route boundary changed: ' + before)
        code = code.replace(before, after)
    extra = ','.join('a.jsx(Ce,{path:' + json.dumps(path) + ',element:a.jsx(XerisHistoryRoute,{kind:' + json.dumps(kind) + '})})'
        for path, kind in [('/history','blocks'),('/history/blocks','blocks'),('/history/transactions','transactions'),
            ('/history/block/:id','block'),('/history/transaction/:id','transaction'),('/history/address/:id','address')])
    anchor = 'a.jsxs(Wh,{children:['
    if code.count(anchor) != 1: raise RuntimeError('Archive router boundary changed')
    code = code.replace(anchor, anchor + extra + ',')
    code = code.replace('function hv(){', 'const XerisHistoryRoute=window.XerisExplorerHistory(v,A,Dr);function hv(){', 1)
    (DIST / 'assets/explorer-ui.js').write_text(code)
    (DIST / 'index.html').write_text('''<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xeris Explorer</title><meta name="description" content="Explore Xeris blocks, transactions, tokens, pools and validators. Choose a network explicitly at the top of every page.">
<link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/explorer-ui.css"><link rel="stylesheet" href="/explorer.css"><script type="module" src="/bootstrap.mjs"></script>
</head><body class="bg-brand-navy text-text-body antialiased">
<a id="skip-to-content" class="skip-to-content" href="#startup-loader">Skip to explorer content</a>
<header class="network-bar"><div class="network-identification"><strong>XERIS NETWORK EXPLORER</strong><span id="network-status" role="status">Verifying network…</span></div>
<div class="network-choice" id="network-selector" role="group" aria-label="Explorer network"><button type="button" data-network="testnet" aria-pressed="@TESTNET@">Testnet</button><button type="button" data-network="mainnet" aria-pressed="@MAINNET@">Mainnet Beta</button></div></header>
<div class="data-notice" id="data-notice" role="status" hidden></div>
<main class="startup-loader" id="startup-loader" tabindex="-1" role="status" aria-live="polite"><span class="loading-ring" aria-hidden="true"></span><h1 id="loading-title">Loading the explorer…</h1><p id="loading-detail">Connecting to the selected Xeris network.</p><p class="loading-patience">This may take a moment…</p></main>
<div id="root" aria-busy="true"></div>
<noscript><style>.startup-loader{display:none}</style>This explorer needs JavaScript to verify and display the selected network.</noscript></body></html>'''.replace('@TESTNET@', str(default_network == 'testnet').lower()).replace('@MAINNET@', str(default_network == 'mainnet').lower()))
    manifest = {'format': 1, 'recovered_ui': True, 'default_network': default_network,
        'read_only': True, 'source_sha256': hashlib.sha256(original.encode()).hexdigest(),
        'patched_ui_sha256': hashlib.sha256(code.encode()).hexdigest(), 'asserted_ui_corrections': len(changes) + len(token_changes) + 1 + reliability_count,
        'network_state': 'URL query; no persisted data or cross-network fallback',
        'files': {str(p.relative_to(DIST)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(DIST.rglob('*')) if p.is_file() and p.name != 'build-manifest.json'}}
    (DIST / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Built explorer: {len(manifest["files"])} files; {manifest["asserted_ui_corrections"]} asserted UI corrections')


if __name__ == '__main__':
    build()
