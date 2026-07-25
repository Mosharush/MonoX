function withTimeout(promise, milliseconds, label) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createLifecycle(options = {}) {
  const hooks = [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  let state = 'running';
  let shutdownPromise;
  let installed = false;
  const listeners = new Map();

  function onShutdown(name, hook) {
    if (state !== 'running') throw new Error('Cannot register a shutdown hook after draining starts');
    if (!name || typeof hook !== 'function')
      throw new TypeError('Shutdown hooks require a name and function');
    hooks.push({ name, hook });
    return () => {
      const index = hooks.findIndex((entry) => entry.name === name && entry.hook === hook);
      if (index >= 0) hooks.splice(index, 1);
    };
  }

  async function shutdown(reason = 'manual') {
    if (shutdownPromise) return shutdownPromise;
    state = 'draining';
    shutdownPromise = (async () => {
      const failures = [];
      for (const { name, hook } of [...hooks].reverse()) {
        try {
          await withTimeout(
            Promise.resolve().then(() => hook({ reason })),
            timeoutMs,
            name
          );
        } catch (error) {
          failures.push({ name, error });
        }
      }
      state = failures.length ? 'failed' : 'stopped';
      return { reason, state, failures };
    })();
    return shutdownPromise;
  }

  function installSignalHandlers(signals = ['SIGINT', 'SIGTERM']) {
    if (installed) return () => uninstallSignalHandlers();
    installed = true;
    for (const signal of signals) {
      const listener = () => void shutdown(signal);
      listeners.set(signal, listener);
      process.once(signal, listener);
    }
    return () => uninstallSignalHandlers();
  }

  function uninstallSignalHandlers() {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    listeners.clear();
    installed = false;
  }

  return Object.freeze({
    get state() {
      return state;
    },
    onShutdown,
    shutdown,
    installSignalHandlers,
    uninstallSignalHandlers,
  });
}
