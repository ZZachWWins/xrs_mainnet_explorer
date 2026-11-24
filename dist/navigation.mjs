const PUBLIC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function searchDestination(value, scope = 'auto') {
  const text = value.trim();
  if (!text || text.length > 128) throw new Error('Enter a block slot, wallet address, transaction signature or token ID.');
  if (scope === 'auto') {
    if (/^\d+$/.test(text)) scope = 'block';
    else if (BASE58.test(text) && text.length >= 85 && text.length <= 88) scope = 'tx';
    else if (BASE58.test(text) && text.length >= 32 && text.length <= 44) scope = 'account';
    else if (text.includes('_')) scope = 'token';
    else if (text.includes('-')) scope = 'contract';
    else throw new Error('Choose a search type for this identifier.');
  }
  if (scope === 'block' && (!/^\d{1,16}$/.test(text) || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('Enter a valid numeric block slot.');
  if (scope === 'account' && (!BASE58.test(text) || text.length < 32 || text.length > 44)) throw new Error('Enter a valid Xeris wallet address.');
  if (scope === 'tx' && (!BASE58.test(text) || text.length < 85 || text.length > 88)) throw new Error('Enter a complete transaction signature.');
  if (!['block', 'account', 'tx', 'token', 'contract'].includes(scope) || !PUBLIC_ID.test(text)) throw new Error('This identifier is not supported.');
  return `/${scope}/${encodeURIComponent(scope === 'block' ? String(BigInt(text)) : text)}`;
}

export function createNavigation(React, Link, useLocation, useNavigate) {
  const h = React.createElement;
  const links = [['/', 'Overview'], ['/transactions', 'Transactions'], ['/balances', 'Accounts'], ['/tokens', 'Tokens'],
    ['/pools', 'Pools'], ['/contracts', 'Contracts'], ['/validators', 'Validators'], ['/stats', 'Network']];
  return function Navigation() {
    const location = useLocation(), navigate = useNavigate();
    const [open, setOpen] = React.useState(false), [query, setQuery] = React.useState(''),
      [scope, setScope] = React.useState('auto'), [error, setError] = React.useState('');
    React.useEffect(() => {setOpen(false);setError('');}, [location.pathname]);
    function submit(event) {
      event.preventDefault();
      try {navigate(searchDestination(query, scope));setError('');setQuery('');setOpen(false);}
      catch (failure) {setError(failure.message);}
    }
    return h('header', {className:'explorer-header'},
      h('div', {className:'explorer-header-main'},
        h(Link, {to:'/',className:'explorer-wordmark','aria-label':'Xeris Explorer overview'},
          h('img',{src:'/logos/logodark.png',alt:'',width:32,height:32}),
          h('span',null,'XERIS ',h('span',null,'EXPLORER'))),
        h('button',{className:'explorer-menu',type:'button','aria-controls':'explorer-navigation','aria-expanded':open,
          onClick:()=>setOpen(!open)},open?'Close menu':'Menu'),
        h('form',{className:'explorer-search',onSubmit:submit,role:'search'},
          h('select',{'aria-label':'Search type',value:scope,onChange:event=>setScope(event.target.value)},
            ...[['auto','All'],['block','Block'],['account','Account'],['tx','Transaction'],['token','Token'],['contract','Contract']].map(([value,label])=>h('option',{key:value,value},label))),
          h('input',{'aria-label':'Search the selected network',placeholder:'Search by slot, address or token ID',value:query,maxLength:128,
            onChange:event=>setQuery(event.target.value),'aria-describedby':error?'explorer-search-error':undefined,autoComplete:'off',spellCheck:false}),
          h('button',{type:'submit','aria-label':'Search'},'Search'))),
      error&&h('p',{id:'explorer-search-error',className:'explorer-search-error',role:'alert'},error),
      h('nav',{id:'explorer-navigation',className:`explorer-navigation${open?' is-open':''}`,'aria-label':'Explorer sections'},
        ...links.map(([to,label])=>h(Link,{key:to,to,'aria-current':location.pathname===to?'page':undefined},label))));
  };
}
