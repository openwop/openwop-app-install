/** ADR 0345 3b/3c — the app-builder preview-runtime semantics (deterministic,
 *  closed kinds, mock operations). The runtime interprets model-authored action
 *  JSON; its ONLY effects are calls on the injected ctx (no eval, no network, no
 *  storage), so every case asserts the exact ctx call sequence — an extra effect,
 *  or an unknown kind that did something, turns it red. */
import { describe, it, expect } from 'vitest';
import { appBuilderPreviewRuntime } from '../previewRuntime.js';
import type { PreviewRuntimeCtx } from '../../../canvas/InteractiveViewer.js';

const doc: Record<string, unknown> = {
  name: 'A',
  stateVariables: [
    { id: 'filter', type: 'string', initial: 'all' },
    { id: 'count', type: 'number' },
    { id: 'on', type: 'boolean' },
    { id: 'items', type: 'list' },
  ],
  screens: [{
    id: 'home', name: 'Home', isInitial: true,
    components: [
      { type: 'stack', children: [
        { type: 'button', props: { label: 'Go' }, actions: [
          { on: 'click', kind: 'set-state', state: 'filter', value: 'done' },
          { on: 'click', kind: 'navigate', to: 'next' },
          { on: 'change', kind: 'set-state', state: 'filter', value: 'NEVER' },
          // Not in the closed vocabulary — must be inert, never "interpreted".
          { on: 'click', kind: 'eval', code: 'fetch("/steal")' },
        ] },
      ] },
      { type: 'button', props: { label: 'Op' }, actions: [{ on: 'click', kind: 'invoke-operation', operation: 'listTasks' }] },
      { type: 'button', props: { label: 'Modal' }, actions: [{ on: 'click', kind: 'open-modal', modal: 'next' }] },
    ],
  }, { id: 'next', name: 'Next', components: [] }],
};

const ctx = (): PreviewRuntimeCtx & { calls: string[]; sets: Array<[string, unknown]> } => {
  const calls: string[] = [];
  const sets: Array<[string, unknown]> = [];
  return {
    calls,
    sets,
    navigate: (to) => calls.push(`nav:${to}`),
    getVar: () => undefined,
    setVar: (n, v) => { sets.push([n, v]); calls.push(`set:${n}`); },
    openModal: (id) => calls.push(`open:${id}`),
    closeModal: () => calls.push('close'),
    trace: (l) => calls.push(`trace:${l}`),
  };
};

describe('appBuilderPreviewRuntime', () => {
  it('initialVars: initial values win; typed zero-values otherwise', () => {
    expect(appBuilderPreviewRuntime.initialVars(doc)).toEqual({ filter: 'all', count: 0, on: false, items: [] });
  });
  it('runs only the matching event\'s actions, in order', () => {
    const c = ctx();
    appBuilderPreviewRuntime.onAct(doc, 'home', '0.0', 'click', c);
    expect(c.calls).toEqual(['set:filter', 'trace:set filter', 'nav:next']);
    expect(c.sets).toEqual([['filter', 'done']]);
  });
  it('invoke-operation against a doc with NO operations facet traces not-found', () => {
    const c = ctx();
    appBuilderPreviewRuntime.onAct(doc, 'home', '1', 'click', c);
    expect(c.calls).toEqual(['trace:listTasks: not found in this design']);
  });
  it('open-modal routes through the ctx; unknown paths are inert', () => {
    const c = ctx();
    appBuilderPreviewRuntime.onAct(doc, 'home', '2', 'click', c);
    expect(c.calls).toEqual(['open:next']);
    appBuilderPreviewRuntime.onAct(doc, 'home', '9.9', 'click', c);
    appBuilderPreviewRuntime.onAct(doc, 'ghost', '0', 'click', c);
    expect(c.calls).toEqual(['open:next']);
  });
});

describe('mock operation runtime (ADR 0345 3c)', () => {
  const opDoc: Record<string, unknown> = {
    name: 'Ops',
    operations: [
      { id: 'listTasks', name: 'List tasks', kind: 'list', mock: { status: 'ok', rows: [{ title: 'Alpha' }, { title: 'Beta' }] } },
      { id: 'failOp', name: 'Fail', kind: 'action', mock: { status: 'error', message: 'nope' } },
    ],
    screens: [{ id: 'home', name: 'Home', isInitial: true, components: [
      { type: 'button', props: { label: 'Load' }, actions: [{ on: 'click', kind: 'invoke-operation', operation: 'listTasks', onSuccess: { navigate: 'done', setState: { state: 'loaded', value: true } } }] },
      { type: 'button', props: { label: 'Break' }, actions: [{ on: 'click', kind: 'invoke-operation', operation: 'failOp', onError: { navigate: 'oops' } }] },
      { type: 'button', props: { label: 'Ghost' }, actions: [{ on: 'click', kind: 'invoke-operation', operation: 'ghost' }] },
    ] }, { id: 'done', name: 'Done', components: [] }, { id: 'oops', name: 'Oops', components: [] }],
  };
  it('ok mock: rows published, onSuccess navigate + setState run', () => {
    const c = ctx();
    appBuilderPreviewRuntime.onAct(opDoc, 'home', '0', 'click', c);
    expect(c.calls).toEqual(['set:op.listTasks', 'trace:listTasks → ok (2 rows)', 'nav:done', 'set:loaded']);
    expect(c.sets).toEqual([
      ['op.listTasks', { status: 'ok', rows: [{ title: 'Alpha' }, { title: 'Beta' }], message: '' }],
      ['loaded', true],
    ]);
  });
  it('error mock: onError runs, message traced', () => {
    const c = ctx();
    appBuilderPreviewRuntime.onAct(opDoc, 'home', '1', 'click', c);
    expect(c.calls).toEqual(['set:op.failOp', 'trace:failOp → error: nope', 'nav:oops']);
    expect(c.sets).toEqual([['op.failOp', { status: 'error', rows: [], message: 'nope' }]]);
  });
  it('unknown operation: loud trace, nothing else', () => {
    const c = ctx();
    appBuilderPreviewRuntime.onAct(opDoc, 'home', '2', 'click', c);
    expect(c.calls).toEqual(['trace:ghost: not found in this design']);
  });
  it('simulations: 3 designed-state switches per operation, applying through the ctx', () => {
    const sims = appBuilderPreviewRuntime.simulations!(opDoc);
    expect(sims.map((x) => x.id)).toEqual(['listTasks:ok', 'listTasks:error', 'listTasks:empty', 'failOp:ok', 'failOp:error', 'failOp:empty']);
    const c = ctx();
    // `empty` overrides a mock that HAS rows — it must publish none.
    sims.find((x) => x.id === 'listTasks:empty')!.apply(c);
    expect(c.calls).toEqual(['set:op.listTasks', 'trace:simulate listTasks → empty']);
    expect(c.sets).toEqual([['op.listTasks', { status: 'ok', rows: [], message: '' }]]);
  });
});
