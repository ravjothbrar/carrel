// Counts requests that left this device since the page finished loading, as far as the page can
// observe. Two sources:
//   * the main thread's Resource Timing entries (cross-origin, or same-origin and not served from
//     cache / the service worker),
//   * each model worker's guarded fetch, which reports every request it makes.
// It also counts requests the CSP blocked. This is a convenience readout, not a proof: the
// airplane-mode test and your browser's network panel are the real check.

export class NetCounter {
  constructor() {
    this.count = 0; // requests to other hosts (model downloads) plus every request a model worker makes
    this.local = 0; // this site's own files fetched from the network after load
    this.blocked = 0;
    this.failed = 0; // attempts that got no response (offline, blocked by the network)
    this.hosts = new Map();
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this.snapshot());
  }

  snapshot() {
    return { count: this.count, local: this.local, failed: this.failed, blocked: this.blocked, hosts: Object.fromEntries(this.hosts) };
  }

  record(host) {
    this.count++;
    this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1);
    this.#emit();
  }

  recordFailed() {
    this.failed++;
    this.#emit();
  }

  /** Begin observing the page. Call once the page has loaded. */
  watchPage(win = globalThis) {
    const seen = new Set(win.performance.getEntriesByType('resource').map((e) => `${e.name}@${e.startTime}`));
    try {
      const po = new win.PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const key = `${e.name}@${e.startTime}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let url;
          try {
            url = new URL(e.name);
          } catch {
            continue;
          }
          if (url.protocol === 'blob:' || url.protocol === 'data:') continue;
          const crossOrigin = url.origin !== win.location.origin;
          const fromNetwork = e.transferSize > 0 || (e.transferSize === 0 && e.encodedBodySize === 0 && e.decodedBodySize === 0 && e.duration > 0 && crossOrigin);
          if (crossOrigin) this.record(url.host);
          else if (fromNetwork) {
            this.local++;
            this.#emit();
          }
        }
      });
      po.observe({ type: 'resource', buffered: false });
    } catch {
      /* PerformanceObserver unavailable: the worker counts still work */
    }
    win.addEventListener('securitypolicyviolation', () => {
      this.blocked++;
      this.#emit();
    });
  }
}
