/* SafeResizeObserver — drop-in ResizeObserver whose callback runs inside
   requestAnimationFrame instead of synchronously during layout.

   Why: a ResizeObserver callback that mutates layout (React setState
   re-render, xterm fit(), canvas sizing, ...) can schedule ANOTHER
   notification in the same frame — the browser then fires the benign but
   noisy "ResizeObserver loop completed with undelivered notifications"
   error, which pollutes every error surface (window.__lazyErrors, the
   crash reporter, the status bar's "frontend error" indicator) and makes
   a healthy app look broken. Deferring the callback to the next frame
   breaks that same-frame cycle; notifications arriving while a frame is
   already pending are merged (latest entries win), which is exactly the
   coalescing every consumer here wants anyway. */

export class SafeResizeObserver {
  private inner: ResizeObserver;
  private callback: ResizeObserverCallback;
  private raf = 0;
  private pending: ResizeObserverEntry[] | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    this.inner = new ResizeObserver((entries, observer) => {
      this.pending = entries;
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        const batch = this.pending;
        this.pending = null;
        if (batch) {
          try {
            this.callback(batch, observer);
          } catch {
            /* a consumer-side throw must not break the observer loop */
          }
        }
      });
    });
  }

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.inner.observe(target, options);
  }

  unobserve(target: Element): void {
    this.inner.unobserve(target);
  }

  disconnect(): void {
    this.inner.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pending = null;
  }
}
