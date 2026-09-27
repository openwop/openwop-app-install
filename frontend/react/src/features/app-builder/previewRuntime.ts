/**
 * The app-builder preview runtime (ADR 0345 3b) — the TYPE-side semantics the
 * chassis `InteractiveViewer` mechanics call into. The chassis owns the
 * ephemeral store, the modal overlay, and the delegated `data-cv-act` click;
 * THIS module owns what the closed action kinds mean. Deterministic, no eval:
 * every kind is a switch arm over the ADR 0343 vocabulary.
 *
 * `invoke-operation` and `submit-form` are 3c (the mock operation runtime) —
 * today they only record a trace line, so nothing silently pretends to work.
 */
import type { PreviewRuntime, PreviewRuntimeCtx, PreviewSimulation } from '../../canvas/InteractiveViewer.js';
import type { AppOperation, AppStateVariable } from './screenOps.js';
import type { CompNode, Screen } from './canvasTree.js';

// The chassis hands us the opaque doc; narrow the two facets we read (the
// coerceApp discipline — no `as unknown as` laundering).
const stateVarsOf = (doc: Record<string, unknown>): AppStateVariable[] =>
  Array.isArray(doc.stateVariables) ? (doc.stateVariables as AppStateVariable[]) : [];
const screensOf = (doc: Record<string, unknown>): Screen[] =>
  Array.isArray(doc.screens) ? (doc.screens as Screen[]) : [];
const operationsOf = (doc: Record<string, unknown>): AppOperation[] =>
  Array.isArray(doc.operations) ? (doc.operations as AppOperation[]) : [];

/** ADR 0345 3c — the operation result an `op.<id>.*` binding path reads.
 *  Stored in the chassis KV under the reserved `op.<id>` key (type-blind). */
export interface OpResult { status: 'ok' | 'error' | 'loading'; rows: Record<string, unknown>[]; message: string }

function mockResult(op: AppOperation | undefined, override?: 'ok' | 'error' | 'empty'): OpResult {
  const mock = op?.mock;
  if (override === 'error') return { status: 'error', rows: [], message: typeof mock?.message === 'string' && mock.message ? mock.message : 'error' };
  if (override === 'empty') return { status: 'ok', rows: [], message: '' };
  const status = override === 'ok' ? 'ok' : (mock?.status === 'error' ? 'error' : 'ok');
  return {
    status,
    rows: status === 'ok' && Array.isArray(mock?.rows) ? (mock.rows as Record<string, unknown>[]) : [],
    message: status === 'error' && typeof mock?.message === 'string' ? mock.message : '',
  };
}

interface ClosedAction {
  on?: unknown; kind?: unknown; to?: unknown; state?: unknown; value?: unknown;
  operation?: unknown; modal?: unknown;
  onSuccess?: { navigate?: unknown; setState?: { state?: unknown; value?: unknown } };
  onError?: { navigate?: unknown; setState?: { state?: unknown; value?: unknown } };
}

/** Typed zero-values so an unset variable still renders predictably. */
function initialValue(v: AppStateVariable): unknown {
  if (v.initial !== undefined) return v.initial;
  switch (v.type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'list': return [];
    default: return '';
  }
}

function nodeAt(screens: Screen[], frameId: string, actPath: string): CompNode | null {
  const screen = screens.find((s) => s.id === frameId);
  let level: CompNode[] | undefined = screen?.components;
  let node: CompNode | null = null;
  for (const seg of actPath.split('.')) {
    const i = Number(seg);
    if (!Number.isInteger(i) || !level) return null;
    node = level[i] ?? null;
    if (!node) return null;
    level = node.children;
  }
  return node;
}

function runFollowup(fu: ClosedAction['onSuccess'], ctx: PreviewRuntimeCtx): void {
  if (!fu || typeof fu !== 'object') return;
  if (typeof fu.navigate === 'string' && fu.navigate) ctx.navigate(fu.navigate);
  const ss = fu.setState;
  if (ss && typeof ss.state === 'string' && ss.state) ctx.setVar(ss.state, ss.value);
}

function run(a: ClosedAction, doc: Record<string, unknown>, ctx: PreviewRuntimeCtx): void {
  switch (a.kind) {
    case 'navigate':
      if (typeof a.to === 'string' && a.to) ctx.navigate(a.to);
      return;
    case 'set-state':
      if (typeof a.state === 'string' && a.state) { ctx.setVar(a.state, a.value); ctx.trace(`set ${a.state}`); }
      return;
    case 'open-modal':
      if (typeof a.modal === 'string' && a.modal) ctx.openModal(a.modal);
      return;
    case 'close-modal':
      ctx.closeModal();
      return;
    case 'invoke-operation':
    case 'submit-form': {
      // ADR 0345 3c — the mock operation runtime: resolve the operation's
      // declared mock (never a network call), publish the result under the
      // reserved `op.<id>` key for binding paths, and run the matching
      // followup. `submit-form` without an operation stays a loud trace.
      const opId = typeof a.operation === 'string' ? a.operation : '';
      if (!opId) { ctx.trace(`${String(a.kind)}: no operation bound`); return; }
      const op = operationsOf(doc).find((o) => o.id === opId);
      if (!op) { ctx.trace(`${opId}: not found in this design`); return; }
      const result = mockResult(op);
      ctx.setVar(`op.${opId}`, result);
      ctx.trace(`${opId} → ${result.status}${result.status === 'ok' ? ` (${result.rows.length} rows)` : `: ${result.message}`}`);
      runFollowup(result.status === 'ok' ? a.onSuccess : a.onError, ctx);
      return;
    }
    default:
      return; // unknown kinds are validator-rejected upstream; never throw here
  }
}

/** The runtime the app-builder plugs into the viewer (definition + chat + share). */
export const appBuilderPreviewRuntime: PreviewRuntime = {
  initialVars: (doc) => {
    const vars: Record<string, unknown> = {};
    for (const v of stateVarsOf(doc)) {
      if (typeof v?.id === 'string' && v.id) vars[v.id] = initialValue(v);
    }
    return vars;
  },
  onAct: (doc, frameId, actPath, event, ctx) => {
    const node = nodeAt(screensOf(doc), frameId, actPath);
    const actions = Array.isArray(node?.actions) ? (node.actions as ClosedAction[]) : [];
    for (const a of actions) {
      if ((a.on ?? 'click') !== event) continue;
      run(a, doc, ctx);
    }
  },
  // ADR 0345 3c (PR-05) — the diagnostics drawer's designed-state switches:
  // force any operation's result to ok / error / empty without touching the doc.
  simulations: (doc): PreviewSimulation[] =>
    operationsOf(doc).flatMap((op) => (['ok', 'error', 'empty'] as const).map((mode) => ({
      id: `${op.id}:${mode}`,
      label: op.name || op.id,
      mode,
      apply: (ctx) => {
        const result = mockResult(op, mode);
        ctx.setVar(`op.${op.id}`, result);
        ctx.trace(`simulate ${op.id} → ${mode}`);
      },
    }))),
};
