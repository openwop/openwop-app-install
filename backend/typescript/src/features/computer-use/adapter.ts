/**
 * ADR 0418 P1 — the computer-use provider adapter seam + the deterministic
 * mock. The provider hosts the browser/VM; the host drives a poll→decide loop.
 * Every provider (Anthropic first, P2) implements this contract; the mock
 * replays a scripted session so the ENTIRE control loop — tiering, allowlist,
 * ceilings, approval halts, replay — is testable with zero egress.
 */

export type CuActionKind = 'screenshot' | 'scroll' | 'read' | 'click' | 'type' | 'navigate' | 'download' | 'submit' | 'credential';

export interface CuAction {
  actionId: string;
  kind: CuActionKind;
  /** Provider-reported target URL (navigation/download) — allowlist-enforced host-side. */
  url?: string;
  description: string;
}

export type CuTier = 'observe' | 'interact' | 'commit';

/** The closed risk-tier classification (ADR 0418 §Decision 2):
 *  observe = read-only (auto-approved); interact = on-page input (session-
 *  approved by starting the task); commit = side effects, new origins,
 *  downloads — EACH gated by the opener's approval (ADR 0894 D3); credential
 *  entry is commit-tier here but refused outright by the loop (D6). */
export function tierOf(action: CuAction): CuTier {
  switch (action.kind) {
    case 'screenshot':
    case 'scroll':
    case 'read':
      return 'observe';
    case 'click':
    case 'type':
      return 'interact';
    case 'navigate':
    case 'download':
    case 'submit':
    case 'credential':
      return 'commit';
  }
}

export interface CuPollResult {
  status: 'running' | 'completed' | 'failed';
  /** The next action the provider wants to take (absent when completed/failed). */
  pendingAction?: CuAction;
  resultSummary?: string;
  error?: string;
}

export type CuResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** ADR 1136 P3a — `handOver`'s answer when this session's browser is not the
 *  person's own window: the step is refused as before, not handed over. */
export const TAKEOVER_UNSUPPORTED = 'takeover_unsupported';

export interface ComputerUseAdapter {
  startSession(input: { task: string; startUrl: string }): Promise<CuResult<{ providerSessionId: string }>>;
  pollSession(providerSessionId: string): Promise<CuResult<CuPollResult>>;
  submitDecision(providerSessionId: string, actionId: string, approve: boolean): Promise<CuResult<{ accepted: boolean }>>;
  abortSession(providerSessionId: string): Promise<void>;
  /**
   * ADR 1136 P3a — hand the pending action to the PERSON instead of refusing it.
   * Only an adapter whose browser the person can see and use offers this (the
   * host-run loop over their own window). The action is dropped, never performed,
   * and the next poll reads the page afresh. Absent ⇒ no take-over: a credential
   * step fails the session as before.
   */
  handOver?(providerSessionId: string, actionId: string): Promise<CuResult<{ accepted: boolean }>>;
}

// ── the mock provider ───────────────────────────────────────────────────────

interface MockScript {
  actions: CuAction[];
  resultSummary?: string;
  /** Polls that report "still working" (no action yet) before the first
   *  action — what a real provider does while its model thinks. */
  thinkPolls?: number;
  /** ADR 1136 P3a — this session's browser is the person's own window, so a
   *  credential step is handed to them. Absent ⇒ the mock declines, as a hosted
   *  provider does. */
  takeover?: boolean;
}

/** Deterministic scripted adapter. The script rides the TASK string as JSON
 *  (`mock:{...}`) so tests fully control the session; a non-mock task yields a
 *  single screenshot then completion. Approved actions advance the cursor; a
 *  denied action ends the session failed (mirroring a real abort). */
export function makeMockAdapter(): ComputerUseAdapter & { calls: { start: number; poll: number; decide: number } } {
  const sessions = new Map<string, { script: MockScript; cursor: number; failed?: string; thought: number }>();
  let seq = 0;
  const calls = { start: 0, poll: 0, decide: 0 };
  return {
    calls,
    async startSession({ task }) {
      calls.start += 1;
      const script: MockScript = task.startsWith('mock:')
        ? (JSON.parse(task.slice(5)) as MockScript)
        : { actions: [{ actionId: 'a1', kind: 'screenshot', description: 'initial screenshot' }], resultSummary: 'done' };
      const id = `mock-session-${++seq}`;
      sessions.set(id, { script, cursor: 0, thought: 0 });
      return { ok: true, value: { providerSessionId: id } };
    },
    async pollSession(id) {
      calls.poll += 1;
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'unknown_session' };
      if (s.failed) return { ok: true, value: { status: 'failed', error: s.failed } };
      if (s.thought < (s.script.thinkPolls ?? 0)) { s.thought += 1; return { ok: true, value: { status: 'running' } }; }
      const next = s.script.actions[s.cursor];
      if (!next) return { ok: true, value: { status: 'completed', resultSummary: s.script.resultSummary ?? 'completed' } };
      return { ok: true, value: { status: 'running', pendingAction: next } };
    },
    async submitDecision(id, actionId, approve) {
      calls.decide += 1;
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'unknown_session' };
      const next = s.script.actions[s.cursor];
      if (!next || next.actionId !== actionId) return { ok: false, error: 'stale_action' };
      if (!approve) { s.failed = 'action_denied'; return { ok: true, value: { accepted: true } }; }
      s.cursor += 1;
      return { ok: true, value: { accepted: true } };
    },
    async abortSession(id) {
      const s = sessions.get(id);
      if (s) s.failed = 'aborted';
    },
    async handOver(id, actionId) {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'unknown_session' };
      if (!s.script.takeover) return { ok: false, error: TAKEOVER_UNSUPPORTED };
      const next = s.script.actions[s.cursor];
      if (!next || next.actionId !== actionId) return { ok: false, error: 'stale_action' };
      s.cursor += 1; // the person does it; the agent never performs this action
      return { ok: true, value: { accepted: true } };
    },
  };
}
