/**
 * Pure helpers + types for the builder shell: host-limit fetching,
 * pre-flight capability/limit collection, and advertised-limit
 * formatting. Extracted from BuilderShell.tsx (pure extraction — no
 * behavior change).
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { getCapabilities } from '../client/runsClient.js';
import { catalogEntry } from './palette/catalogRegistry.js';
import i18n from '../i18n/index.js';
import { formatNumber } from '../i18n/format.js';

/**
 * UX-BLD-1 — "the thing isn't there" vs "the read failed".
 *
 * The builder's debug-pin reads are fail-soft for a genuine reason: an unsaved,
 * local-only draft has no server-side workflow to ask, and that 404 is not worth
 * a word. Every OTHER rejection (5xx, offline, auth) is worth a word, because
 * swallowing it leaves the debug session empty and the author is told they have
 * no pins while the server still holds them — the exact dishonesty ADR 0475's
 * banner exists to prevent.
 *
 * Both the `?debugRun` prefill path and the plain-open path make this same
 * split, so it lives here as ONE rule rather than two copies of a regex that
 * could drift apart.
 */
export function isMissingResourceError(err: unknown): boolean {
  return /_404$/.test(err instanceof Error ? err.message : '');
}

/**
 * ADR 0596 §Correction 5 — the ONE Escape rule for a builder drawer.
 *
 * A drawer's `onKeyDown` sits on the drawer element, so it is a React-tree
 * ANCESTOR of everything the drawer renders. Escape is not the drawer's key: a
 * descendant may own it first. The AI drawer contains the embedded chat, and two
 * of its handlers call `preventDefault()` WITHOUT `stopPropagation()` —
 * `ChatInput` (Escape during a streaming turn = cancel the turn) and
 * `MessageBubble` (Escape exits message-edit). Without the `defaultPrevented`
 * check, cancelling a turn ALSO slammed the drawer shut and yanked focus back to
 * the toolbar trigger.
 *
 * `defaultPrevented` — not "did a child handle it" — is the signal, because it is
 * the one React propagates on the same synthetic event, and it is already the
 * house idiom (`chat/ChatInput.tsx`'s own `if (e.defaultPrevented) return;`
 * backstop). `stopPropagation` stays: Escape that closed THIS drawer must not
 * also reach anything above it.
 *
 * It is a shared helper rather than three hand-written copies because the copies
 * are what drifted: `HistoryDrawer` and `EvalsDrawer` shipped the rule first, the
 * AI drawer copied it, and the copy was wrong for the one drawer with nested
 * Escape consumers.
 */
export function drawerEscapeHandler(close: () => void) {
  return (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.stopPropagation();
    close();
  };
}

/** Host-advertised engine limits from `capabilities.limits` (RFC 0009 +
 *  RFC 0058). Optional fields are absent when the host doesn't advertise. */
export interface HostLimits {
  envelopesPerTurn?: number;
  clarificationRounds?: number;
  schemaRounds?: number;
  maxNodeExecutions?: number;
  maxRunDurationMs?: number;
  maxLoopIterations?: number;
}

/** Fetch `capabilities.limits` once on mount. `null` while in flight or
 *  if the host omits the block entirely. */
export function useHostLimits(): HostLimits | null {
  const [limits, setLimits] = useState<HostLimits | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCapabilities()
      .then((c) => {
        if (cancelled) return;
        // capabilities.limits is REQUIRED in v1, but the optional fields
        // (maxNodeExecutions, maxRunDurationMs, maxLoopIterations) MAY be
        // omitted. We carry the whole block through unchanged.
        const block = (c as { capabilities?: { limits?: HostLimits } }).capabilities?.limits;
        if (block && typeof block === 'object') setLimits(block);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, []);
  return limits;
}

export interface PreflightIssue {
  nodeId: string;
  name: string;
  missing: readonly string[];
}

/** Hard ceilings the workflow shape will breach when the host advertises
 *  them. Stays empty when the host omits the optional limit. RFC 0009 +
 *  RFC 0058: any breach surfaces at run time as `cap.breached` + an
 *  error code (`HOST_CAPABILITY_MISSING` / `run_timeout` / `loop_limit_exceeded`),
 *  so we lift the same check to author time. */
export interface LimitIssue {
  kind: 'maxNodeExecutions';
  advertised: number;
  actual: number;
  message: string;
}

/** Pre-flight: which graph nodes need a host surface the connected host
 *  doesn't advertise? The catalog already cross-references advertised
 *  host surfaces (CapabilitiesPanel / NodePalette), so we read the
 *  per-node `missingHostSurfaces` and flag them before run — catching
 *  HOST_CAPABILITY_MISSING failures at author time (RFC 0009/0011). */
export function collectPreflightIssues(nodes: ReadonlyArray<{ id: string; kind: string; name: string }>): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const n of nodes) {
    const entry = catalogEntry(n.kind);
    const missing = entry?.missingHostSurfaces ?? [];
    if (missing.length > 0) issues.push({ nodeId: n.id, name: n.name, missing });
  }
  return issues;
}

