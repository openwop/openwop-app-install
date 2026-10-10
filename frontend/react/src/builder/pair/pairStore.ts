/**
 * ADR 0773 — the builder's pairing state: which right-rail tab is showing, the
 * chat session this builder is paired with, the active suggestion and the
 * user's keep/drop decisions, the review focus, and consumer-initiated prompts.
 *
 * Kept OUT of `builderStore` on purpose: the workflow document (nodes, edges,
 * undo) stays the one thing that store owns. A keep crosses over through ONE
 * action, `builderStore.applyEditOps`, so it is one undo step saved by the
 * ordinary CAS autosave.
 */

import { create } from 'zustand';
import { enqueueBuilderWrite, flushPendingBackendSync, useBuilderStore } from '../store/builderStore.js';
import { toast } from '../../ui/toast.js';
import i18n from '../../i18n/index.js';
import { runFromNode } from '../debugSession.js';
import { getSuggestion, listRoomSuggestions, patchSuggestion, putPairContext, suggestFromChain as postSuggestFromChain, PairRequestError, type RoomSuggestionView } from './pairClient.js';
import {
  autoKeepable, isValueOp, keepOrder, liveOpStatuses, withEditedValue,
  type EditOp, type LiveOpStatus, type ServerOpState, type WorkflowEditSuggestion,
} from './suggestionModel.js';

/** G-06a — narration is paused while a KEPT suggestion is applied: that edit is
 *  the AI's and already has its receipt; narrating it would double-count. */
let narrationPaused = 0;
export const isNarrationPaused = (): boolean => narrationPaused > 0;
function applyQuietly(ops: readonly EditOp[]): boolean[] {
  narrationPaused += 1;
  try { return useBuilderStore.getState().applyEditOps(ops); } finally { narrationPaused -= 1; }
}

/** P11 — the native drag payload a run-drawer step carries: `{ nodeId, runId }`. */
export const RUN_STEP_CITE_MIME = 'application/openwop-run-step';

export const SUGGEST_EDITS_TOOL = 'openwop:feature.builder-pair.nodes.suggest-edits';
export const READ_CANVAS_TOOL = 'openwop:feature.builder-pair.nodes.read-canvas';

/** Progress of the current turn, from REAL tool events (never a timer). */
export type PairPhase = 'idle' | 'thinking' | 'reading' | 'drafting' | 'review';

export type RailTab = 'pair' | 'inspect';

const AUTO_KEEP_KEY = 'openwop.builderPair.autoKeep';
const readAutoKeep = (): boolean => {
  try { return globalThis.localStorage?.getItem(AUTO_KEEP_KEY) === 'true'; } catch { return false; }
};

export interface KeepResult {
  kept: number[];
  skipped: Array<{ index: number; status: LiveOpStatus }>;
}

export interface PairState {
  tab: RailTab;
  conversationId: string | null;
  suggestion: WorkflowEditSuggestion | null;
  /** The user's decisions, applied optimistically before the PATCH lands. */
  opState: ServerOpState[];
  focusedOp: number | null;
  prompt: { id: number; text: string } | null;
  phase: PairPhase;
  autoKeep: boolean;
  /** A run the user pointed the Architect at (Diagnose). */
  lastRunId: string | null;
  /** Nodes the user dragged onto the composer, beyond the selection. */
  cited: string[];
  roomSuggestions: RoomSuggestionView[];
  lastError: string | null;
  /** G-04a — the failed node a Diagnose was about (for "keep and re-run"). */
  diagnoseNodeId: string | null;
  /** G-06a — "You changed…" lines since the last send (coalesced, newest last). */
  narration: string[];
  /** G-05a — op indexes that arrived in the latest append batch (for the land-in). */
  landing: number[];
  /** G-05e — bumped to ask the embed to stop the in-flight turn. */
  stopSignal: number;
  /** G-02c — the latest ask came from an inline surface (⌘., a node/edge ask). */
  lastAskInline: boolean;
  /** G-04c — a request for the shell to open the debug session of a run. */
  debugRequest: { runId: string; seq: number } | null;
  /** P11 — the review instrument is showing (Esc tucks it away; J/K brings it back). */
  reviewOpen: boolean;
  /** P11 — ⌘. asked for the inline prompt on this node ('*' = the multi-selection). */
  inlineAskFor: string | null;

