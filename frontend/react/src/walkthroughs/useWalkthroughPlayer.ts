/**
 * The walkthrough player core (ADR 0368 Phase 2) — the perform/resolve loop.
 *
 * launch(walkthroughId) creates an ORDINARY run of the tour workflow (stamped
 * `run.metadata.guidedTour` at creation — the chat-feed scoping mitigation +
 * replay-safe attribution), subscribes to its SSE, and for each `walkthrough-step`
 * interrupt: navigates to the action's route, resolves the target through
 * the SEMANTIC action registry, performs the verb (scripted steps) or waits
 * for the real user (HITL steps), and resolves the interrupt — resolve IS
 * "step done" (the node completes with the resume value as outputs).
 *
 * Honesty rules baked in:
 *  - unknown actionId / unresolvable element after retries ⇒ PAUSE with
 *    `needsUpdate` (this walkthrough references UI that moved), never a silent hang;
 *  - a failed checkpoint ⇒ CANCEL the run (aborted in run history);
 *  - any user click outside the spotlight target ⇒ pause (the chrome wires
 *    this in Phase 3 — the hook exposes pause()).
 *
 * Reload re-attach: the active {runId, walkthroughId} lives in sessionStorage; a
 * remount re-subscribes and continues from the open interrupt (the durable
 * run IS the paused state).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRun, cancelRun, getRun } from '../client/runsClient.js';
import { subscribeToRun, type Subscription } from '../client/streamsClient.js';
import { resolveByRun } from '../client/interruptsClient.js';
import { scrollBehavior } from '../ui/motion.js';
import { WopError } from '@openwop/openwop';
import { errorCodeOf } from '../client/classifyHttpError.js';
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { getWorkflowDefinition } from '../client/workflowsClient.js';
import { getWalkthroughAction, getWalkthroughCheckpoint, narrowCheckpointVerdict, type WalkthroughAction } from './actionRegistry.js';

export type WalkthroughPlayerStatus =
  | 'idle'
  | 'starting'
  | 'performing'   // driving a scripted step
  | 'waiting-user' // an HITL step — the real user acts
  | 'paused'
  | 'needs-update' // an action id no longer resolves — the walkthrough is stale
  | 'completed'
  | 'failed';

export interface WalkthroughStepView {
  actionId?: string;
  narration?: string;
  hitl: boolean | { prompt?: string };
  nodeId: string;
}

/** ADR 0378 P2a — one entry per step for the steps panel, in DEF order.
 *  Derived from the fetched definition's `nodes[]` array — for the LINEAR DAGs
 *  every walkthrough producer emits (synthesis, the author tool, the builtin),
 *  array order IS execution order; a toposort would be over-engineering. */
export interface WalkthroughStepInfo {
  nodeId: string;
  narration?: string;
  hitl: boolean;
  checkpoint: boolean;
}

interface ActiveWalkthrough { runId: string; walkthroughId: string }
const SESSION_KEY = 'openwop.walkthrough.active';

/** Element-resolve retry budget: route transitions + lazy panels settle fast;
 *  past this the walkthrough is honestly stale. */
const RESOLVE_RETRIES = 20;
const RESOLVE_INTERVAL_MS = 250;

/** Resolve a walkthrough-step interrupt, tolerating the ONE benign race: the interrupt
 *  already closed. A duplicate resolve (double-advance, a re-attached stream
 *  re-firing) or a run that advanced/cancelled leaves no open interrupt, so the
 *  server answers `interrupt_not_found` (404) / `interrupt_gone` (410). For the
 *  player that is success — the step is done and the next `node.suspended`
 *  drives the next step — NOT the hard error it used to surface (the
 *  `interrupt_not_found` banner seen mid-walkthrough). Any OTHER failure still throws:
 *  this narrows the tolerance to the already-resolved case rather than the
 *  blanket `.catch(() => undefined)` the run mutations here use, so a real
 *  network/500 failure is never silently swallowed. */