/** Pre-flight: does the workflow's static shape exceed an advertised
 *  engine limit? Today we check `maxNodeExecutions` — a workflow whose
 *  node count already exceeds the per-run ceiling cannot complete even
 *  a single linear pass. Loop / fork dynamics aren't statically
 *  knowable, so this is intentionally conservative — false negatives
 *  on those are acceptable; false positives would be worse. */
export function collectLimitIssues(
  nodes: ReadonlyArray<{ id: string; kind: string }>,
  limits: HostLimits | null,
): LimitIssue[] {
  if (!limits) return [];
  const issues: LimitIssue[] = [];
  // Client-only annotations (sticky notes, etc.) are stripped from the
  // backend definition by `serializeWithIdMap`, so they don't count
  // against the per-run node-execution ceiling.
  const executableCount = nodes.filter((n) => !catalogEntry(n.kind)?.clientOnly).length;
  const cap = limits.maxNodeExecutions;
  if (typeof cap === 'number' && executableCount > cap) {
    issues.push({
      kind: 'maxNodeExecutions',
      advertised: cap,
      actual: executableCount,
      message: i18n.t('builder:limitMaxNodeExecutionsMessage', {
        actual: formatNumber(executableCount),
        cap: formatNumber(cap),
      }),
    });
  }
  return issues;
}

/** Render the optional advertised limits (RFC 0009 + RFC 0058) as a
 *  short, human-readable line so the user knows the ceilings their run
 *  will execute under. Omits any field the host doesn't advertise. */
export function formatAdvertisedLimits(limits: HostLimits | null): string {
  if (!limits) return '';
  const parts: string[] = [];
  if (typeof limits.maxNodeExecutions === 'number') {
    parts.push(i18n.t('builder:limitNodeExecutions', { n: formatNumber(limits.maxNodeExecutions) }));
  }
  if (typeof limits.maxRunDurationMs === 'number') {
    const sec = Math.round(limits.maxRunDurationMs / 1000);
    parts.push(i18n.t('builder:limitWallClock', { seconds: formatNumber(sec) }));
  }
  if (typeof limits.maxLoopIterations === 'number') {
    parts.push(i18n.t('builder:limitLoopIterations', { n: formatNumber(limits.maxLoopIterations) }));
  }
  if (parts.length === 0) return '';
  return i18n.t('builder:hostLimitsInEffect', { parts: parts.join(', ') });
}

/** One named-but-unbound connection binding (day-1 UX P9 — the pre-run
 *  connect prompt). `ref` is the node's raw `config.connectionRef`
 *  (a connection-pack name, provider id = final dot segment — the same
 *  convention as the template pre-flight's chainRequirements). */
export interface ConnectionRefIssue {
  ref: string;
  providerId: string;
}

/** Collect the distinct connectionRefs the graph names — pure over the
 *  builder nodes so the Run pre-flight can join them against the caller's
 *  live connections. */
export function collectConnectionRefs(
  nodes: ReadonlyArray<{ config?: Record<string, unknown> }>,
): ConnectionRefIssue[] {
  const seen = new Set<string>();
  const out: ConnectionRefIssue[] = [];
  for (const n of nodes) {
    const ref = n.config?.['connectionRef'];
    if (typeof ref !== 'string' || ref.length === 0 || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, providerId: ref.split('.').pop() ?? ref });
  }
  return out;
}

/**
 * UX_UPGRADE-workflows-builder P3 — directional node navigation (the n8n
 * arrow-nav parity, on Alt+Arrow so xyflow's bare-arrow nudge keeps working).
 *
 * Left/Right walk the EDGE GRAPH (upstream/downstream neighbors — ties broken
 * by vertical distance to the current node, so a fan-out picks the visually
 * nearest branch). Up/Down are SPATIAL (nearest node whose center is strictly
 * above/below — graph edges say nothing about vertical siblings). With no
 * current node, any direction lands on the top-left-most node so the keyboard
 * can enter the graph from nothing.
 */
export interface DirectionalNode { id: string; position: { x: number; y: number } }
export interface DirectionalEdge { source: string; target: string }

