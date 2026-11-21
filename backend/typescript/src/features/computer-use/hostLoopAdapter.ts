/**
 * ADR 1136 D1 — a `ComputerUseAdapter` whose loop runs on the host.
 *
 * Every frontier computer-use API is client-executed: the model proposes an
 * action and the caller runs it. So the host runs the loop: the driver picks
 * an operation from a snapshot, the adapter offers it to the session loop as a
 * pending action, and only an approved action reaches the executor. The
 * session loop (`computerUseService.advance`) is unchanged: it still tiers,
 * checks the allowlist, refuses credentials and halts commit for the opener.
 *
 * What this adapter adds:
 *  - every pending action carries a URL the allowlist judges: the target for a
 *    navigation or a link, otherwise the page the executor is on now. A click
 *    that took the browser off the allowlist fails the next step closed;
 *  - a commit-tier operation that times out is never replayed. The session
 *    records the step `uncertain`, drops its read of the page, and so the
 *    next executor call is a fresh snapshot;
 *  - a result that fails its operation's shape ends the session `bad_result`;
 *  - a replaced or detached executor ends the session;
 *  - an interact or observe step after which the executor reports a navigation
 *    or a form submission ends the session `unapproved_effect` (ADR 1136 P2
 *    entry criterion 3). A page script did something nobody approved: the step
 *    is recorded `uncertain`, one final snapshot is taken for the record, and
 *    the session never resumes. The person can start a new one.
 *
 * Session state is in memory, like the connection it rides. P2 adds a durable
 * record when a real executor exists to resume against.
 */
import type { ComputerUseAdapter, CuAction, CuPollResult, CuResult, CuTier } from './adapter.js';
import { classifyOp } from './browserTier.js';
import { renderSnapshot, type BrowserDriver, type DriverStep } from './browserDriver.js';
import { validateResult, type BrowserExecutor, type ExecutorOp, type PageSnapshot } from './executorProtocol.js';

export const DEFAULT_OP_TIMEOUT_MS = 15_000;

interface Pending { action: CuAction; op: ExecutorOp; tier: CuTier }

interface LoopSession {
  task: string;
  executor: BrowserExecutor;
  snapshot: PageSnapshot | null;
  history: DriverStep[];
  pending?: Pending;
  seq: number;
  done?: string;
  failed?: string;
}

export interface HostLoopOptions {
  driver: BrowserDriver;
  /** The opener's attached browser, resolved once at start. Null ⇒ the session
   *  fails `browser_not_connected` and nothing claims to work (ADR 1136 D7). */
  executor: () => BrowserExecutor | null;
  opTimeoutMs?: number;
}

