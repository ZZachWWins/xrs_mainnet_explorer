import {NETWORKS, selectedNetwork, networkLink, rawUnits, compactUSD} from './network.mjs';
import {createExplorerAPI} from './explorer-api.mjs';
import * as views from './view-loaders.mjs';
import {createNavigation} from './navigation.mjs';
import {createHistoryClient} from './history-client.mjs';
import {createHistoryViews} from './history-views.mjs';
import {createConnectionRecovery, createFreshnessState} from './connection-recovery.mjs';

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
let retryTimer, freshnessRetryTimer;
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
    ? `Session ${session} · Updating · Last verified ${age(Date.now() - lastVerifiedAt)}`
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
  document.getElementById('loading-detail').textContent = 'Preparing the latest verified data.';
  let explorerMounted = false, archiveMounted = false, connectionEpoch = 0, mountPromise, recovery;
  const freshnessState = createFreshnessState();
  const checkpointPath = network === 'mainnet' ? '/identity/checkpoint'
    : `/v2/block/slot/${NETWORKS[network].checkpointSlot}`;
  const context = () => location.pathname + location.search;
  const showError = (message, startedAt = context(), error) => {
    if (startedAt !== context()) return;
    clearTimeout(retryTimer);
    if (error?.retryable) setHealth('delayed');
    if (error?.retryable && (explorerMounted || mountPromise)) {
      notice.hidden = true; notice.replaceChildren(); delete notice.dataset.transient;
      void recovery?.retry();
      return;
    }
    notice.hidden = false; notice.replaceChildren();
    notice.dataset.transient = 'true';
    const text = document.createElement('span');
    text.textContent = error?.code === 'UNSUPPORTED_ENDPOINT' ? `This view is not provided on ${NETWORKS[network].name}.` :
      error?.code === 'RATE_LIMITED' ? 'Updates are taking longer than usual.' : message;
    notice.append(text);
    if (error?.code !== 'UNSUPPORTED_ENDPOINT' && !(error?.retryable && (explorerMounted || mountPromise))) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Refresh';
      retry.onclick = () => location.reload();
      if (error?.retryAfterMs > 0) { retry.disabled = true; retry.textContent = 'Refreshing soon';
        retryTimer = setTimeout(() => { retry.disabled = false; retry.textContent = 'Refresh'; }, error.retryAfterMs); }
      notice.append(retry);
    }
    if (error?.retryable && (explorerMounted || mountPromise)) void recovery?.retry();
  };
  const showNotice = (message, startedAt) => { if (startedAt === context()) { notice.hidden = false; delete notice.dataset.transient; notice.textContent = message; } };
  const onFreshness = ({state, observedAtMs, path, retryAfterMs = 0}) => {
    const summary = freshnessState.update({state, observedAtMs, path});
    setHealth(summary.state === 'stale' ? 'delayed' : 'live', summary.observedAtMs);
    clearTimeout(freshnessRetryTimer);
    if (summary.state === 'stale') freshnessRetryTimer = setTimeout(() => { void recovery?.retry(); }, Math.max(5000, retryAfterMs));
    else if (notice.dataset.transient === 'true') { notice.hidden = true; notice.replaceChildren(); delete notice.dataset.transient; }
  };
  const api = createExplorerAPI(network, {onError: showError, onNotice: showNotice, onFreshness, getContext: context});
  window.XerisExplorerAPI = api;
  window.XerisExplorerFormat = rawUnits;
  window.XerisExplorerUSD = compactUSD;
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
    for (const [label, value] of [['Verified through', coverage?.tip?.slot ? `Block ${coverage.tip.slot.toLocaleString()}` : '—'],
      ['Indexed blocks', Number.isSafeInteger(coverage?.counts?.blocks) ? coverage.counts.blocks.toLocaleString() : '—'],
      ['Indexed transactions', Number.isSafeInteger(coverage?.counts?.transactions) ? coverage.counts.transactions.toLocaleString() : '—']]) {
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
      const summary = freshnessState.retain([checkpointPath]);
      setHealth(summary.state === 'stale' ? 'delayed' : 'live', summary.observedAtMs);
      return original(state, unused, linked);
    };
  }
  originalReplace(history.state, '', networkLink(location.href, network, location.href));
  window.addEventListener('popstate', () => {
    const summary = freshnessState.retain([checkpointPath]);
    setHealth(summary.state === 'stale' ? 'delayed' : 'live', summary.observedAtMs);
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
    for (const region of document.querySelectorAll('#root .overflow-x-auto')) {
      if (!region.hasAttribute('tabindex')) region.tabIndex = 0;
      if (!region.hasAttribute('role')) region.setAttribute('role', 'region');
      if (!region.hasAttribute('aria-label')) region.setAttribute('aria-label', 'Scrollable explorer data table');
    }
  };
  new MutationObserver(rewriteLinks).observe(document.getElementById('root'), {childList: true, subtree: true, attributes: true, attributeFilter: ['href']});
  let connectionButton, connectionMessage, connectionPanel;
  const mountExplorer = () => {
    if (explorerMounted) return Promise.resolve();
    if (mountPromise) return mountPromise;
    connectionEpoch++;
    startup.hidden = false;
    root.setAttribute('aria-busy', 'true');
    const viewName = location.pathname === '/' ? 'blocks' : location.pathname.split('/')[1].replaceAll('-', ' ');
    document.getElementById('loading-title').textContent = `Loading ${viewName}…`;
    document.getElementById('loading-detail').textContent = 'Preparing the latest verified data.';
    const mounted = new MutationObserver(() => { if (root.childElementCount) { finishStartup(); mounted.disconnect(); } });
    mounted.observe(root, {childList: true});
    root.replaceChildren();
    const attempt = import(`/assets/explorer-ui.js?boot=${connectionEpoch}`).then(() => {
      explorerMounted = true; archiveMounted = false; connectionPanel = connectionButton = connectionMessage = null; rewriteLinks();
    }).catch(() => {
      mounted.disconnect();
      throw Object.assign(new Error('Explorer interface could not be loaded'), {code: 'UI_LOAD_ERROR', retryable: true});
    });
    const wrapped = attempt.finally(() => { if (mountPromise === wrapped) mountPromise = null; });
    mountPromise = wrapped;
    return mountPromise;
  };
  recovery = createConnectionRecovery({
    // Once the UI has mounted, probe the live checkpoint again instead of
    // trusting the identity promise cached during initial startup.
    connect: () => explorerMounted ? api.probe() : api.ready(),
    onConnecting() {
      status.textContent = `${NETWORKS[network].name} · Updating`;
      setHealth('delayed');
      if (connectionPanel) {
        connectionButton.disabled = true;
        connectionButton.textContent = 'Updating…';
        connectionMessage.textContent = 'Latest verified data will appear here automatically.';
      }
    },
    async onConnected() {
    await mountExplorer();
    status.textContent = `${NETWORKS[network].name} · ${healthState === 'delayed' ? 'Updating' : 'Live'}`;
    if (healthState !== 'delayed') setHealth('live', Date.now());
    if (notice.dataset.transient === 'true') { notice.hidden = true; notice.replaceChildren(); delete notice.dataset.transient; }
    // A background probe recovered. Keep the mounted explorer and its last
    // verified rows in place; its normal polling will refresh them.
    return;
    },
    onFailure(error, {retryable, serverDelay}) {
    status.textContent = `${NETWORKS[network].name} · ${retryable ? 'Updating' : 'Verification required'}`;
    setHealth(retryable ? 'delayed' : 'unavailable');
    if (explorerMounted || mountPromise) {
      if (retryable) { notice.hidden = true; notice.replaceChildren(); delete notice.dataset.transient; }
      else {
        notice.hidden = false; notice.dataset.transient = 'true'; notice.replaceChildren();
        const message = document.createElement('span');
        message.textContent = 'Network verification is paused. Unverified updates will not be displayed.';
        notice.append(message);
      }
      return;
    }
    if (archiveMounted && retryable) {
      notice.hidden = false; notice.dataset.transient = 'true';
      notice.textContent = 'Showing the latest verified Mainnet snapshot while updates continue.';
      return;
    }
    const epoch = ++connectionEpoch;
    notice.hidden = true;
    const panel = document.createElement('main'); panel.className = 'connection-panel'; panel.id = 'explorer-content'; panel.tabIndex = -1;
    const heading = document.createElement('h1'); heading.textContent = retryable ? 'Connecting to Xeris' : 'Network verification required';
    const text = document.createElement('p'); text.textContent = error?.code === 'NETWORK_MISMATCH'
      ? 'The selected network could not be verified. Display remains paused to protect data integrity.'
      : `Preparing the latest verified ${NETWORKS[network].name} data.`;
    const hint = document.createElement('p');
    hint.textContent = 'Your most recent verified data will remain visible whenever it has been loaded before.';
    const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    message.textContent = retryable ? 'Updating automatically. This may take a moment…' : 'Refresh when you are ready.';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Refresh';
    button.disabled = retryable && serverDelay > 0;
    button.onclick = () => { if (retryable) void recovery.retry(); else location.reload(); };
    panel.append(heading, text);
    if (retryable) panel.append(hint);
    panel.append(message, button); connectionPanel = panel; connectionButton = button; connectionMessage = message;
    root.replaceChildren(panel); finishStartup();
    void mountArchiveFallback(error, epoch);
    }
  });
  window.addEventListener('online', () => { void recovery.retry(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void recovery.retry(); });
  window.addEventListener('pagehide', () => { recovery.stop(); clearTimeout(freshnessRetryTimer); if (typeof healthTimer !== 'undefined') clearInterval(healthTimer); }, {once: true});
  // A restored document retains its stopped timers. Re-enter through the full
  // network identity check rather than reviving stale connection state.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  void mountExplorer().catch(() => { /* Recovery presents the bounded UI-load failure state. */ });
  void recovery.start();
}