async function resolveStep(runId: string, nodeId: string, resumeValue: unknown): Promise<void> {
  try {
    await resolveByRun(runId, nodeId, resumeValue);
  } catch (err) {
    // Read the code through the app's one choke: on the major-2 wire an
    // unregistered code arrives as `openwop-app.<code>` and is normalized there.
    const code = err instanceof WopError ? errorCodeOf(err) : null;
    if (code === 'interrupt_not_found' || code === 'interrupt_gone') {
      return; // already resolved / run advanced — benign for the player
    }
    throw err;
  }
}

export interface WalkthroughPlayer {
  status: WalkthroughPlayerStatus;
  step: WalkthroughStepView | null;
  /** The live target of the current step (spotlight geometry — Phase 3). */
  target: HTMLElement | null;
  error: string | null;
  launch(walkthroughId: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  /** Resolve the current manual-HITL step (ADR 0378 P1 — the ONE confirm path). */
  confirmHitl(): Promise<void>;
  /** ADR 0378 P2a — the full step list in def order (best-effort; [] when the
   *  def fetch failed) + the current position, both for the steps panel. */
  steps: WalkthroughStepInfo[];
  position: { index: number; total: number } | null;
  /** Grade-pass — true when the current HITL step attached an auto-completer.
   *  False ⇒ the chrome shows "I did it" as the manual fallback, so a pack
   *  whose hitlComplete could not attach never dead-ends the walkthrough. */
  hitlAuto: boolean;
  /** ADR 0489 D2 — steps this run SKIPPED because their checkpoint reported the
   *  state already satisfied, with the learner-facing reason. The steps panel
   *  renders these as a third state so a skip is never silently invisible.
   *
   *  KNOWN BOUND (accepted, not a defect to hunt): this list is session state and
   *  resets on reload. The RUN keeps the truth — the skip is frozen into the
   *  node's resume value at resolve time — but the interrupts read exposes only
   *  the interrupt `data` (the step payload), never the resume value, so the
   *  markers cannot be reconstructed on re-attach without a new read. The cost is
   *  cosmetic (panel markers for already-passed steps) and the run record stays
   *  authoritative, so this is deliberately not worth a new endpoint. */
  skipped: Array<{ nodeId: string; because: string }>;
}

export function useWalkthroughPlayer(): WalkthroughPlayer {
  const nav = useNavigate();
  const [status, setStatus] = useState<WalkthroughPlayerStatus>('idle');
  const [step, setStep] = useState<WalkthroughStepView | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<WalkthroughStepInfo[]>([]);
  const subRef = useRef<Subscription | null>(null);
  const activeRef = useRef<ActiveWalkthrough | null>(null);
  const pausedRef = useRef(false);
  const hitlOffRef = useRef<(() => void) | null>(null);
  // Grade-pass — the stash carries the interrupt DATA too: resuming a paused
  // checkpoint/fill step needs `data.checkpoint`/`data.prefill`, which the
  // view alone loses (the resume-drops-prefill defect).
  const pendingRef = useRef<{ view: WalkthroughStepView; data: Record<string, unknown> } | null>(null);
  const [hitlAuto, setHitlAuto] = useState(false);
  const [skipped, setSkipped] = useState<Array<{ nodeId: string; because: string }>>([]);

  const teardown = useCallback(() => {
    subRef.current?.close();
    subRef.current = null;
    hitlOffRef.current?.();
    hitlOffRef.current = null;
    setHitlAuto(false);
    sessionStorage.removeItem(SESSION_KEY);
    activeRef.current = null;
    setStep(null);
    setTarget(null);
    setSteps([]);
    setSkipped([]);
  }, []);

  const resolveElement = useCallback(async (action: WalkthroughAction, live: () => boolean): Promise<HTMLElement | null> => {
    for (let i = 0; i < RESOLVE_RETRIES; i++) {
      if (!live()) return null; // stopped/paused mid-retry — bail within one tick
      const el = action.resolve();
      if (el) return el;
      await new Promise((res) => setTimeout(res, RESOLVE_INTERVAL_MS));
    }
    return null;
  }, []);

  const performStep = useCallback(async (view: WalkthroughStepView, data: Record<string, unknown>) => {
    const active = activeRef.current;
    if (!active) return;
    if (pausedRef.current) { pendingRef.current = { view, data }; return; }
    setStep(view);
    // Grade-pass liveness: stop()/teardown or a new launch invalidates THIS
    // step's in-flight work. Every await below re-checks — without it a
    // checkpoint poll or element retry finishing after Stop would click the
    // UI / flip needs-update on a walkthrough the user already quit.
    const live = () => activeRef.current?.runId === active.runId;
    const stash = () => { if (live() && pausedRef.current) pendingRef.current = { view, data }; };

    // Checkpoint (ADR 0489 D1) — THREE outcomes:
    //   pass              ⇒ resolve, continue;
    //   already-satisfied ⇒ resolve as done+SKIPPED, narrate why, NEVER cancel;
    //   fail              ⇒ cancel the run (honest in run history) — unchanged.
    const checkpointId = typeof data.checkpoint === 'string' ? data.checkpoint : undefined;
    if (checkpointId) {
      const cp = getWalkthroughCheckpoint(checkpointId);
      // narrowCheckpointVerdict is FAIL-CLOSED: a malformed return can never be
      // read as "already satisfied" (that would silently skip a step on garbage).
      const verdict = cp ? narrowCheckpointVerdict(await cp.evaluate()) : 'unknown checkpoint';
      if (!live()) return; // stopped while evaluating — discard the result
      if (pausedRef.current) { stash(); return; }
      if (verdict === null) {
        await resolveStep(active.runId, view.nodeId, { passed: true });
      } else if (typeof verdict === 'object') {
        // ADR 0489 D2 — bounded: ONE step, evaluated per step. Never a phase
        // fast-forward on a single verdict, and the skip stays VISIBLE (the
        // steps panel marks it) so the learner can see what was bypassed.
        setSkipped((prev) => (prev.some((s) => s.nodeId === view.nodeId)
          ? prev
          : [...prev, { nodeId: view.nodeId, because: verdict.because }]));
        setStep({ ...view, narration: verdict.because });
        await resolveStep(active.runId, view.nodeId, { passed: true, skipped: true, because: verdict.because });
      } else {
        setStatus('needs-update');
        setError(verdict);
        await cancelRun(active.runId, 'walkthrough checkpoint failed').catch(() => undefined);
        teardown();
      }
      return;
    }

    const action = view.actionId ? getWalkthroughAction(view.actionId) : undefined;
    if (!action) {
      setStatus('needs-update');
      setError(view.actionId ?? 'missing actionId');
      return; // interrupt stays open — Resume can retry after a fix/reload
    }
    if (window.location.pathname !== action.route) nav(action.route);
    const el = await resolveElement(action, live);
    if (!live()) return;
    if (pausedRef.current) { stash(); return; }
    if (!el) {
      setStatus('needs-update');
      setError(view.actionId ?? '');
      return;
    }
    setTarget(el);

    if (view.hitl) {
      // Only the REAL USER resolves an HITL step.
      setStatus('waiting-user');
      hitlOffRef.current?.();
      hitlOffRef.current = null;
      // Grade-pass: hitlComplete may return null (could not attach — e.g. its
      // companion element is missing). hitlAuto=false makes the chrome show
      // "I did it" so the step can NEVER dead-end.
      const off = action.hitlComplete
        ? action.hitlComplete(el, (value) => {
            hitlOffRef.current = null;
            setHitlAuto(false);
            void resolveStep(active.runId, view.nodeId, { acked: true, hitlValue: value });
          })
        : null;
      if (off) hitlOffRef.current = off;
      setHitlAuto(Boolean(off));
      // §Correction (grade-code `WT-1`) — STASH SO PAUSE→RESUME CAN COME BACK.
      // Every other branch that returns early stashes; this one did not, so a
      // pause taken during `waiting-user` (Escape) left `pendingRef` null, and
      // `resume()` then fell to its unconditional `setStatus('performing')`.
      // Nothing was driving: `hitlAuto` went false, the "I did it" button
      // disappeared, and `confirmHitl` early-returns unless status is
      // 'waiting-user' — so the step was stranded in a permanent false
      // 'performing' with Stop + relaunch the only exit.
      stash();
      return;
    }

    setStatus('performing');
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: scrollBehavior() }); // jsdom lacks it
    if (action.perform) {
      await action.perform(el, data.prefill as Record<string, unknown> | undefined);
    } else if (action.verb === 'fill') {
      const value = String((data.prefill as Record<string, unknown> | undefined)?.value ?? '');
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (action.verb === 'select') {
      // ADR 0378 P1 — a scripted select previously fell through to el.click()
      // (which opens the dropdown but selects nothing). Same native-setter
      // idiom as `fill`, with `change` (selects don't fire `input` on set).
      const value = String((data.prefill as Record<string, unknown> | undefined)?.value ?? '');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action.verb === 'focus') {
      el.focus();
    } else {
      el.click();
    }
    if (!live()) return; // stopped while performing — never resolve a dead run
    await resolveStep(active.runId, view.nodeId, { acked: true, ...(view.actionId ? { actionId: view.actionId } : {}) });
  }, [nav, resolveElement, teardown]);

