import {NETWORKS, selectedNetwork, networkLink, rawUnits} from './network.mjs';
import {createExplorerAPI} from './explorer-api.mjs';

const status = document.getElementById('network-status');
const notice = document.getElementById('data-notice');
const selector = document.getElementById('network-selector');
const choices = [...selector.querySelectorAll('button[data-network]')];
for (const button of choices) button.addEventListener('click', () => {
  const next = button.dataset.network;
  if (Object.hasOwn(NETWORKS, next)) location.assign(networkLink(location.href, next, location.href));
});
let network;
try { network = selectedNetwork(location.href); }
catch { status.textContent = 'Choose a valid network to continue.'; document.getElementById('root').textContent = 'This link specifies an unknown network.'; }

if (network) {
  for (const button of choices) button.setAttribute('aria-pressed', String(button.dataset.network === network));
  document.documentElement.dataset.network = network;
  document.title = `Xeris ${NETWORKS[network].name} Explorer`;
  const context = () => location.pathname + location.search;
  const showError = (message, startedAt = context()) => {
    if (startedAt !== context()) return;
    notice.hidden = false; notice.textContent = message + '. Data from another network will never be substituted.';
  };
  const showNotice = (message, startedAt) => { if (startedAt === context()) { notice.hidden = false; notice.textContent = message; } };
  const api = createExplorerAPI(network, {onError: showError, onNotice: showNotice, getContext: context});
  window.XerisExplorerAPI = api;
  window.XerisExplorerFormat = rawUnits;
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  for (const [method, original] of [['pushState', originalPush], ['replaceState', originalReplace]]) {
    history[method] = (state, unused, url) => {
      const target = url == null ? location.href : new URL(url, location.href).href;
      const linked = networkLink(target, network, location.href);
      notice.hidden = true;
      return original(state, unused, linked);
    };
  }
  originalReplace(history.state, '', networkLink(location.href, network, location.href));
  window.addEventListener('popstate', () => {
    try { if (selectedNetwork(location.href) !== network) location.reload(); }
    catch { location.reload(); }
  });
  // Network buttons reload the document, destroying React state and caches.
  const rewriteLinks = () => {
    for (const link of document.querySelectorAll('#root a[href]')) {
      const href = link.getAttribute('href');
      if (href?.startsWith('/') && !href.startsWith('//')) {
        const corrected = networkLink(href, network, location.href);
        if (href !== corrected) link.setAttribute('href', corrected);
      }
    }
  };
  new MutationObserver(rewriteLinks).observe(document.getElementById('root'), {childList: true, subtree: true, attributes: true, attributeFilter: ['href']});
  try {
    await api.ready();
    status.textContent = `${NETWORKS[network].name} · Network verified`;
    await import('/assets/explorer-ui.js');
    rewriteLinks();
  } catch (error) {
    status.textContent = `${NETWORKS[network].name} · Connection unavailable`;
    showError(error.message);
    const panel = document.createElement('main'); panel.className = 'connection-panel';
    const heading = document.createElement('h1'); heading.textContent = 'Network data is unavailable';
    const text = document.createElement('p'); text.textContent = 'The explorer could not verify this network. Retry the connection, or select the other network explicitly.';
    const button = document.createElement('button'); button.textContent = 'Retry connection'; button.onclick = () => location.reload();
    panel.append(heading, text, button); document.getElementById('root').append(panel);
  }
}
