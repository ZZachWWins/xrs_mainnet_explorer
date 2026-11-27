// One connection attempt at a time. Transient failures back off without a reload;
// identity/schema failures remain explicit and never enter an automatic loop.
export function createConnectionRecovery({connect, onConnecting, onConnected, onFailure,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now} = {}) {
  let timer, running = false, stopped = false, connected = false, failures = 0, notBefore = 0;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  async function attempt() {
    if (stopped || running || now() < notBefore) return false;
    clear(); running = true;
    try {
      onConnecting({reconnecting: connected});
      await connect();
      if (stopped) return false;
      await onConnected({reconnected: connected});
      connected = true; failures = 0; notBefore = 0;
      return true;
    } catch (error) {
      if (stopped) return false;
      const retryable = error?.retryable === true;
      const serverDelay = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
      notBefore = now() + serverDelay;
      const delayMs = retryable ? Math.max(serverDelay, Math.min(30_000, 5_000 * 2 ** Math.min(failures++, 3))) : 0;
      onFailure(error, {retryable, delayMs, serverDelay});
      if (retryable) timer = schedule(() => { timer = undefined; void attempt(); }, delayMs);
      return false;
    } finally { running = false; }
  }
  return {start: attempt, retry: attempt, stop() { stopped = true; clear(); }};
}
