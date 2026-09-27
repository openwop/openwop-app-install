/**
 * Workflow Completion Card — persistent record appended below a
 * workflow_run bubble after the run reaches a terminal state.
 *
 * Renders one of three variants based on `workflowRun.status`:
 *   - completed → "Workflow completed" + N View links for the
 *                 terminal nodes (per the architect review's "N
 *                 View links for N terminals" v1 convention).
 *   - failed    → muted-danger row with the error summary + an
 *                 "Open run" link to /runs/:runId for full diagnostics.
 *   - cancelled → muted row noting the cancellation + "Open run" link.
 *
 * Architecture decision: derive, don't persist (Option B). All data
 * comes from the existing `WorkflowRunState` snapshot — no new BE
 * endpoints, no new chat_messages rows, no new event types. Survives
 * reload because the workflow_run message hydrates from the BE event
 * log on session restore.
 *
 * Terminal-node convention (architect review §3): the FE walks the
 * saved workflow graph to find every node with no outgoing edges and
 * surfaces one View link per terminal. Falls back to "Open run" when
 * the graph isn't locally cached (e.g., a workflow saved on a
 * different device).
 */

import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { getSavedWorkflow } from '../builder/persistence/localStore.js';
import { formatElapsed } from './workflowProgress/formatters.js';
import { formatNumber } from '../i18n/format.js';
import { AlertIcon, BanIcon, CheckIcon, ExternalLinkIcon } from '../ui/icons/index.js';
import { announce } from '../ui/announce.js';
import type { WorkflowRunState } from './types.js';

interface Props {
  run: WorkflowRunState;
  /** When set, clicking the View link opens this preview modal handler
   *  instead of relying on default in-page navigation. The handler
   *  receives the terminal node id + its output blob. */
  onPreviewArtifact?: (nodeId: string, output: unknown, label: string) => void;
}