  setTab(tab: RailTab): void;
  setConversationId(id: string): void;
  ask(text: string, opts?: { runId?: string; nodeId?: string; inline?: boolean }): void;
  restore(indexes: readonly number[]): void;
  forceKeep(index: number): KeepResult;
  keepEdited(index: number, value: unknown): KeepResult;
  keepAndRerun(): Promise<{ ok: boolean; reason?: string }>;
  pushNarration(line: string): void;
  stop(): void;
  requestDebug(runId: string): void;
  suggestFromChain(chainId: string): Promise<{ ok: boolean; reason?: string }>;
  cite(nodeId: string): void;
  uncite(nodeId: string): void;
  setAutoKeep(on: boolean): void;
  onToolActivity(a: { toolName: string; phase: 'called' | 'returned'; failed: boolean }): void;
  onTurnSettled(): void;
  refresh(): Promise<void>;
  refreshRoom(workflowId: string): Promise<void>;
  statuses(): LiveOpStatus[];
  keep(indexes: readonly number[]): KeepResult;
  drop(indexes: readonly number[]): void;
  keepAll(): KeepResult;
  dropAll(): void;
  step(dir: 1 | -1): void;
  focusOp(index: number | null): void;
  /** P11 — Esc: tuck the review away; the pending changes stay drawn. */
  closeReview(): void;
  /** P11 — ⌘.: open the inline prompt at a node (or '*' for the selection). */
  requestInlineAsk(target: string | null): void;
  /** P11 — a run step dropped on the composer: cite its node, attach its run. */
  citeRunStep(nodeId: string, runId: string): void;
  share(on: boolean): Promise<void>;
  /** ADR 0773 D3 — flush autosave, then publish what the builder is showing. */
  beforeSend(conversationId: string, conversationRunId?: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  reset(): void;
}

const graph = () => {
  const b = useBuilderStore.getState();
  return { nodes: b.nodes, edges: b.edges };
};

/** The suggestion ONLY if it is about the workflow open now. A conversation
 *  outlives a workflow switch, so its suggestion can be about another workflow;
 *  every read and write path goes through this (review CR-2). */
const current = (s: WorkflowEditSuggestion | null): WorkflowEditSuggestion | null =>
  s && s.workflowId === useBuilderStore.getState().workflowId ? s : null;

/**
 * P11 — stepping onto a VALUE change (a config field, a rename, an edge
 * condition) on something already on the sheet flips the rail to Inspect with
 * that thing selected, so the field's diff card (which highlights the focused
 * op) is what you look at. A structural change stays in Pair: there is no
 * field to show for a step that does not exist yet.
 */
function revealInInspector(op: EditOp | undefined): void {
  if (!op || !isValueOp(op)) return;
  const b = useBuilderStore.getState();
  if ('nodeId' in op && b.nodes.some((n) => n.id === op.nodeId)) {
    b.selectNode(op.nodeId);
    usePairStore.setState({ tab: 'inspect' });
  }
}

/** The conversation id the template lane uses when no chat conversation exists. */
export const templateConversationId = (workflowId: string): string => `pair-template:${workflowId}`;

let promptSeq = 0;

/** A keep/drop decision the server did not record must not look recorded: say
 *  so (the canvas change itself is already saved by the ordinary autosave). */
function reportPatchFailure(): void {
  toast.error(i18n.t('builder:pairDecisionNotSaved'));
}

export const usePairStore = create<PairState>((set, get) => ({
  // The rail opens on Inspect: it is the builder's PROPERTIES rail (DESIGN.md
  // §7.1.5), and a person who clicks a node to edit it must see its fields.
  // Every AI entry (Ask, ⌘., Diagnose, a cited run step) switches to Pair
  // itself. Opening on Pair hid the Inspector from everyone with pairing on
  // (preset-inputs-clickthrough CT-E1/E2/E4, 2026-09-29).
  tab: 'inspect',
  conversationId: null,
  suggestion: null,
  opState: [],
  focusedOp: null,
  prompt: null,
  phase: 'idle',
  autoKeep: readAutoKeep(),
  lastRunId: null,
  cited: [],
  roomSuggestions: [],
  lastError: null,
  diagnoseNodeId: null,
  narration: [],
  landing: [],
  stopSignal: 0,
  lastAskInline: false,
  debugRequest: null,
  reviewOpen: true,
  inlineAskFor: null,

  setTab(tab) { set({ tab }); },

  setConversationId(id) {
    if (get().conversationId === id) return;
    set({ conversationId: id, suggestion: null, opState: [], focusedOp: null });
  },

  ask(text, opts) {
    promptSeq += 1;
    set({
      tab: 'pair', prompt: { id: promptSeq, text }, lastAskInline: opts?.inline === true,
      ...(opts?.runId ? { lastRunId: opts.runId } : {}),
      ...(opts?.nodeId ? { diagnoseNodeId: opts.nodeId } : {}),
    });
  },

  pushNarration(line) {
    const n = [...get().narration.filter((x) => x !== line), line].slice(-4);
    set({ narration: n });
  },

  stop() { set({ stopSignal: get().stopSignal + 1, phase: 'idle' }); },

  requestDebug(runId) { set({ debugRequest: { runId, seq: (get().debugRequest?.seq ?? 0) + 1 } }); },

  async suggestFromChain(chainId) {
    const workflowId = useBuilderStore.getState().workflowId;
    if (!workflowId) return { ok: false, reason: 'not-ready' };
    // G-10a — a template needs NO model, so it must not wait on the chat. With
    // no provider the chat never mounts and never mints a conversation id; the
    // template lane then addresses its suggestion by its own stable id. The
    // server keys suggestions per user, so this id cannot reach anyone else's.
    let conversationId = get().conversationId;
    if (!conversationId) {
      conversationId = templateConversationId(workflowId);
      set({ conversationId });
    }
    try {
      await postSuggestFromChain({ conversationId, workflowId, chainId });
      await get().refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  restore(indexes) {
    const s = current(get().suggestion);
    const conversationId = get().conversationId;
    if (!s || !conversationId) return;
    const next = [...get().opState];
    const restored = indexes.filter((i) => next[i] === 'dropped');
    for (const i of restored) next[i] = 'pending';
    set({ opState: next });
    if (restored.length > 0) {
      void patchSuggestion(conversationId, { suggestionId: s.id, opState: restored.map((index) => ({ index, state: 'pending' as const })) })
        .catch((err: unknown) => set({ lastError: err instanceof Error ? err.message : String(err) }));
    }
  },

  forceKeep(index) {
    // G-03f — "Use the AI's": only a VALUE op, only when stale.
    const s = current(get().suggestion);
    const conversationId = get().conversationId;
    const op = s?.ops[index]?.op;
    if (!s || !conversationId || !op || !isValueOp(op) || get().statuses()[index] !== 'stale') return { kept: [], skipped: [] };
    const landed = applyQuietly([op]);
    if (!landed[0]) return { kept: [], skipped: [{ index, status: 'inapplicable' }] };
    const next = [...get().opState];
    next[index] = 'kept';
    set({ opState: next });
    void patchSuggestion(conversationId, { suggestionId: s.id, opState: [{ index, state: 'kept' }] }).catch(reportPatchFailure);
    return { kept: [index], skipped: [] };
  },

  keepEdited(index, value) {
    // G-03e — keep the person's EDITED value; still one undo step.
    const s = current(get().suggestion);
    const conversationId = get().conversationId;
    const op = s?.ops[index]?.op;
    const st = get().statuses()[index];
    if (!s || !conversationId || !op || !isValueOp(op) || (st !== 'pending' && st !== 'stale')) return { kept: [], skipped: [] };
    const landed = applyQuietly([withEditedValue(op, value)]);
    if (!landed[0]) return { kept: [], skipped: [{ index, status: 'inapplicable' }] };
    const next = [...get().opState];
    next[index] = 'kept';
    set({ opState: next });
    void patchSuggestion(conversationId, { suggestionId: s.id, opState: [{ index, state: 'kept' }] }).catch(reportPatchFailure);
    return { kept: [index], skipped: [] };
  },

  async keepAndRerun() {
    // G-04a — keep the fix, WAIT for it to be saved, then re-run from the
    // failed node through the existing debug lane. A save that did not land
    // starts no run (the re-run would test the old definition).
    const nodeId = get().diagnoseNodeId;
    if (!nodeId) return { ok: false, reason: 'no-node' };
    get().keepAll();
    flushPendingBackendSync();
    await enqueueBuilderWrite(async () => undefined);
    if (useBuilderStore.getState().syncState === 'failed') return { ok: false, reason: 'sync-failed' };
    try {
      await runFromNode(nodeId, 'from-here');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  cite(nodeId) { if (!get().cited.includes(nodeId)) set({ cited: [...get().cited, nodeId] }); },
  uncite(nodeId) { set({ cited: get().cited.filter((c) => c !== nodeId) }); },

  setAutoKeep(on) {
    try { globalThis.localStorage?.setItem(AUTO_KEEP_KEY, on ? 'true' : 'false'); } catch { /* private mode */ }
    set({ autoKeep: on });
  },

  onToolActivity(a) {
    if (a.toolName === READ_CANVAS_TOOL && a.phase === 'called') set({ phase: 'reading' });
    if (a.toolName === SUGGEST_EDITS_TOOL) {
      if (a.phase === 'called') set({ phase: 'drafting' });
      // The trigger: a returned suggest-edits means the store has a new
      // suggestion (or a typed refusal) — re-read it. Never a payload channel.
      if (a.phase === 'returned') void get().refresh();
    }
  },

  onTurnSettled() {
    set({ phase: get().suggestion && get().opState.some((s) => s === 'pending') ? 'review' : 'idle', cited: [] });
    void get().refresh();
  },

  async refresh() {
    const id = get().conversationId;
    if (!id) return;
    try {
      const s = current(await getSuggestion(id));
      const prior = get().suggestion;
      if (!s) { set({ suggestion: null, opState: [], focusedOp: null, landing: [] }); return; }
      const fresh = !prior || prior.id !== s.id;
      // G-05a — an APPEND batch: same suggestion, more ops. Keep the local
      // decisions and add the new ops as pending; mark them as landing.
      const local = get().opState;
      const opState = fresh ? [...s.opState] : [...local, ...s.opState.slice(local.length)];
      const landing = fresh ? s.ops.map((_, i) => i) : s.ops.map((_, i) => i).filter((i) => i >= local.length);
      set({
        suggestion: s,
        opState,
        landing,
        ...(fresh ? { reviewOpen: true } : {}),
        focusedOp: fresh ? (s.opState.findIndex((x) => x === 'pending') >= 0 ? s.opState.findIndex((x) => x === 'pending') : null) : get().focusedOp,
        phase: opState.some((x) => x === 'pending') ? (get().phase === 'drafting' ? 'drafting' : 'review') : get().phase,
        lastError: null,
      });
      const newIdx = new Set(landing);
      if (get().autoKeep && newIdx.size > 0) {
        const idx = autoKeepable(s, get().statuses(), useBuilderStore.getState().selectedNodeIds).filter((i) => newIdx.has(i));
        if (idx.length > 0) {
          const before = useBuilderStore.getState().past.length;
          const r = get().keep(idx);
          if (r.kept.length > 0) {
            // G-03a — the visible undo the ADR promised. It undoes exactly THIS
            // keep: if anything else was edited since, it refuses rather than
            // undoing the wrong change.
            const keptNow = r.kept;
            toast.withAction('success', i18n.t('builder:pairAutoKept', { count: keptNow.length }), {
              label: i18n.t('builder:pairUndo'),
              run: () => {
                const b = useBuilderStore.getState();
                if (b.past.length !== before + 1) { toast.info(i18n.t('builder:pairUndoStale')); return; }
                b.undo();
                const next = [...get().opState];
                for (const i of keptNow) next[i] = 'pending';
                set({ opState: next });
                const cid = get().conversationId;
                const cur = get().suggestion;
                if (cid && cur) void patchSuggestion(cid, { suggestionId: cur.id, opState: keptNow.map((index) => ({ index, state: 'pending' as const })) }).catch(reportPatchFailure);
              },
            });
          }
        }
      }
      // G-02c — a small inline ask's result also offers Keep right where the
      // person is looking (the rail entry is the same op state).
      if (get().lastAskInline && newIdx.size > 0 && newIdx.size <= 3 && [...newIdx].every((i) => get().opState[i] === 'pending' && isValueOp(s.ops[i]!.op))) {
        set({ lastAskInline: false });
        toast.withAction('info', i18n.t('builder:pairInlineDrawn', { count: newIdx.size }), {
          label: i18n.t('builder:pairKeep'),
          run: () => { get().keep([...newIdx]); },
        });
      }
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshRoom(workflowId) {
    try {
      const all = await listRoomSuggestions(workflowId);
      set({ roomSuggestions: all.filter((s) => !s.mine) });
    } catch { /* the room list is advisory; a failed read shows nothing */ }
  },

  statuses() {
    const s = current(get().suggestion);
    return s ? liveOpStatuses(s, graph(), get().opState) : [];
  },

  keep(indexes) {
    const s = current(get().suggestion);
    const conversationId = get().conversationId;
    if (!s || !conversationId) return { kept: [], skipped: [] };
    const state = get().opState;
    const statuses = liveOpStatuses(s, graph(), state);
    const order = keepOrder(s, indexes, state);
    const eligible = order.filter((i) => statuses[i] === 'pending');
    const skipped = order.filter((i) => statuses[i] !== 'pending' && state[i] === 'pending').map((index) => ({ index, status: statuses[index]! }));
    // Only ops that actually LANDED are marked kept (review CR-7).
    const landed = eligible.length > 0 ? applyQuietly(eligible.map((i) => s.ops[i]!.op)) : [];
    const kept = eligible.filter((_, k) => landed[k]);
    for (const [k, i] of eligible.entries()) if (!landed[k]) skipped.push({ index: i, status: 'inapplicable' });
    if (kept.length > 0) {
      const next = [...state];
      for (const i of kept) next[i] = 'kept';
      set({ opState: next });
      void patchSuggestion(conversationId, { suggestionId: s.id, opState: kept.map((index) => ({ index, state: 'kept' as const })) })
        .catch((err: unknown) => set({ lastError: err instanceof Error ? err.message : String(err) }));
    }
    get().step(1);
    return { kept, skipped };
  },

  drop(indexes) {
    const s = current(get().suggestion);
    const conversationId = get().conversationId;
    if (!s || !conversationId) return;
    const next = [...get().opState];
    const dropped = indexes.filter((i) => next[i] === 'pending');
    for (const i of dropped) next[i] = 'dropped';
    set({ opState: next });
    get().step(1);
    if (dropped.length > 0) {
      void patchSuggestion(conversationId, { suggestionId: s.id, opState: dropped.map((index) => ({ index, state: 'dropped' as const })) })
        .catch((err: unknown) => set({ lastError: err instanceof Error ? err.message : String(err) }));
    }
  },

  keepAll() {
    const s = current(get().suggestion);
    if (!s) return { kept: [], skipped: [] };
    return get().keep(s.ops.map((_, i) => i).filter((i) => get().opState[i] === 'pending'));
  },

  dropAll() {
    const s = current(get().suggestion);
    if (!s) return;
    get().drop(s.ops.map((_, i) => i).filter((i) => get().opState[i] === 'pending'));
    set({ phase: 'idle' });
  },

  step(dir) {
    const s = current(get().suggestion);
    if (!s) return;
    const pending = s.ops.map((_, i) => i).filter((i) => get().opState[i] === 'pending');
    if (pending.length === 0) { set({ focusedOp: null, phase: 'idle' }); return; }
    const cur = get().focusedOp;
    if (cur === null) {
      const first = dir === 1 ? pending[0]! : pending[pending.length - 1]!;
      set({ focusedOp: first, reviewOpen: true });
      revealInInspector(s.ops[first]?.op);
      return;
    }
    const after = dir === 1 ? pending.find((i) => i > cur) ?? pending[0]! : [...pending].reverse().find((i) => i < cur) ?? pending[pending.length - 1]!;
    set({ focusedOp: after, reviewOpen: true });
    revealInInspector(s.ops[after]?.op);
  },

  focusOp(index) { set({ focusedOp: index }); },

  closeReview() { set({ reviewOpen: false, focusedOp: null }); },

  requestInlineAsk(target) { set({ inlineAskFor: target }); },

  citeRunStep(nodeId, runId) {
    get().cite(nodeId);
    set({ lastRunId: runId, tab: 'pair' });
  },

  async share(on) {
    const s = get().suggestion;
    const conversationId = get().conversationId;
    if (!s || !conversationId) return;
    try {
      const updated = await patchSuggestion(conversationId, { suggestionId: s.id, visibility: on ? 'room' : 'private' });
      set({ suggestion: { ...s, visibility: updated.visibility } });
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  async beforeSend(conversationId, conversationRunId) {
    const b = useBuilderStore.getState();
    if (!b.workflowId) return { ok: false, reason: 'no-workflow' };
    // D3 — flush the debounced autosave and wait for the write queue to drain,
    // so the saved head IS what is on screen when the Architect reads it.
    flushPendingBackendSync();
    await enqueueBuilderWrite(async () => undefined);
    // An EMPTY workflow cannot save (the serializer refuses a graph with no
    // nodes) and has nothing to be stale about: the server reads it as an empty
    // draft (review CR-1). Every other failed save blocks the send.
    if (useBuilderStore.getState().nodes.length > 0 && useBuilderStore.getState().syncState === 'failed') {
      return { ok: false, reason: 'sync-failed' };
    }
    const selection = {
      nodeIds: [...new Set([...b.selectedNodeIds, ...(b.selectedNodeId ? [b.selectedNodeId] : []), ...get().cited])],
      edgeIds: b.selectedEdgeId ? [b.selectedEdgeId] : [],
    };
    try {
      await putPairContext({
        conversationId, workflowId: b.workflowId, selection,
        ...(get().lastRunId ? { lastRunId: get().lastRunId as string } : {}),
        ...(conversationRunId ? { conversationRunId } : {}),
      });
    } catch (err) {
      return { ok: false, reason: err instanceof PairRequestError && err.status === 404 ? 'not-found' : 'context-failed' };
    }
    set({ phase: 'thinking', narration: [] });
    return { ok: true };
  },

  reset() {
    set({
      suggestion: null, opState: [], focusedOp: null, prompt: null, phase: 'idle', lastRunId: null, cited: [], roomSuggestions: [], lastError: null,
      diagnoseNodeId: null, narration: [], landing: [], lastAskInline: false, reviewOpen: true, inlineAskFor: null,
    });
  },
}));