export function directionalTarget(
  nodes: readonly DirectionalNode[],
  edges: readonly DirectionalEdge[],
  currentId: string | null,
  dir: 'left' | 'right' | 'up' | 'down',
): string | null {
  if (nodes.length === 0) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cur = currentId ? byId.get(currentId) : undefined;
  if (!cur) {
    // Enter the graph at the top-left-most node.
    return [...nodes].sort((a, b) => (a.position.x - b.position.x) || (a.position.y - b.position.y))[0]!.id;
  }
  const nearestBy = (ids: string[]): string | null => {
    const cands = ids.map((id) => byId.get(id)).filter((n): n is DirectionalNode => !!n && n.id !== cur.id);
    if (cands.length === 0) return null;
    return cands.sort((a, b) =>
      (Math.abs(a.position.y - cur.position.y) - Math.abs(b.position.y - cur.position.y)) ||
      (Math.abs(a.position.x - cur.position.x) - Math.abs(b.position.x - cur.position.x)))[0]!.id;
  };
  if (dir === 'left') return nearestBy(edges.filter((e) => e.target === cur.id).map((e) => e.source));
  if (dir === 'right') return nearestBy(edges.filter((e) => e.source === cur.id).map((e) => e.target));
  const below = dir === 'down';
  const cands = nodes.filter((n) => n.id !== cur.id && (below ? n.position.y > cur.position.y : n.position.y < cur.position.y));
  if (cands.length === 0) return null;
  return cands.sort((a, b) =>
    (Math.abs(a.position.y - cur.position.y) + Math.abs(a.position.x - cur.position.x)) -
    (Math.abs(b.position.y - cur.position.y) + Math.abs(b.position.x - cur.position.x)))[0]!.id;
}

/** BLDKB-1 (round 2) — Alt+Shift+Arrow extends the selection by the
 *  directional target. Pure: appends when absent, never duplicates, and an
 *  empty current selection starts from the target alone. Shrink-on-reverse is
 *  deliberately NOT implemented (v1 is add-only; clearing = Esc/click). */
export function nextRangeSelection(current: readonly string[], target: string): string[] {
  if (current.includes(target)) return [...current];
  return [...current, target];
}

/** R3 flood-select (the round-2 tracker's named candidate; n8n's directional
 *  FLOOD semantics beside our step-wise extension): every node reachable from
 *  the anchor set along graph edges in one direction — `downstream` follows
 *  source→target, `upstream` the reverse. Pure BFS; returns current ∪ reached,
 *  current-first, no duplicates. An empty anchor set floods nothing. */
export function floodSelection(
  current: readonly string[],
  edges: readonly DirectionalEdge[],
  anchorIds: readonly string[],
  dir: 'downstream' | 'upstream',
): string[] {
  const out = [...current];
  const seen = new Set(out);
  const queue = [...anchorIds];
  const visited = new Set(anchorIds);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const nexts = dir === 'downstream'
      ? edges.filter((e) => e.source === id).map((e) => e.target)
      : edges.filter((e) => e.target === id).map((e) => e.source);
    for (const n of nexts) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);

      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

/**
 * The scope gate for the canvas verb combos (⌘A select-all, Alt+Arrow nav,
 * Alt+Shift+Arrow range). The registry's keydown owner is WINDOW-level, so an
 * ungated entry would fire — and `preventDefault()` — no matter where focus
 * sits. ⌘A would hijack text select-all, and Alt+←/→ would eat browser
 * back/forward (its binding on Windows/Linux).
 *
 * This is the SECOND of two layers, and it is the one that carries the
 * non-text cases. `useSurfaceChrome`'s `inTextContext` already returns before
 * dispatch for INPUT/TEXTAREA/SELECT/contentEditable, which is what protects
 * the node-title input (`BaseNode`) — that input lives INSIDE `.react-flow`,
 * so this gate says `true` for it and would not have saved it. What only this
 * gate covers is focus on a rail BUTTON, tree item, or tab: not a text
 * context, so `inTextContext` passes it through.
 *
 * Gating via `enabled` rather than inside `run` is load-bearing:
 * `dispatchShortcut` consults `enabled()` BEFORE `preventDefault()`, so a
 * gated-off entry leaves the browser default intact instead of swallowing it.
 */
export function canvasOrNowhereFocused(): boolean {
  const a = document.activeElement;
  return a == null || a === document.body || a.closest('.react-flow') != null;
}

/**
 * ADR 0596 (`WFAU-3`) — LATCH a value that its own consumer is about to destroy.
 *
 * The ADR 0137 hand-off ("Make a workflow" in the Work Graph, "Design journey"
 * in Campaign Studio) synthesizes an authoring prompt from `location.state`,
 * then immediately clears that router state so a refresh cannot re-fire the
 * seeded turn. But the prompt is DERIVED from the very state being cleared, so
 * clearing it evaporates the prompt — and under React 18 automatic batching the
 * clear commits together with the "open the drawer" state update, meaning the
 * first render in which the AI panel mounts already had `undefined`. Both
 * producers therefore handed off into an EMPTY drawer, silently dropping the
 * user's context: the exact no-op `CreateWithAiPanel`'s own comment claimed to
 * have fixed.
 *
 * The latch keeps the last DEFINED value it ever saw, so the source may be
 * cleared freely. It latches during render rather than in an effect, which
 * removes the batching question entirely instead of arranging to win it — the
 * ordering that caused the bug can no longer participate. The ref write is the
 * standard latch idiom: idempotent, no external effect, no tearing.
 *
 * @returns the most recent non-`undefined` value, or `undefined` if there has
 *          never been one.
 */
export function useLatchedValue<T>(value: T | undefined): T | undefined {
  const latched = useRef<T | undefined>(undefined);
  if (value !== undefined) latched.current = value;
  return latched.current;
}