export function WorkflowCompletionCard({ run, onPreviewArtifact }: Props): JSX.Element | null {
  // `t` is used below as the terminal-node loop variable (`terminals.map((t) => …)`),
  // so the translation hook is aliased to `translate` to avoid the name collision.
  const { t: translate } = useTranslation('chat');
  // Hooks MUST come before any conditional return — Rules of Hooks.
  // The previous shape early-returned on non-terminal states and then
  // called hooks below, which throws "Rendered more hooks than during
  // the previous render" the first time a workflow_run flips terminal.
  // Both hooks are cheap during the running phase (no work done, just
  // initial-state reads), so the render-time cost of always calling
  // them is negligible.
  const { terminals, graphUnavailable } = useTerminalNodes(run);
  const elapsed = useElapsedSince(run.startedAt);

  const isTerminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
  if (!isTerminal) return null;

  const stepCount = run.totalNodes > 0
    ? translate('stepCount', {
        completed: formatNumber(run.completedNodeIds.length),
        total: formatNumber(run.totalNodes),
      })
    : translate('steps', { count: run.completedNodeIds.length });

  const unavailable = run.runUnavailable === true;

  if (run.status === 'failed') {
    return (
      <CompletionShell tone="danger" iconKind="alert" title={translate('workflowFailed')}>
        <Meta items={[stepCount, elapsed]} />
        {run.error && (
          <div className="muted wfcomplete-error">
            {run.error.code}: {run.error.message}
          </div>
        )}
        {run.runId && (
          <Actions>
            <OpenRunLink runId={run.runId} unavailable={unavailable} />
          </Actions>
        )}
      </CompletionShell>
    );
  }

  if (run.status === 'cancelled') {
    return (
      <CompletionShell tone="muted" iconKind="ban" title={translate('workflowCancelled')}>
        <Meta items={[stepCount, elapsed]} />
        {run.runId && (
          <Actions>
            <OpenRunLink runId={run.runId} unavailable={unavailable} />
          </Actions>
        )}
      </CompletionShell>
    );
  }

  // status === 'completed'
  return (
    <CompletionShell tone="success" iconKind="check" title={translate('workflowCompleted')}>
      <Meta items={[stepCount, elapsed]} />
      {/* ADR 0600 §4 — say WHY there is no output link, instead of leaving a
          bare "Open run" that reads as "this run produced nothing". */}
      {graphUnavailable && (
        <div className="muted wfcomplete-error" data-testid="wfcomplete-graph-unavailable">
          {translate('outputsNotOnThisDevice')}
        </div>
      )}
      <Actions>
        {terminals.length > 0
          ? terminals.map((t) => (
              <span key={t.nodeId} className="u-iflex u-gap-1 u-items-center">
                <Button
                  variant="secondary" className="u-fs-12"
                  onClick={() => onPreviewArtifact?.(t.nodeId, t.output, t.label)}
                  disabled={!onPreviewArtifact}
                  // Button label:
                  //   - primary-tagged terminal → "View {label}" (author named
                  //     it; lean on that)
                  //   - one terminal, untagged → "View output" (generic;
                  //     legacy v1 behavior)
                  //   - N>1 untagged terminals → "View {label}" (disambiguates)
                  title={t.isPrimary ? translate('primaryOutputTitle') : undefined}
                >
                  {(t.isPrimary || terminals.length > 1) ? translate('viewLabeled', { label: t.label }) : translate('viewOutput')} →
                </Button>
                {run.runId && !unavailable && (
                  // Deep-link companion to the modal-opening View button —
                  // opens /runs/:runId#node-:nodeId in a new tab so the user
                  // can inspect the artifact in the full run-detail surface
                  // (event log, agent trace, etc.) alongside the chat thread.
                  <a
                    href={`/runs/${run.runId}#node-${encodeURIComponent(t.nodeId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={translate('openInRunDetail')}
                    className="wfcomplete-deeplink"
                    aria-label={translate('openLabeledInRunDetail', { label: t.label })}
                  >
                    <ExternalLinkIcon size={12} />
                  </a>
                )}
              </span>
            ))
          : null}
        {run.runId && (
          <span className="wfcomplete-openrun-wrap">
            <OpenRunLink runId={run.runId} unavailable={unavailable} />
          </span>
        )}
      </Actions>
    </CompletionShell>
  );
}

/**
 * Shared "Open run" affordance — renders the link normally when the
 * run is still on the server, or a muted "(unavailable)" placeholder
 * when the orphan-detection probe set `runUnavailable: true`.
 */
function OpenRunLink({ runId, unavailable }: { runId: string; unavailable: boolean }): JSX.Element {
  const { t: translate } = useTranslation('chat');
  if (unavailable) {
    return (
      <span
        className="muted u-fs-12 u-italic"
        title={translate('runRecordUnavailableTitle')}
      >
        {translate('openRunUnavailable')}
      </span>
    );
  }
  return (
    <Link to={`/runs/${runId}`} className="u-fs-12">
      {translate('openRun')}
    </Link>
  );
}

interface Terminal {
  nodeId: string;
  label: string;
  output: unknown;
  /** RFC 0065 — true when the workflow author tagged this node as the
   *  canonical-deliverable artifact. When ≥1 terminal is primary, the
   *  card surfaces only the primary as a "View output" button and the
   *  rest as a single "Open run" link; otherwise it falls back to the
   *  v1 "N View links for N terminals" convention. */
  isPrimary: boolean;
}

/**
 * Find terminal nodes of the run. Terminal == no outgoing edge in the
 * saved workflow graph. Two failure modes:
 *   - Workflow not in local cache (saved on another device): return [],
 *     caller falls back to the "Open run" link.
 *   - Run hasn't completed a terminal node yet: return [], same fallback.
 *
 * Hooked rather than computed inline because `getSavedWorkflow` reads
 * localStorage and we want to memoize the result.
 *
 * RFC 0065 note: `outputRole` flows through the entire round-trip —
 * `BuilderNode.outputRole` is preserved in the localStorage
 * SavedWorkflow AND forwarded by `builder/schema/serialize.ts` to the
 * BE `BackendNode` shape on workflow registration / run dispatch.
 * This hook reads from `getSavedWorkflow()` (localStorage) for the
 * fast path; a future cross-device path would re-fetch the BE
 * workflow definition and read the same field server-side.
 */
function useTerminalNodes(run: WorkflowRunState): { terminals: Terminal[]; graphUnavailable: boolean } {
  // Memo key is a stable string hash of the inputs that actually
  // matter — using the raw `run.nodeNames` / `run.nodeOutputs` object
  // references would invalidate on every SSE event (the session
  // reducer spreads a fresh object each time), defeating the cache.
  const memoKey = useMemo(
    () => `${run.workflowId}::${run.status}::${run.completedNodeIds.join(',')}`,
    [run.workflowId, run.status, run.completedNodeIds],
  );
  // `memoKey` captures every input the memo body reads; depending on
  // the raw `run` refs would cause spurious invalidations per the
  // comment above. The disable sits on the dep-array line below, where
  // the exhaustive-deps warning is reported.
  return useMemo(() => {
    const saved = getSavedWorkflow(run.workflowId);
    // ADR 0600 §4 — the THIRD state, previously undisclosed. A cache miss and
    // "this run produced no readable outputs" both returned `[]`, and the card
    // rendered the identical bare "Open run". They are different facts and the
    // second one is a claim: this workflow's graph has simply never been opened
    // in the Builder ON THIS DEVICE, which for a feature with no page (driven
    // from chat, a schedule or a trigger) is the COMMON case, not the edge one.
    if (!saved) return { terminals: [], graphUnavailable: true };
    // A node is terminal if no edge has it as `source`.
    const hasOutgoing = new Set<string>();
    for (const e of saved.edges) hasOutgoing.add(e.source);
    const terminals: Terminal[] = [];
    for (const n of saved.nodes) {
      // ── ADR 0600 §4 (`ISU-23`) ────────────────────────────────────────
      // An EXPLICIT `outputRole` outranks graph position. `outputRole:'primary'`
      // means "the canonical deliverable" (RFC 0065) — a claim about what the
      // user should be handed, not about where the node sits in the DAG. This
      // filter used to drop every explicitly-tagged node that had an outgoing
      // edge, which is most of them: a deliverable is usually followed by an
      // approval gate and a notification.
      //
      // MEASURED on `insights-suite`, which is what surfaced it: the three
      // chains tag `emailDraft` (the drafted email) and `score` (the 9-box
      // result) as primary, and each is followed by `approve → notify`. So the
      // author's declared deliverable was filtered out and the surfaced
      // "output" was a bell ring — on two of three chains the annotation made
      // the card STRICTLY worse than no annotation at all, because the host
      // post-processor also cleared the auto-terminal-primary off `notify`.
      //
      // ── ADR 0600 §Correction 4 — `primary` ONLY ───────────────────────────
      // This read `=== 'primary' || === 'secondary'`, which quietly INVENTED
      // the consumer §4 says it considered and rejected: with no primary
      // anywhere, a mid-graph node tagged `secondary` entered `terminals` and
      // surfaced as a "View output" button on every workflow in the app. It
      // also falsified three shipped statements at once — the `metaWorkflows`
      // retirement docblock, §4's retirement REASON ("nothing in the SPA reads
      // it — the only consumer tests `=== 'primary'`") and §9's
      // `GEN-OUTPUTROLE-1` ("rendered NOWHERE in the SPA"). The rule this
      // filter is FOR is "an explicit `primary` outranks graph position";
      // `secondary` was never part of it.
      const declared = n.outputRole === 'primary';
      if (hasOutgoing.has(n.id) && !declared) continue;
      // Only surface terminals the run actually reached — a half-run
      // with one branch failed shouldn't claim un-run terminals.
      // Match the builder node id against the backend nodeId via the
      // run's `nodeNames` map (which carries the BE→builder mapping).
      const backendNodeId = lookupBackendNodeId(n.id, run);
      if (!backendNodeId) continue;
      if (!run.completedNodeIds.includes(backendNodeId)) continue;
      const output = run.nodeOutputs[backendNodeId];
      if (output == null) continue;
      // `n.config?.name` is `unknown` until proven otherwise — narrow
      // via typeof, don't cast. Operator precedence with `??` matters
      // here: `(x as string) ?? y` would coerce `undefined` to `string`
      // and never reach the fallback.
      const namedLabel = typeof n.config?.name === 'string' ? n.config.name : null;
      const label = namedLabel ?? n.kind ?? backendNodeId.slice(0, 8);
      terminals.push({
        nodeId: backendNodeId,
        label,
        output,
        isPrimary: n.outputRole === 'primary',
      });
    }
    // RFC 0065 — if at least one terminal is tagged `primary`, narrow
    // the surfaced list to JUST the primary one. Per the RFC, the
    // tiebreaker for multiple primaries is lexicographic node id —
    // **Unicode code-point order** (NOT `localeCompare`, which uses
    // the host's default ICU collation and can diverge across
    // implementations for non-ASCII ids). The schema pins ids to
    // `[a-zA-Z0-9._-]` so the two coincide today; the explicit
    // ordering makes the RFC's "reproducible across implementations"
    // promise honest if the regex ever loosens.
    const primaries = terminals.filter((t) => t.isPrimary);
    const [primary] = primaries.sort((a, b) =>
      a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
    );
    if (primary) return { terminals: [primary], graphUnavailable: false };
    // Fallback (v1 convention): show every terminal as a separate
    // "View output" link.
    return { terminals, graphUnavailable: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: key on memoKey, not raw `run`
  }, [memoKey]);
}

/**
 * The run snapshot's `nodeNames` is `{backendNodeId → builderNodeId}`
 * in some adapters and `{backendNodeId → friendlyName}` in others.
 * To map builder→backend we walk the entries and reverse-match. When
 * the run was an ephemeral / sample workflow with no builder id at
 * all, `nodeNames` is empty and we fall back to a direct lookup.
 */
function lookupBackendNodeId(builderNodeId: string, run: WorkflowRunState): string | null {
  if (run.completedNodeIds.includes(builderNodeId)) return builderNodeId;
  for (const [backendId, name] of Object.entries(run.nodeNames)) {
    if (name === builderNodeId || backendId === builderNodeId) return backendId;
  }
  return null;
}

function useElapsedSince(startedAt: string): string {
  // Snapshot at mount — terminal runs don't keep ticking, so a single
  // read is sufficient. The render cost is paid even while the run is
  // still mid-flight (the parent calls this unconditionally now to
  // satisfy Rules of Hooks), but `formatElapsed` is a constant-time
  // string format so the overhead is negligible.
  const [text] = useState(() => formatElapsed(startedAt));
  return text;
}

interface ShellProps {
  tone: 'success' | 'danger' | 'muted';
  iconKind: 'check' | 'alert' | 'ban';
  title: string;
  children: React.ReactNode;
}

function CompletionShell({ tone, iconKind, title, children }: ShellProps): JSX.Element {
  const { t: translate } = useTranslation('chat');
  const color = tone === 'success'
    ? 'var(--color-success)'
    : tone === 'danger'
      ? 'var(--color-danger)'
      : 'var(--ink-3)';
  // Danger uses a 2px border for non-color differentiation so users
  // with limited color discrimination still see the failure call-out.
  const borderWidth = tone === 'danger' ? 2 : 1;
  // ARIA landmark label so SR users can navigate the row as a unit.
  const ariaLabel = translate('workflowRunAria', { title });

  // ── ADR 0600 §3 (`ISU-27`) — this was `role="status"` for ALL THREE tones ──
  //
  // Three defects rode on that one attribute, and only one of them is the role:
  //
  //  1. A terminal FAILURE was marked polite. `ui/Notice.tsx` already maps
  //     `variant === 'error'` → `role="alert" aria-live="assertive"`; this
  //     hand-rolled region did not.
  //  2. It is a live region NESTED inside `MessageFeed`'s
  //     `role="log" aria-live="polite" aria-relevant="additions"` — the
  //     competing-voices defect MessageFeed's own skeleton comment refuses.
  //  3. `aria-label` on a live region makes AT read the LABEL instead of the
  //     row's real content, so the error code and message were unreachable.
  //
  // Flipping `status` → `alert` would have fixed exactly one of the three, and
  // would have left the outcome resting on a CONDITIONALLY MOUNTED inline
  // region — the mechanism `ui/Notice.tsx:6-28` and `ui/StateCard.tsx` both say
  // must not be treated as established. So the false live region is REMOVED
  // (`role="group"` keeps the label legal and the row navigable as a unit), and
  // the speech moves to the one region this app trusts.
  //
  // Only FAILURE announces, and that is deliberate rather than partial: the
  // ancestor log announces the card's insertion politely already, which is the
  // right channel for a completed or cancelled run. Announcing those again here
  // is the double-announce that boundary exists to prevent. A failure is the one
  // outcome that must not wait behind a polite queue.
  const failureAnnouncement = tone === 'danger' ? ariaLabel : '';
  useEffect(() => {
    if (failureAnnouncement) announce(failureAnnouncement, { assertive: true });
  }, [failureAnnouncement]);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="wfcomplete-shell"
      style={{
        background: `color-mix(in oklch, ${color} 8%, transparent)`,
        border: `${borderWidth}px solid color-mix(in oklch, ${color} 40%, var(--rule))`,
      }}
    >
      <div className="u-flex u-items-center u-gap-2">
        <span className="wfcomplete-icon" style={{ color }}>
          {iconKind === 'check' && <CheckIcon size={14} />}
          {iconKind === 'alert' && <AlertIcon size={14} />}
          {iconKind === 'ban' && <BanIcon size={14} />}
        </span>
        <strong style={{ color }}>{title}</strong>
      </div>
      {children}
    </div>
  );
}

function Meta({ items }: { items: readonly string[] }): JSX.Element {
  return (
    <div className="muted wfcomplete-meta">
      {items.filter(Boolean).map((t, i) => (
        <span key={i}>{t}</span>
      ))}
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="wfcomplete-actions">
      {children}
    </div>
  );
}
