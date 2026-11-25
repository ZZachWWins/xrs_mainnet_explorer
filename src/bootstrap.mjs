import {NETWORKS, selectedNetwork, networkLink, rawUnits} from './network.mjs';
import {createExplorerAPI} from './explorer-api.mjs';
import * as views from './view-loaders.mjs';
import {createNavigation} from './navigation.mjs';
import {createHistoryClient} from './history-client.mjs';
import {createHistoryViews} from './history-views.mjs';
import {createConnectionRecovery} from './connection-recovery.mjs';

const status = document.getElementById('network-status');
const freshness = document.getElementById('network-freshness');
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
let healthTimer, healthStartedAt, lastVerifiedAt, healthState = 'verifying';
const duration = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
};
const age = milliseconds => milliseconds < 60_000 ? `${Math.max(0, Math.floor(milliseconds / 1000))}s ago`
  : milliseconds < 3_600_000 ? `${Math.floor(milliseconds / 60_000)}m ago` : `${Math.floor(milliseconds / 3_600_000)}h ago`;
const paintHealth = () => {
  if (!freshness) return;
  const session = healthStartedAt ? duration(Date.now() - healthStartedAt) : '--:--:--';
  freshness.textContent = healthState === 'delayed' && lastVerifiedAt
    ? `Session ${session} · Last verified ${age(Date.now() - lastVerifiedAt)}`
    : `Session ${session}${lastVerifiedAt ? ` · Updated ${age(Date.now() - lastVerifiedAt)}` : ''}`;
};
const setHealth = (state, observedAtMs = lastVerifiedAt) => {
  healthState = state;
  if (!healthStartedAt) healthStartedAt = Date.now();
  if (Number.isSafeInteger(observedAtMs) && observedAtMs > 0 && observedAtMs <= Date.now()) lastVerifiedAt = observedAtMs;
  document.documentElement.dataset.freshness = state;
  if (!healthTimer) healthTimer = setInterval(paintHealth, 1000);
  paintHealth();
};
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
  let explorerMounted = false, archiveMounted = false, connectionEpoch = 0;
  const context = () => location.pathname + location.search;
  const showError = (message, startedAt = context(), error) => {
    if (startedAt !== context()) return;
    clearTimeout(retryTimer);
    if (error?.retryable) setHealth('delayed');
    notice.hidden = false; notice.replaceChildren();
    notice.dataset.transient = 'true';
    const text = document.createElement('span');
    text.textContent = error?.retryable && explorerMounted ? 'Live updates are delayed. The last verified data remains visible while the explorer reconnects automatically.' :
      error?.code === 'UNSUPPORTED_ENDPOINT' ? `This information is not available from the ${NETWORKS[network].name} endpoint.` :
      error?.code === 'RATE_LIMITED' ? 'The network is handling many requests. Please retry shortly.' : message;
    notice.append(text);
    if (error?.code !== 'UNSUPPORTED_ENDPOINT' && !(error?.retryable && explorerMounted)) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry data';
      retry.onclick = () => location.reload();
      if (error?.retryAfterMs > 0) { retry.disabled = true; retry.textContent = 'Retry shortly';
        retryTimer = setTimeout(() => { retry.disabled = false; retry.textContent = 'Retry data'; }, error.retryAfterMs); }
      notice.append(retry);
    }
  };
  const showNotice = (message, startedAt) => { if (startedAt === context()) { notice.hidden = false; delete notice.dataset.transient; notice.textContent = message; } };
  const onFreshness = ({state, observedAtMs}) => {
    setHealth(state === 'stale' ? 'delayed' : 'live', observedAtMs);
    if (state !== 'stale' && notice.dataset.transient === 'true') { notice.hidden = true; notice.replaceChildren(); delete notice.dataset.transient; }
  };
  const api = createExplorerAPI(network, {onError: showError, onNotice: showNotice, onFreshness, getContext: context});
  window.XerisExplorerAPI = api;
  window.XerisExplorerFormat = rawUnits;
  window.XerisExplorerViews = views;
  window.XerisExplorerNavigation = (...args) => createNavigation(...args, {network});
  const historyClient = createHistoryClient(network);
  const mountArchiveFallback = async (error, epoch) => {
    if (network !== 'mainnet' || error?.retryable !== true) return false;
    const ready = await historyClient.readiness();
    if (!ready.ready || epoch !== connectionEpoch || explorerMounted) return false;
    const [blocksResult, transactionsResult] = await Promise.allSettled([
      historyClient.page('blocks'), historyClient.page('transactions'),
    ]);
    if (epoch !== connectionEpoch || explorerMounted) return false;
    const coverage = ready.coverage, observedAtMs = Number.isSafeInteger(coverage?.snapshot_tip_timestamp_ms)
      ? coverage.snapshot_tip_timestamp_ms : Number.isSafeInteger(coverage?.snapshot_age_ms) ? Date.now() - coverage.snapshot_age_ms : null;
    const panel = document.createElement('main'); panel.id = 'explorer-content'; panel.tabIndex = -1; panel.className = 'archive-fallback';
    const eyebrow = document.createElement('p'); eyebrow.className = 'archive-eyebrow'; eyebrow.textContent = 'VERIFIED MAINNET SNAPSHOT';
    const heading = document.createElement('h1'); heading.textContent = 'Explorer data is catching up';
    const explanation = document.createElement('p'); explanation.textContent = 'Live node updates are temporarily delayed. The most recent integrity-checked archive remains available while reconnection continues.';
    const summary = document.createElement('dl'); summary.className = 'archive-summary';
    for (const [label, value] of [['Verified through', coverage?.tip?.slot ? `Block ${coverage.tip.slot.toLocaleString()}` : 'Unavailable'],
      ['Indexed blocks', Number.isSafeInteger(coverage?.counts?.blocks) ? coverage.counts.blocks.toLocaleString() : 'Unavailable'],
      ['Indexed transactions', Number.isSafeInteger(coverage?.counts?.transactions) ? coverage.counts.transactions.toLocaleString() : 'Unavailable']]) {
      const item = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
      term.textContent = label; detail.textContent = value; item.append(term, detail); summary.append(item);
    }
    const links = document.createElement('nav'); links.className = 'archive-links'; links.setAttribute('aria-label', 'Verified archive');
    for (const [label, href] of [['Browse verified blocks', '/history/blocks'], ['Browse verified transactions', '/history/transactions']]) {
      const link = document.createElement('a'); link.textContent = label; link.href = networkLink(href, network, location.href); links.append(link);
    }
    panel.append(eyebrow, heading, explanation, summary, links);
    const recent = blocksResult.status === 'fulfilled' ? blocksResult.value.data.slice(0, 5) : [];
    if (recent.length) {
      const section = document.createElement('section'), title = document.createElement('h2'), list = document.createElement('ol');
      title.textContent = 'Last verified blocks'; list.className = 'archive-blocks';
      for (const block of recent) { const item = document.createElement('li'), link = document.createElement('a'), count = document.createElement('span');
        link.href = networkLink(`/history/block/${block.slot}`, network, location.href); link.textContent = `Block ${block.slot.toLocaleString()}`;
        count.textContent = `${block.transaction_count.toLocaleString()} transactions`; item.append(link, count); list.append(item); }
      section.append(title, list); panel.append(section);
    }
    archiveMounted = true; connectionPanel = connectionButton = connectionMessage = null;
    status.textContent = `${NETWORKS[network].name} · Data delayed`;
    setHealth('delayed', observedAtMs);
    notice.hidden = false; notice.dataset.transient = 'true'; notice.textContent = 'Showing the last verified Mainnet snapshot. Live updates will resume automatically.';
    root.replaceChildren(panel); finishStartup();
    return true;
  };
  window.XerisExplorerHistory = (React, Link, useLocation) => createHistoryViews(React, Link, useLocation, historyClient);
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
  let connectionButton, connectionMessage, connectionPanel;
  const recovery = createConnectionRecovery({
    connect: () => api.ready(),
    onConnecting() {
      status.textContent = `${NETWORKS[network].name} · Reconnecting…`;
      setHealth('delayed');
      if (connectionPanel) {
        connectionButton.disabled = true;
        connectionButton.textContent = 'Retrying connection…';
        connectionMessage.textContent = 'Reconnecting automatically. This may take a moment…';
      }
    },
    async onConnected() {
    connectionEpoch++; archiveMounted = false; explorerMounted = true;
    status.textContent = `${NETWORKS[network].name} · Live`;
    setHealth('live', Date.now());
    if (notice.dataset.transient === 'true') { notice.hidden = true; notice.replaceChildren(); delete notice.dataset.transient; }
    startup.hidden = false;
    root.setAttribute('aria-busy', 'true');
    const viewName = location.pathname === '/' ? 'blocks' : location.pathname.split('/')[1].replaceAll('-', ' ');
    document.getElementById('loading-title').textContent = `Loading ${viewName}…`;
    document.getElementById('loading-detail').textContent = `Retrieving data from Xeris ${NETWORKS[network].name}.`;
    const mounted = new MutationObserver(() => { if (root.childElementCount) {finishStartup();mounted.disconnect();} });
    mounted.observe(root, {childList: true});
    root.replaceChildren();
    await import('/assets/explorer-ui.js');
    rewriteLinks();
    },
    onFailure(error, {retryable, serverDelay}) {
    status.textContent = `${NETWORKS[network].name} · ${retryable ? 'Data delayed' : 'Connection unavailable'}`;
    setHealth(retryable ? 'delayed' : 'unavailable');
    if (archiveMounted && retryable) {
      notice.hidden = false; notice.dataset.transient = 'true';
      notice.textContent = 'Showing the last verified Mainnet snapshot. Reconnecting automatically…';
      return;
    }
    const epoch = ++connectionEpoch;
    notice.hidden = true;
    const panel = document.createElement('main'); panel.className = 'connection-panel'; panel.id = 'explorer-content'; panel.tabIndex = -1;
    const heading = document.createElement('h1'); heading.textContent = 'Network data is unavailable';
    const text = document.createElement('p'); text.textContent = error?.code === 'NETWORK_MISMATCH'
      ? 'This endpoint did not match the selected network. Data display has been stopped.'
      : `We could not connect to Xeris ${NETWORKS[network].name}.`;
    const hint = document.createElement('p');
    hint.textContent = 'The network may be experiencing heavy load, or your internet connection may not be optimal.';
    const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    message.textContent = retryable ? 'We’ll retry automatically. This may take a moment…' : 'Retry the connection when you are ready.';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Retry connection';
    button.disabled = retryable && serverDelay > 0;
    button.onclick = () => { if (retryable) void recovery.retry(); else location.reload(); };
    panel.append(heading, text);
    if (retryable) panel.append(hint);
    panel.append(message, button); connectionPanel = panel; connectionButton = button; connectionMessage = message;
    root.replaceChildren(panel); finishStartup();
    void mountArchiveFallback(error, epoch);
    }
  });
  window.addEventListener('pagehide', () => { recovery.stop(); if (typeof healthTimer !== 'undefined') clearInterval(healthTimer); }, {once: true});
  // A restored document retains its stopped timers. Re-enter through the full
  // network identity check rather than reviving stale connection state.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  void recovery.start();
}