export function hostLoopAdapter(opts: HostLoopOptions): ComputerUseAdapter {
  const sessions = new Map<string, LoopSession>();
  const timeoutMs = opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  let seq = 0;

  const run = async (s: LoopSession, op: ExecutorOp) => {
    if (s.executor.state() !== 'attached') return { ok: false as const, error: s.executor.state() === 'replaced' ? 'replaced' as const : 'detached' as const };
    let raw: unknown;
    try {
      raw = await s.executor.perform(op, { timeoutMs });
    } catch {
      raw = { ok: false, error: 'detached' };
    }
    return validateResult(op, raw);
  };

  /** Read the page when the loop has no current read (start, after any
   *  operation that does not return one, after a stale ref or a timed-out
   *  commit). Returns an error string to end the session with, or null. */
  const ensureSnapshot = async (s: LoopSession): Promise<string | null> => {
    if (s.snapshot) return null;
    const r = await run(s, { op: 'snapshot' });
    if (!r.ok) return r.error === 'replaced' ? 'executor_replaced' : r.error === 'detached' ? 'browser_not_connected' : `executor_${r.error}`;
    s.snapshot = r.snapshot ?? null;
    return s.snapshot ? null : 'executor_bad_result';
  };

  return {
    async startSession({ task, startUrl }): Promise<CuResult<{ providerSessionId: string }>> {
      const executor = opts.executor();
      if (!executor) return { ok: false, error: 'browser_not_connected' };
      const id = `host-loop-${++seq}`;
      const s: LoopSession = { task, executor, snapshot: null, history: [], seq: 0 };
      sessions.set(id, s);
      const r = await run(s, { op: 'navigate', url: startUrl });
      if (!r.ok) {
        sessions.delete(id);
        return { ok: false, error: r.error === 'detached' ? 'browser_not_connected' : `executor_${r.error}` };
      }
      s.snapshot = r.snapshot ?? null;
      return { ok: true, value: { providerSessionId: id } };
    },

    async pollSession(id): Promise<CuResult<CuPollResult>> {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'unknown_session' };
      if (s.failed) return { ok: true, value: { status: 'failed', error: s.failed } };
      if (s.done !== undefined) return { ok: true, value: { status: 'completed', resultSummary: s.done } };
      if (s.pending) return { ok: true, value: { status: 'running', pendingAction: s.pending.action } };
      const err = await ensureSnapshot(s);
      if (err) { s.failed = err; return { ok: true, value: { status: 'failed', error: err } }; }
      const page = s.snapshot!;
      const decision = await opts.driver.next({ task: s.task, snapshot: renderSnapshot(page), history: s.history });
      if (decision.kind === 'done') { s.done = decision.summary; return { ok: true, value: { status: 'completed', resultSummary: decision.summary } }; }
      if (decision.kind === 'fail') { s.failed = `driver_failed:${decision.error}`; return { ok: true, value: { status: 'failed', error: s.failed } }; }
      const op = decision.op;
      const element = 'ref' in op ? page.elements.find((e) => e.ref === op.ref) : undefined;
      const c = classifyOp(op, element);
      const action: CuAction = { actionId: `a${++s.seq}`, kind: c.kind, url: c.url ?? page.url, description: c.label };
      s.pending = { action, op, tier: c.tier };
      return { ok: true, value: { status: 'running', pendingAction: action } };
    },

    async submitDecision(id, actionId, approve): Promise<CuResult<{ accepted: boolean }>> {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'unknown_session' };
      const p = s.pending;
      if (!p || p.action.actionId !== actionId) return { ok: false, error: 'stale_action' };
      s.pending = undefined;
      if (!approve) { s.failed = 'action_denied'; return { ok: true, value: { accepted: true } }; }
      const r = await run(s, p.op);
      if (r.ok && p.tier !== 'commit' && (r.effects?.navigated || r.effects?.submitted)) {
        s.history.push({ label: p.action.description, outcome: 'uncertain' });
        s.snapshot = null;
        await ensureSnapshot(s); // the record of where the page ended up; its own failure does not change the outcome
        s.failed = 'unapproved_effect';
      } else if (r.ok) {
        s.snapshot = r.snapshot ?? null;
        s.history.push({ label: p.action.description, outcome: 'done' });
      } else if (r.error === 'timeout') {
        // Never replayed. A commit that may or may not have happened makes the
        // page state unknown: the next step reads before anything else.
        s.snapshot = null;
        s.history.push({ label: p.action.description, outcome: p.tier === 'commit' ? 'uncertain' : 'error' });
      } else if (r.error === 'stale_ref') {
        s.snapshot = null;
        s.history.push({ label: p.action.description, outcome: 'stale_ref' });
      } else if (r.error === 'navigation_refused') {
        s.history.push({ label: p.action.description, outcome: 'refused' });
      } else {
        s.failed = r.error === 'replaced' ? 'executor_replaced' : r.error === 'detached' ? 'browser_not_connected' : `executor_${r.error}`;
      }
      return { ok: true, value: { accepted: true } };
    },

    async handOver(id, actionId): Promise<CuResult<{ accepted: boolean }>> {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'unknown_session' };
      const p = s.pending;
      if (!p || p.action.actionId !== actionId) return { ok: false, error: 'stale_action' };
      // Never performed: the person does this step in their own window. Their
      // typing changes the page, so the next poll reads it afresh.
      s.pending = undefined;
      s.snapshot = null;
      s.history.push({ label: p.action.description, outcome: 'handed_over' });
      return { ok: true, value: { accepted: true } };
    },

    async abortSession(id) {
      const s = sessions.get(id);
      if (s) { s.pending = undefined; s.failed = s.failed ?? 'aborted'; }
    },
  };
}
