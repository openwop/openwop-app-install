/**
 * Type-owned action and binding authoring for App Builder (ADR 0737 phase 3).
 * The canvas chassis owns the workspace switcher and one-step document commits;
 * this panel owns only the app's closed action/binding vocabulary. It deliberately
 * has no runtime, network, or second document store.
 */
import { useEffect, useMemo, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import type { WorkspaceTabProps } from '../../canvas/types.js';
import type { CompNode, Screen } from './canvasTree.js';
import type { AppDoc, AppOperation, AppStateVariable } from './screenOps.js';

type EventName = 'click' | 'submit' | 'load' | 'change';
type ActionKind = 'navigate' | 'set-state' | 'submit-form' | 'invoke-operation' | 'open-modal' | 'close-modal';
type ClosedAction = {
  on?: EventName; kind?: ActionKind; to?: string; state?: string; value?: unknown;
  operation?: string; modal?: string;
};
type Binding = { path?: string; fallback?: string; format?: string; mode?: string };

const EVENTS: readonly EventName[] = ['click', 'submit', 'load', 'change'];
const KINDS: readonly ActionKind[] = ['navigate', 'set-state', 'submit-form', 'invoke-operation', 'open-modal', 'close-modal'];
const FORMATS = ['text', 'number', 'currency', 'date'] as const;
const MODES = ['one-way', 'two-way'] as const;
const WORD = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

interface NodeRef { key: string; screenId: string; screenName: string; path: number[]; node: CompNode }

const array = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
function allNodes(doc: Record<string, unknown>): NodeRef[] {
  const found: NodeRef[] = [];
  for (const screen of array<Screen>(doc.screens)) {
    const visit = (node: CompNode, path: number[]): void => {
      found.push({ key: `${screen.id}:${path.join('.')}`, screenId: screen.id, screenName: screen.name || screen.id, path, node });
      array<CompNode>(node.children).forEach((child, index) => visit(child, [...path, index]));
    };
    array<CompNode>(screen.components).forEach((node, index) => visit(node, [index]));
  }
  return found;
}

function nodeAt(doc: AppDoc, ref: NodeRef): CompNode | null {
  const screen = doc.screens.find((candidate) => candidate.id === ref.screenId);
  let level = screen?.components;
  let current: CompNode | undefined;
  for (const index of ref.path) {
    current = level?.[index];
    if (!current) return null;
    level = current.children;
  }
  return current ?? null;
}

/** Commit only on blur. This preserves the canvas's one-history-step text
 * contract while still allowing authoring of free-form values and paths. */
function CommitText({ value, onCommit, ...props }: {
  value: string;
  onCommit: (next: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'>): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input {...props} className={`cv-editor__input ${props.className ?? ''}`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }} />;
}

function defaultAction(kind: ActionKind, event: EventName, screens: readonly Screen[], vars: readonly AppStateVariable[], operations: readonly AppOperation[]): ClosedAction {
  switch (kind) {
    case 'navigate': return { on: event, kind, to: screens[0]?.id ?? '' };
    case 'set-state': return { on: event, kind, state: vars[0]?.id ?? '', value: '' };
    case 'invoke-operation': return { on: event, kind, operation: operations[0]?.id ?? '' };
    case 'open-modal': return { on: event, kind, modal: 'dialog' };
    case 'submit-form': return { on: event, kind };
    case 'close-modal': return { on: event, kind };
  }
}

function literal(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

export function LogicWorkspace({ doc, commitDoc, onAnnounce }: WorkspaceTabProps): JSX.Element {
  const { t } = useTranslation('app-builder');
  const nodes = useMemo(() => allNodes(doc), [doc]);
  const screens = array<Screen>(doc.screens);
  const vars = array<AppStateVariable>(doc.stateVariables);
  const operations = array<AppOperation>(doc.operations);
  const [selectedKey, setSelectedKey] = useState('');
  const selected = nodes.find((node) => node.key === selectedKey) ?? nodes[0] ?? null;

  useEffect(() => {
    if (!selectedKey || !nodes.some((node) => node.key === selectedKey)) setSelectedKey(nodes[0]?.key ?? '');
  }, [nodes, selectedKey]);

  const mutateNode = (mutator: (node: CompNode) => void): void => {
    if (!selected) return;
    commitDoc((next) => {
      // The chassis gives workspaces a schema-neutral record. Construct the
      // narrow app view over the same screen array so mutations still land in
      // its history-integrated draft without an unsafe document cast.
      const app: AppDoc = {
        name: typeof next.name === 'string' ? next.name : '',
        screens: array<Screen>(next.screens),
      };
      const target = nodeAt(app, selected);
      if (target) mutator(target);
    });
  };
  const actions = array<ClosedAction>(selected?.node.actions);
  const bindings = selected?.node.bindings ?? {};
  const propertyNames = [...new Set([...Object.keys(selected?.node.props ?? {}), ...Object.keys(bindings), 'value'])].filter((name) => WORD.test(name));
  const supportsTwoWay = (prop: string): boolean =>
    prop === 'value' || (selected?.node.type === 'checkbox' && prop === 'checked') || (selected?.node.type === 'toggle' && prop === 'on');
  const actionFor = (index: number, patch: Partial<ClosedAction>): void => mutateNode((node) => {
    const next = array<ClosedAction>(node.actions).map((action, i) => i === index ? { ...action, ...patch } : action);
    node.actions = next as Record<string, unknown>[];
  });
  const unsetActionField = (index: number, field: 'operation'): void => mutateNode((node) => {
    const next = array<ClosedAction>(node.actions).map((action, i) => {
      if (i !== index) return action;
      const updated = { ...action };
      delete updated[field];
      return updated;
    });
    node.actions = next as Record<string, unknown>[];
  });
  const replaceAction = (index: number, kind: ActionKind): void => {
    const old = actions[index];
    mutateNode((node) => {
      const next = array<ClosedAction>(node.actions).map((action, i) => i === index ? defaultAction(kind, old?.on ?? 'click', screens, vars, operations) : action);
      node.actions = next as Record<string, unknown>[];
    });
  };
  const removeAction = (index: number): void => mutateNode((node) => {
    const next = array<ClosedAction>(node.actions).filter((_, i) => i !== index);
    if (next.length) node.actions = next as Record<string, unknown>[];
    else delete node.actions;
  });
  const addAction = (): void => {
    mutateNode((node) => {
      // Never create a hard-invalid navigate action in an otherwise empty
      // document. A modal action has a self-contained, editable target until
      // the author adds the first screen.
      const kind: ActionKind = node.type === 'form' ? 'submit-form' : screens.length ? 'navigate' : 'open-modal';
      node.actions = [...array<ClosedAction>(node.actions), defaultAction(kind, node.type === 'form' ? 'submit' : 'click', screens, vars, operations)] as Record<string, unknown>[];
    });
    onAnnounce(t('logicActionAdded'));
  };
  const changeBinding = (prop: string, patch: Partial<Binding>): void => mutateNode((node) => {
    const next = { ...(node.bindings ?? {}), [prop]: { ...(node.bindings?.[prop] ?? {}), ...patch } };
    node.bindings = next;
  });
  const unsetBindingField = (prop: string, field: 'fallback' | 'format'): void => mutateNode((node) => {
    const next = { ...(node.bindings ?? {}) };
    const current = next[prop];
    if (!current) return;
    const updated = { ...current };
    delete updated[field];
    next[prop] = updated;
    node.bindings = next;
  });
  const removeBinding = (prop: string): void => mutateNode((node) => {
    const next = { ...(node.bindings ?? {}) }; delete next[prop];
    if (Object.keys(next).length) node.bindings = next;
    else delete node.bindings;
  });
  const addBinding = (): void => {
    // `value` is the renderer's native control bridge. Prefer it whenever it
    // is free, even if a display prop (for example `label`) appears first.
    const prop = !bindings.value ? 'value' : propertyNames.find((name) => !bindings[name]) ?? 'value';
    changeBinding(prop, { path: `state.${vars[0]?.id ?? 'state'}`, mode: 'one-way' });
    onAnnounce(t('logicBindingAdded'));
  };

  return (
    <div className="ab-logic">
      <section className="surface-card ab-logic__section" aria-label={t('logicTitle')}>
        <h3>{t('logicTitle')}</h3>
        <p className="cv-editor__empty">{t('logicLede')}</p>
        {nodes.length === 0 ? <p className="cv-editor__empty">{t('logicEmpty')}</p> : (
          <label className="ab-logic__field">
            <span>{t('logicNode')}</span>
            <select className="cv-editor__input" value={selected?.key ?? ''} onChange={(event) => setSelectedKey(event.target.value)}>
              {nodes.map((node) => <option key={node.key} value={node.key}>{node.screenName} · {node.path.join('.') || '0'} · {node.node.type}</option>)}
            </select>
          </label>
        )}
      </section>

      {selected ? <>
        <section className="surface-card ab-logic__section" aria-label={t('logicActions')}>
          <div className="ab-data__head"><h3>{t('logicActions')}</h3><Button variant="secondary" size="sm" onClick={addAction}><PlusIcon size={13} aria-hidden /> {t('logicAddAction')}</Button></div>
          {actions.length === 0 ? <p className="cv-editor__empty">{t('logicNoActions')}</p> : actions.map((action, index) => (
            <div className="ab-logic__rule" key={index}>
              <div className="ab-logic__row">
                <label className="ab-logic__field"><span>{t('logicEvent')}</span><select className="cv-editor__input" value={action.on ?? 'click'} onChange={(event) => actionFor(index, { on: event.target.value as EventName })}>{EVENTS.map((event) => <option key={event} value={event}>{t(`logicEvent_${event}`)}</option>)}</select></label>
                <label className="ab-logic__field"><span>{t('logicKind')}</span><select className="cv-editor__input" value={action.kind ?? 'navigate'} onChange={(event) => replaceAction(index, event.target.value as ActionKind)}>{KINDS.map((kind) => <option key={kind} value={kind} disabled={(kind === 'navigate' && screens.length === 0) || (kind === 'set-state' && vars.length === 0) || (kind === 'invoke-operation' && operations.length === 0)}>{t(`logicKind_${kind}`)}</option>)}</select></label>
                <Button variant="quiet" size="sm" aria-label={t('logicRemove')} title={t('logicRemove')} onClick={() => removeAction(index)}><TrashIcon size={13} aria-hidden /></Button>
              </div>
              {action.kind === 'navigate' ? <label className="ab-logic__field"><span>{t('logicScreen')}</span><select className="cv-editor__input" value={action.to ?? ''} onChange={(event) => actionFor(index, { to: event.target.value })}>{screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.name || screen.id}</option>)}</select></label> : null}
              {action.kind === 'set-state' ? <div className="ab-logic__row"><label className="ab-logic__field"><span>{t('logicState')}</span><select className="cv-editor__input" value={action.state ?? ''} onChange={(event) => actionFor(index, { state: event.target.value })}>{vars.map((variable) => <option key={variable.id} value={variable.id}>{variable.label || variable.id}</option>)}</select></label><label className="ab-logic__field"><span>{t('logicValue')}</span><CommitText value={JSON.stringify(action.value ?? '')} aria-label={t('logicValue')} onCommit={(value) => actionFor(index, { value: literal(value) })} /></label></div> : null}
              {action.kind === 'invoke-operation' || action.kind === 'submit-form' ? <label className="ab-logic__field"><span>{t('logicOperation')}</span><select className="cv-editor__input" value={action.operation ?? ''} onChange={(event) => { const operation = event.target.value; if (operation) actionFor(index, { operation }); else unsetActionField(index, 'operation'); }}><option value="">—</option>{operations.map((operation) => <option key={operation.id} value={operation.id}>{operation.name || operation.id}</option>)}</select></label> : null}
              {action.kind === 'open-modal' ? <label className="ab-logic__field"><span>{t('logicModal')}</span><CommitText value={action.modal ?? ''} aria-label={t('logicModal')} onCommit={(modal) => actionFor(index, { modal })} /></label> : null}
            </div>
          ))}
        </section>

        <section className="surface-card ab-logic__section" aria-label={t('logicBindings')}>
          <div className="ab-data__head"><h3>{t('logicBindings')}</h3><Button variant="secondary" size="sm" onClick={addBinding}><PlusIcon size={13} aria-hidden /> {t('logicAddBinding')}</Button></div>
          {Object.keys(bindings).length === 0 ? <p className="cv-editor__empty">{t('logicNoBindings')}</p> : Object.entries(bindings).map(([prop, binding]) => (
            <div className="ab-logic__rule" key={prop}>
              <div className="ab-logic__row">
                <label className="ab-logic__field"><span>{t('logicProp')}</span><select className="cv-editor__input" value={prop} onChange={(event) => {
                  const nextProp = event.target.value;
                  mutateNode((node) => { const next = { ...(node.bindings ?? {}) }; const saved = next[prop]; delete next[prop]; if (saved) next[nextProp] = saved; node.bindings = next; });
                }}>{propertyNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                <label className="ab-logic__field"><span>{t('logicMode')}</span><select className="cv-editor__input" value={binding.mode ?? 'one-way'} onChange={(event) => changeBinding(prop, { mode: event.target.value })}>{MODES.map((mode) => <option key={mode} value={mode} disabled={mode === 'two-way' && !supportsTwoWay(prop)}>{t(`logicMode_${mode}`)}</option>)}</select></label>
                <Button variant="quiet" size="sm" aria-label={t('logicRemove')} title={t('logicRemove')} onClick={() => removeBinding(prop)}><TrashIcon size={13} aria-hidden /></Button>
              </div>
              <div className="ab-logic__row">
                <label className="ab-logic__field"><span>{t('logicPath')}</span><CommitText value={binding.path ?? ''} aria-label={t('logicPath')} placeholder="state.search" onCommit={(path) => changeBinding(prop, { path })} /></label>
                <label className="ab-logic__field"><span>{t('logicFallback')}</span><CommitText value={binding.fallback ?? ''} aria-label={t('logicFallback')} onCommit={(fallback) => { if (fallback) changeBinding(prop, { fallback }); else unsetBindingField(prop, 'fallback'); }} /></label>
                <label className="ab-logic__field"><span>{t('logicFormat')}</span><select className="cv-editor__input" value={binding.format ?? ''} onChange={(event) => { const format = event.target.value; if (format) changeBinding(prop, { format }); else unsetBindingField(prop, 'format'); }}><option value="">—</option>{FORMATS.map((format) => <option key={format} value={format}>{t(`logicFormat_${format}`)}</option>)}</select></label>
              </div>
            </div>
          ))}
        </section>
      </> : null}
    </div>
  );
}
