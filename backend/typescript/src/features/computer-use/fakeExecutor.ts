/**
 * ADR 1136 P1 — an in-memory browser executor: the reference for the protocol,
 * as `makeMockAdapter` was for the provider seam. It holds fixture pages, not a
 * browser. It can follow a link, report a page, and fail on cue (time out,
 * return a malformed result, refuse a URL, lose or replace its connection), so
 * every rule of `hostLoopAdapter` is testable with no Chromium and no egress.
 *
 * It reports effects as a real executor would: a step that changed the page's
 * URL `navigated`, and a step that reached a `submitsTo` target `submitted`.
 * So a `submitsTo` entry on a ref the tier table calls interact (a checkbox
 * whose page script submits) stands in for a script-promoted step.
 *
 * It cannot render, run scripts, submit a real form or change a page because
 * something was typed. Behaviour that needs those is witnessed in P2 against a
 * real Playwright page.
 */
import { EXECUTOR_PROTOCOL_VERSION, type BrowserExecutor, type ExecutorOp, type PageSnapshot } from './executorProtocol.js';

export interface FakeExecutorOptions {
  pages: Record<string, PageSnapshot>;
  /** Return `{ok:false,error:'timeout'}` for matching ops (the op has no effect). */
  timeoutOn?: (op: ExecutorOp) => boolean;
  /** Return a result that fails its shape for matching ops. */
  malformedOn?: (op: ExecutorOp) => boolean;
  /** Hosts the executor refuses on its own (it never trusts the host alone). */
  refusedHosts?: readonly string[];
  /** Where activating a ref lands (a click, or Enter), by ref. On a ref the
   *  tier table calls interact it models a page script that submits. */
  submitsTo?: Record<string, string>;
  /** Any key (Tab, Escape) on a `submitsTo` ref submits too: a script-bound key handler. */
  scriptSubmitsOnKey?: boolean;
}

export function makeFakeExecutor(opts: FakeExecutorOptions, executorId = 'fake-1'): BrowserExecutor & { calls: ExecutorOp[]; current(): string | null; detach(): void } {
  let state: 'attached' | 'replaced' | 'detached' = 'attached';
  let current: string | null = null;
  const calls: ExecutorOp[] = [];
  const page = (): PageSnapshot | undefined => (current ? opts.pages[current] : undefined);
  const go = (url: string): { ok: true; snapshot: PageSnapshot } | { ok: false; error: 'navigation_refused' | 'timeout' } => {
    let host = '';
    try { host = new URL(url).hostname; } catch { return { ok: false, error: 'navigation_refused' }; }
    if (opts.refusedHosts?.includes(host)) return { ok: false, error: 'navigation_refused' };
    const p = opts.pages[url];
    if (!p) return { ok: false, error: 'timeout' };
    current = url;
    return { ok: true, snapshot: p };
  };
  return {
    executorId,
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    calls,
    current: () => current,
    state: () => state,
    markReplaced() { state = 'replaced'; },
    detach() { state = 'detached'; },
    async perform(op) {
      calls.push(op);
      if (state !== 'attached') return { ok: false, error: state };
      if (opts.timeoutOn?.(op)) return { ok: false, error: 'timeout' };
      if (opts.malformedOn?.(op)) return { ok: true, snapshot: { url: 42 } };
      switch (op.op) {
        case 'snapshot': {
          const p = page();
          return p ? { ok: true, snapshot: p } : { ok: false, error: 'detached' };
        }
        case 'navigate':
          return go(op.url);
        case 'screenshot':
        case 'scroll':
          return { ok: true };
        case 'click':
        case 'type':
        case 'press': {
          const el = page()?.elements.find((e) => e.ref === op.ref);
          if (!el) return { ok: false, error: 'stale_ref' };
          const before = current;
          if (op.op === 'click' && el.href) {
            const r = go(el.href);
            return r.ok ? { ok: true, effects: { navigated: current !== before, submitted: false } } : r;
          }
          const target = op.op !== 'type' ? opts.submitsTo?.[op.ref] : undefined;
          if (target && (op.op === 'click' || (op.op === 'press' && (op.key === 'Enter' || opts.scriptSubmitsOnKey === true)))) {
            const r = go(target);
            return r.ok ? { ok: true, effects: { navigated: current !== before, submitted: true } } : r;
          }
          return { ok: true };
        }
      }
    },
  };
}
