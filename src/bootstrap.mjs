import {NETWORKS, selectedNetwork, networkLink, rawUnits} from './network.mjs';
import {createExplorerAPI} from './explorer-api.mjs';
import * as views from './view-loaders.mjs';
import {createNavigation} from './navigation.mjs';

const status = document.getElementById('network-status');
const notice = document.getElementById('data-notice');
const startup = document.getElementById('startup-loader');
const root = document.getElementById('root');
const skipLink = document.getElementById('skip-to-content');
const finishStartup = () => {
  const restoreFocus = document.activeElement === startup;
  startup.hidden = true; root.setAttribute('aria-busy', 'false');
  const content = document.getElementById('explorer-content');
  if (content) {
    skipLink.href = '#explorer-content';
    if (restoreFocus) content.focus({preventScroll:true});
  }
};
let retryTimer;
const selector = document.getElementById('network-selector');
const choices = [...selector.querySelectorAll('button[data-network]')];
for (const button of choices) button.addEventListener('click', () => {
  const next = button.dataset.network;
  if (next === document.documentElement.dataset.network) return;
  if (Object.hasOwn(NETWORKS, next)) location.assign(networkLink(location.href, next, location.href));
});
let network;
try { network = selectedNetwork(location.href); }
catch {
  status.textContent = 'Choose a valid network to continue.';
  const panel = document.createElement('main'); panel.id = 'explorer-content'; panel.tabIndex = -1; panel.className = 'connection-panel';
  panel.textContent = 'This link specifies an unknown network.'; root.replaceChildren(panel); finishStartup();
}

if (network) {
  for (const button of choices) button.setAttribute('aria-pressed', String(button.dataset.network === network));
  document.documentElement.dataset.network = network;
  document.title = `Xeris ${NETWORKS[network].name} Explorer`;
  document.getElementById('loading-title').textContent = `Connecting to ${NETWORKS[network].name}…`;
  document.getElementById('loading-detail').textContent = 'Checking the network and preparing your explorer.';
  const context = () => location.pathname + location.search;
  const showError = (message, startedAt = context(), error) => {
    if (startedAt !== context()) return;
    clearTimeout(retryTimer);
    notice.hidden = false; notice.replaceChildren();
    const text = document.createElement('span');
    text.textContent = error?.code === 'UNSUPPORTED_ENDPOINT' ? `This information is not available from the ${NETWORKS[network].name} endpoint.` :
      error?.code === 'RATE_LIMITED' ? 'The network is handling many requests. Please retry shortly.' : message;
    notice.append(text);
    if (error?.code !== 'UNSUPPORTED_ENDPOINT') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry data';
      retry.onclick = () => location.reload();
      if (error?.retryAfterMs > 0) { retry.disabled = true; retry.textContent = 'Retry shortly';
        retryTimer = setTimeout(() => { retry.disabled = false; retry.textContent = 'Retry data'; }, error.retryAfterMs); }
      notice.append(retry);
    }
  };
  const showNotice = (message, startedAt) => { if (startedAt === context()) { notice.hidden = false; notice.textContent = message; } };
  const api = createExplorerAPI(network, {onError: showError, onNotice: showNotice, getContext: context});
  window.XerisExplorerAPI = api;
  window.XerisExplorerFormat = rawUnits;
  window.XerisExplorerViews = views;
  window.XerisExplorerNavigation = createNavigation;
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  for (const [method, original] of [['pushState', originalPush], ['replaceState', originalReplace]]) {
    history[method] = (state, unused, url) => {
      const target = url == null ? location.href : new URL(url, location.href).href;
      const linked = networkLink(target, network, location.href);
      notice.hidden = true;
      clearTimeout(retryTimer);
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
    status.textContent = `${NETWORKS[network].name} · Connected`;
    const viewName = location.pathname === '/' ? 'blocks' : location.pathname.split('/')[1].replaceAll('-', ' ');
    document.getElementById('loading-title').textContent = `Loading ${viewName}…`;
    document.getElementById('loading-detail').textContent = `Retrieving data from Xeris ${NETWORKS[network].name}.`;
    const mounted = new MutationObserver(() => { if (root.childElementCount) {finishStartup();mounted.disconnect();} });
    mounted.observe(root, {childList: true});
    await import('/assets/explorer-ui.js');
    rewriteLinks();
  } catch (error) {
    status.textContent = `${NETWORKS[network].name} · Connection unavailable`;
    notice.hidden = true;
    const panel = document.createElement('main'); panel.className = 'connection-panel'; panel.id = 'explorer-content'; panel.tabIndex = -1;
    const heading = document.createElement('h1'); heading.textContent = 'Network data is unavailable';
    const text = document.createElement('p'); text.textContent = error?.code === 'NETWORK_MISMATCH'
      ? 'This endpoint did not match the selected network. Data display has been stopped.'
      : `We could not connect to Xeris ${NETWORKS[network].name}. Retry the connection when you are ready.`;
    const button = document.createElement('button'); button.textContent = 'Retry connection'; button.onclick = () => location.reload();
    panel.append(heading, text, button); root.replaceChildren(panel); finishStartup();
  }
}