  /** WALK-8 — performStep is fire-and-forget at its call sites; a non-benign
   *  failure (a real 500 from resolveStep rethrowing past the 404/410
   *  tolerance) must surface as a warning, never an unhandled rejection.
   *
   *  ...and must also surface TO THE LEARNER, which the warning alone did not.
   *  WALK-8 fixed the rejection and left the user waiting: status stayed
   *  `running`, the interrupt stayed open, the overlay kept highlighting the
   *  element, and the only trace was a console line nobody mid-walkthrough is
   *  reading. A step that will never advance, presented as a step in progress —
   *  the failed-read family, in the one surface whose whole job is telling
   *  someone what to do next.
   *
   *  `needs-update` is the right state and is already used for three sibling
   *  failures in this file (unknown checkpoint, missing actionId, failed
   *  checkpoint). The `live()` guard matters: a step that fails because the
   *  learner navigated away or stopped is not something to interrupt them with. */
  const guardedPerform = useCallback((view: WalkthroughStepView, data: Record<string, unknown>) => {
    // `performStep` has its own local `live()`; this is the same test rebuilt at
    // this scope — capture the run before the call and only speak if it is still
    // the run in play when the failure lands.
    const startedFor = activeRef.current?.runId;
    void performStep(view, data).catch((err) => {
      console.warn('[walkthroughs] step perform failed', err);
      if (!startedFor || activeRef.current?.runId !== startedFor) return;
      setStatus('needs-update');
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [performStep]);


  /** Best-effort progress writes (ADR 0368 P5) — the /test runner's
   *  completed chip + cross-tab resume ride these rows. */
  const recordProgress = useCallback(async (walkthroughId: string, runId: string, st: 'started' | 'completed') => {
    await fetch(`${config.baseUrl}/host/openwop-app/walkthroughs/progress`, fetchOpts({
      method: 'POST',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ walkthroughId, status: st, runId }),
    })).catch((err) => console.warn('[walkthroughs] progress write failed (best-effort)', err));
  }, []);

  /** `node.suspended` carries only {interruptId, kind} — the step PAYLOAD
   *  lives on the interrupt record, so each suspension (and every re-attach)
   *  fetches the open walkthrough-step interrupt. */
  const fetchOpenStep = useCallback(async (runId: string) => {
    const res = await fetch(
      `${config.baseUrl}/host/openwop-app/runs/${encodeURIComponent(runId)}/interrupts`,
      fetchOpts({ headers: authedHeaders() }),
    );
    if (!res.ok) return;
    const { interrupts } = (await res.json()) as { interrupts: Array<{ nodeId: string; kind: string; resolvedAt?: string; data?: Record<string, unknown> }> };
    const open = interrupts.find((i) => !i.resolvedAt && (i.kind === 'walkthrough-step' || i.kind === 'tour-step'));
    if (!open) return;
    const data = open.data ?? {};
    void guardedPerform({
      ...(typeof data.actionId === 'string' ? { actionId: data.actionId } : {}),
      ...(typeof data.narration === 'string' ? { narration: data.narration } : {}),
      hitl: (data.hitl ?? false) as WalkthroughStepView['hitl'],
      nodeId: open.nodeId,
    }, data);
  }, [guardedPerform]);

  const attach = useCallback((active: ActiveWalkthrough) => {
    activeRef.current = active;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(active));
    subRef.current?.close();
    subRef.current = subscribeToRun(active.runId, {
      // A walkthrough waits on humans: no absolute timeout; generous idle.
      idleTimeoutMs: 10 * 60_000,
      absoluteTimeoutMs: 24 * 60 * 60_000,
      onEvent: (ev) => {
        const type = ev.type as string;
        if (type === 'node.suspended' || type === 'interrupt.created') {
          const kind = ((ev as { payload?: { kind?: string } }).payload?.kind);
          if (kind === 'walkthrough-step' || kind === 'tour-step') void fetchOpenStep(active.runId);
        } else if (type === 'run.completed') {
          setStatus('completed');
          void recordProgress(active.walkthroughId, active.runId, 'completed');
          teardown();
        } else if (type === 'run.failed' || type === 'run.cancelled') {
          setStatus('failed');
          teardown();
        }
      },
    });
    // Covers re-attach AND the suspend-before-subscribe race.
    void fetchOpenStep(active.runId);
    // ADR 0378 P2a — fetch the def ONCE per attach for the steps panel +
    // "Step n of m". Best-effort: a failure leaves steps [] / position null
    // and never blocks the walkthrough.
    void getWorkflowDefinition(active.walkthroughId).then((def) => {
      if (!def || activeRef.current?.runId !== active.runId) return;
      setSteps(def.nodes.map((n) => {
        const cfg = n.config ?? {};
        return {
          nodeId: n.nodeId,
          ...(typeof cfg.narration === 'string' ? { narration: cfg.narration } : {}),
          hitl: cfg.hitl === true || (typeof cfg.hitl === 'object' && cfg.hitl !== null),
          checkpoint: typeof cfg.expect === 'string' || typeof cfg.checkpoint === 'string',
        };
      }));
    });
  }, [fetchOpenStep, recordProgress, teardown]);

  const launch = useCallback(async (walkthroughId: string) => {
    setStatus('starting');
    setError(null);
    // Resume-or-restart: an in-flight progress row re-attaches to ITS run
    // (cross-tab / came-back-later); fetchOpenStep continues from the open
    // interrupt, and a terminal run simply yields nothing — the catch below
    // starts fresh.
    try {
      const res = await fetch(`${config.baseUrl}/host/openwop-app/walkthroughs/progress`, fetchOpts({ headers: authedHeaders() }));
      if (res.ok) {
        const { progress } = (await res.json()) as { progress: Array<{ walkthroughId: string; status: string; runId: string }> };
        const inFlight = progress.find((r) => r.walkthroughId === walkthroughId && r.status === 'started');
        if (inFlight) {
          // ADR 0730 C.4 — the major-2 run snapshot via the shared client, which
          // binds the run id to the caller's tenant and unbinds it on the way
          // back. A raw v1 fetch here would have sent the BARE id, which the
          // major-2 route does not address.
          const snap = await getRun(inFlight.runId);
          if (typeof snap.status === 'string' && snap.status.startsWith('waiting')) {
            attach({ runId: inFlight.runId, walkthroughId });
            return;
          }
        }
      }
    } catch { /* fall through to a fresh start */ }
    // §Correction (grade-ux `B1` / grade-code `WT-3`) — A FAILED LAUNCH MUST BE
    // VISIBLE. `createRun` was unwrapped and the only caller is
    // `void player.launch(...)`, so a rejection (a 404 on an unregistered
    // chain, an offline network, a 429) was swallowed: `status` stayed
    // 'starting' forever, `error` stayed null, and the learner got a floating
    // bar claiming a walkthrough was running with no scrim, no step, no
    // explanation and no retry. That is the ADR 0491 "false promise" shape one
    // layer down, and it is exactly how the unregistered tutorial chains
    // presented before the registration fix.
    try {
      const res = await createRun({
        workflowId: walkthroughId,
        inputs: {},
        // The scoping + attribution stamp (replay-safe: read verbatim on fork).
        // `guidedTour` is a HELD persisted run.metadata key (ADR 0376/0378 —
        // chat-feed scoping + replay attribution read it; renaming buys nothing).
        metadata: { guidedTour: true, walkthroughId },
      });
      void recordProgress(walkthroughId, res.runId, 'started');
      attach({ runId: res.runId, walkthroughId });
    } catch (err) {
      teardown();
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [attach, recordProgress, teardown]);

  const pause = useCallback(() => { pausedRef.current = true; setStatus('paused'); }, []);
  const resume = useCallback(() => {
    pausedRef.current = false;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      // Re-fetch nothing: the interrupt is still open; re-perform with the
      // ORIGINAL interrupt data (checkpoint/prefill survive the pause).
      // An HITL step re-enters its own branch and lands back on 'waiting-user'.
      setStatus('performing');
      guardedPerform(pending.view, pending.data);
    } else {
      // Nothing stashed ⇒ nothing to drive. Claiming 'performing' here is the
      // false-progress shape (grade-code `WT-1`): it asserts a step is being
      // driven when none is. The SSE stream is still attached, so 'starting'
      // is the honest state — waiting for the run to hand us the next step.
      // (Reusing an existing status rather than widening the union, which would
      // need matching chrome + i18n in four locales to say anything new.)
      setStatus('starting');
    }
  }, [guardedPerform]);

  const stop = useCallback(async () => {
    const active = activeRef.current;
    if (active) await cancelRun(active.runId, 'walkthrough stopped').catch(() => undefined);
    setStatus('idle');
    teardown();
  }, [teardown]);

  // Reload re-attach: the durable run IS the paused state.
  useEffect(() => {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const active = JSON.parse(raw) as ActiveWalkthrough;
      if (active.runId && active.walkthroughId) {
        setStatus('starting');
        attach(active);
      }
    } catch { sessionStorage.removeItem(SESSION_KEY); }
    return () => { subRef.current?.close(); };
  }, [attach]);

  /** ADR 0378 P1 — the ONE manual-HITL resolve path. The chrome's "I did it"
   *  button calls this instead of reading sessionStorage + resolveByRun raw,
   *  so the confirm rides the same already-resolved race tolerance as every
   *  other resolve (the #1886 class). No-op unless a step is waiting. */
  const confirmHitl = useCallback(async () => {
    const active = activeRef.current;
    if (!active || status !== 'waiting-user' || !step) return;
    await resolveStep(active.runId, step.nodeId, { acked: true });
  }, [status, step]);

  // ADR 0378 P2a — position derived by matching the open step's nodeId against
  // the def-ordered list; null until the def fetch lands (or if it failed).
  // Memoized on its own so the fresh object literal doesn't churn the outer
  // useMemo's deps on every render (react-hooks/exhaustive-deps).
  const position = useMemo(() => {
    const idx = step ? steps.findIndex((s) => s.nodeId === step.nodeId) : -1;
    return idx >= 0 ? { index: idx, total: steps.length } : null;
  }, [step, steps]);

  // Grade-pass: a stable object so consumers' [player]-keyed effects do not
  // re-subscribe on every render.
  return useMemo(
    () => ({ status, step, target, error, launch, pause, resume, stop, confirmHitl, steps, position, hitlAuto, skipped }),
    [status, step, target, error, launch, pause, resume, stop, confirmHitl, steps, position, hitlAuto, skipped],
  );
}
