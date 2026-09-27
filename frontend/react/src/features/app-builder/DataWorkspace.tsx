/**
 * The app-builder DATA workspace tab (ADR 0345 3d — DA-02/03/04, the first
 * consumer of the chassis `workspaceTabs` slot). Editors over the ADR 0343
 * facets — state variables, models (fields + relationships), operations
 * (contract + mock) — plus the entity-relationship view, which REUSES the
 * shared `GraphSurface` (DA-03: never a second graph engine). Entity-node
 * positions are session-ephemeral (the schema stores no model geometry);
 * every edit commits through the chassis history seam (one undo step each).
 * Validation stays server-owned (`validateAppDoc`) — this UI keeps inputs
 * within the closed vocabulary but never re-implements the validator.
 */
import { Button } from '../../ui/Button.js';
import { useMemo, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { GraphSurface } from '../../canvas/graph/GraphSurface.js';
import type { GraphNodeView, GraphEdgeView, WorkspaceTabProps } from '../../canvas/types.js';
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import type { AppDataSource, AppModel, AppModelField, AppOperation, AppStateVariable } from './screenOps.js';

const STATE_TYPES = ['string', 'number', 'boolean', 'list'] as const;
const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'reference'] as const;
const OP_KINDS = ['list', 'get', 'create', 'update', 'delete', 'action'] as const;
const OP_AUTH = ['none', 'user', 'role'] as const;
const REL_KINDS = ['hasOne', 'hasMany', 'belongsTo'] as const;

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** A \w-safe slug from a display name — the RFC 0124 lesson baked into the UI. */
const slug = (name: string, taken: Set<string>): string => {
  const base = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'm$1') || 'item';
  let out = base; let n = 2;
  while (taken.has(out)) out = `${base}_${n++}`;
  return out;
};

/** Text inputs hold a LOCAL draft while focused and commit ONE history step on
 *  blur — the DEF-6 text-edit contract (per-keystroke `commitDoc` flooded the
 *  undo stack with one step per character; grade pass 2026-07-11 AB-UX-4).
 *
 *  AB-G3 — `invalid` marks a committed value the SERVER will reject on save
 *  (`validateAppDoc` treats a non-\w or duplicate identifier as a blocking
 *  error, not a warning). Creation was already guarded by `slug()`; renaming
 *  wasn't, so a rename could quietly make the whole document unsaveable and the
 *  user only found out at save time, several edits later. */
function DraftText({ value, onCommit, invalid, invalidMessage, ...rest }: {
  value: string;
  onCommit: (v: string) => void;
  invalid?: boolean;
  invalidMessage?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'className'>): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <input
        {...rest}
        className={`cv-editor__input${invalid ? ' ab-data__ident--invalid' : ''}`}
        aria-invalid={invalid || undefined}
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); }}
      />
      {invalid && invalidMessage ? <span role="alert" className="cv-editor__field-error">{invalidMessage}</span> : null}
    </>
  );
}

/** The identifier rule `validateAppDoc` enforces server-side (WORD_RE). Kept
 *  here as the ONE place the UI mirrors it, next to `slug()` which produces
 *  conforming values on creation. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A committed identifier the server will reject: malformed, or a duplicate of
 *  an earlier one in the same list. Later duplicates are flagged, not the first,
 *  so the row the user just renamed is the one that lights up. */
const identIssue = (v: string, all: readonly string[], i: number): 'shape' | 'duplicate' | null => {
  if (!IDENT_RE.test(v)) return 'shape';
  return all.findIndex((o) => o === v) < i ? 'duplicate' : null;
};

export function DataWorkspace({ doc, commitDoc, onAnnounce }: WorkspaceTabProps): JSX.Element {
  const { t } = useTranslation('app-builder');
  const { t: tc } = useTranslation('canvas');
  /** Closed-vocabulary tokens shown as localized labels (grade pass AB-UX-5);
   *  the STORED value stays the schema token. */
  const enumLabel = (v: string): string => t(`dataEnum_${v}`, { defaultValue: v });
  const stateVars = arr<AppStateVariable>(doc.stateVariables);
  const dataSources = arr<AppDataSource>(doc.dataSources);
  const models = arr<AppModel>(doc.models);
  const operations = arr<AppOperation>(doc.operations);
  const varIds = stateVars.map((v) => v.id);
  /** AB-G3 — the DraftText props for an identifier issue (none → no props). */
  const identProps = (issue: 'shape' | 'duplicate' | null): { invalid?: boolean; invalidMessage?: string } =>
    (issue ? { invalid: true, invalidMessage: t(issue === 'duplicate' ? 'dataIdentDuplicate' : 'dataIdentInvalid') } : {});

  /* ── data sources ───────────────────────────────────────────────────── */
  const addSource = (): void => {
    const id = slug('source', new Set(dataSources.map((s) => s.id)));
    commitDoc((d) => { d.dataSources = [...arr<AppDataSource>(d.dataSources), { id, name: t('dataNewSource'), fields: [], rows: [] }]; });
    onAnnounce(t('dataAdded'));
  };
  const editSource = (i: number, patch: Partial<AppDataSource>): void => {
    commitDoc((d) => { const source = arr<AppDataSource>(d.dataSources)[i]; if (source) Object.assign(source, patch); });
  };
  const dropSource = (i: number): void => {
    commitDoc((d) => { d.dataSources = arr<AppDataSource>(d.dataSources).filter((_, j) => j !== i); });
    onAnnounce(t('dataRemoved'));
  };
  const [sourceRowsDraft, setSourceRowsDraft] = useState<Record<string, string>>({});
  const [sourceRowsInvalid, setSourceRowsInvalid] = useState<Record<string, boolean>>({});
  const commitSourceRows = (i: number, id: string): void => {
    const draft = sourceRowsDraft[id];
    if (draft === undefined) return;
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!Array.isArray(parsed) || parsed.length > 10 || !parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('shape');
      editSource(i, { rows: parsed as Record<string, unknown>[] });
      setSourceRowsInvalid((m) => ({ ...m, [id]: false }));
      onAnnounce(t('dataMockSaved'));
    } catch {
      setSourceRowsInvalid((m) => ({ ...m, [id]: true }));
      onAnnounce(t('dataMockInvalid'));
    }
  };

  /* ── state variables ─────────────────────────────────────────────────── */
  const addVar = (): void => {
    const id = slug('variable', new Set(stateVars.map((v) => v.id)));
    commitDoc((d) => { d.stateVariables = [...arr<AppStateVariable>(d.stateVariables), { id, type: 'string', initial: '' }]; });
    onAnnounce(t('dataAdded'));
  };
  const editVar = (i: number, patch: Partial<AppStateVariable>): void => {
    commitDoc((d) => {
      const list = arr<AppStateVariable>(d.stateVariables);
      const cur = list[i];
      if (cur) list[i] = { ...cur, ...patch };
    });
  };
  const dropVar = (i: number): void => {
    commitDoc((d) => { d.stateVariables = arr<AppStateVariable>(d.stateVariables).filter((_, j) => j !== i); });
    onAnnounce(t('dataRemoved'));
  };

  /* ── models ──────────────────────────────────────────────────────────── */
  const addModel = (): void => {
    const id = slug('model', new Set(models.map((m) => m.id)));
    commitDoc((d) => { d.models = [...arr<AppModel>(d.models), { id, name: t('dataNewModel'), fields: [{ name: 'name', type: 'string', required: true }] }]; });
    onAnnounce(t('dataAdded'));
  };
  const editModel = (i: number, mutate: (m: AppModel) => void): void => {
    commitDoc((d) => { const m = arr<AppModel>(d.models)[i]; if (m) mutate(m); });
  };
  const dropModel = (i: number): void => {
    commitDoc((d) => { d.models = arr<AppModel>(d.models).filter((_, j) => j !== i); });
    onAnnounce(t('dataRemoved'));
  };

  /* ── operations ──────────────────────────────────────────────────────── */
  const addOp = (): void => {
    const id = slug('operation', new Set(operations.map((o) => o.id)));
    commitDoc((d) => { d.operations = [...arr<AppOperation>(d.operations), { id, name: t('dataNewOperation'), kind: 'list', mock: { status: 'ok', rows: [] } }]; });
    onAnnounce(t('dataAdded'));
  };
  const editOp = (i: number, mutate: (o: AppOperation) => void): void => {
    commitDoc((d) => { const o = arr<AppOperation>(d.operations)[i]; if (o) mutate(o); });
  };
  const dropOp = (i: number): void => {
    commitDoc((d) => { d.operations = arr<AppOperation>(d.operations).filter((_, j) => j !== i); });
    onAnnounce(t('dataRemoved'));
  };
  /** Mock rows edit as bounded JSON; a parse failure keeps the old value and
   *  says so — the server validator remains the real gate on save. */
  const [rowsDraft, setRowsDraft] = useState<Record<string, string>>({});
  // Visible twin of the SR announcement (grade pass AB-UX-2): a sighted user
  // pasting bad JSON must see the rejection, not just hear it.
  const [rowsInvalid, setRowsInvalid] = useState<Record<string, boolean>>({});
  const commitRows = (i: number, opId: string): void => {
    const draft = rowsDraft[opId];
    if (draft === undefined) return;
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!Array.isArray(parsed) || parsed.length > 10 || !parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('shape');
      editOp(i, (o) => { o.mock = { ...(o.mock ?? { status: 'ok' }), rows: parsed as Record<string, unknown>[] }; });
      setRowsInvalid((m) => ({ ...m, [opId]: false }));
      onAnnounce(t('dataMockSaved'));
    } catch {
      setRowsInvalid((m) => ({ ...m, [opId]: true }));
      onAnnounce(t('dataMockInvalid'));
    }
  };

  /* ── entity graph (GraphSurface reuse; session-ephemeral positions) ───── */
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const nodes = useMemo((): GraphNodeView[] => models.map((m, i) => ({
    id: m.id,
    label: m.name || m.id,
    x: pos[m.id]?.x ?? 60 + (i % 4) * 240,
    y: pos[m.id]?.y ?? 60 + Math.floor(i / 4) * 180,
    data: m,
  })), [models, pos]);
  const edges = useMemo((): GraphEdgeView[] => models.flatMap((m, mi) =>
    (m.relationships ?? []).map((r, ri): GraphEdgeView => ({
      id: `${mi}:${ri}`, from: m.id, to: r.to, label: r.kind, data: r,
    }))), [models]);
  const graphLabels = useMemo(() => ({
    surface: t('dataEntityGraph'),
    connectFrom: tc('graphConnectFrom'), connectTo: tc('graphConnectTo'),
    cancelConnect: tc('graphCancelConnect'), connectArmed: tc('graphConnectArmed'),
    connected: tc('graphConnected'), deletedEdge: tc('graphDeletedEdge'),
    home: tc('graphHome'), empty: t('dataEntityEmpty'),
    addConnected: tc('graphAddConnected'), edgeSelected: tc('graphEdgeSelected'),
    deviceFrame: tc('graphDeviceFrame'), minimap: tc('graphMinimap'),
  }), [t, tc]);
  const [graphSel, setGraphSel] = useState<{ node: string | null; edge: string | null }>({ node: null, edge: null });

  return (
    <div className="ab-data">
      {/* ── data sources ── */}
      <section className="surface-card ab-data__section" aria-label={t('dataSources')}>
        <div className="ab-data__head">
          <h3>{t('dataSources')}</h3>
          <Button variant="secondary" size="sm" onClick={addSource}><PlusIcon size={13} aria-hidden /> {t('dataAddSource')}</Button>
        </div>
        {dataSources.map((source, i) => (
          <div key={i} className="ab-data__model">
            <div className="ab-data__row">
              <DraftText value={source.id} aria-label={t('dataSourceId')} onCommit={(id) => editSource(i, { id })} {...identProps(identIssue(source.id, dataSources.map((s) => s.id), i))} />
              <DraftText value={source.name ?? ''} placeholder={t('dataSourceName')} aria-label={t('dataSourceName')} onCommit={(name) => editSource(i, { name })} />
              <Button variant="quiet" size="sm" aria-label={t('dataRemove')} title={t('dataRemove')} onClick={() => dropSource(i)}><TrashIcon size={13} aria-hidden /></Button>
            </div>
            <label className="ab-data__field">
              <span>{t('dataSourceFields')}</span>
              <DraftText value={(source.fields ?? []).join(', ')} aria-label={t('dataSourceFields')} onCommit={(fields) => editSource(i, { fields: fields.split(',').map((f) => f.trim()).filter(Boolean).slice(0, 30) })} />
            </label>
            <label className="ab-data__field">
              <span>{t('dataSourceRows')}</span>
              <textarea
                className={`cv-editor__input ab-data__mock${sourceRowsInvalid[source.id] ? ' ab-data__mock--invalid' : ''}`}
                aria-label={t('dataSourceRows')}
                aria-invalid={sourceRowsInvalid[source.id] || undefined}
                placeholder={t('dataMockRowsHint')}
                value={sourceRowsDraft[source.id] ?? JSON.stringify(source.rows ?? [], null, 0)}
                onChange={(e) => setSourceRowsDraft((d) => ({ ...d, [source.id]: e.target.value }))}
                onBlur={() => commitSourceRows(i, source.id)}
              />
            </label>
            {sourceRowsInvalid[source.id] ? <p className="ab-data__mock-error">{t('dataMockInvalid')}</p> : null}
          </div>
        ))}
        {dataSources.length === 0 ? <p className="cv-editor__empty">{t('dataNoSources')}</p> : null}
      </section>

      {/* ── state variables ── */}
      <section className="surface-card ab-data__section" aria-label={t('dataStateVars')}>
        <div className="ab-data__head">
          <h3>{t('dataStateVars')}</h3>
          <Button variant="secondary" size="sm" onClick={addVar}><PlusIcon size={13} aria-hidden /> {t('dataAddVar')}</Button>
        </div>
        {stateVars.length === 0 ? <p className="cv-editor__empty">{t('dataNoVars')}</p> : (
          <ul className="ab-data__rows">
            {stateVars.map((v, i) => (
              <li key={i} className="ab-data__row">
                <DraftText
                  value={v.id}
                  aria-label={t('dataVarId')}
                  onCommit={(val) => editVar(i, { id: val })}
                  {...identProps(identIssue(v.id, varIds, i))}
                />
                <select className="cv-editor__input" value={v.type} aria-label={t('dataVarType')} onChange={(e) => editVar(i, { type: e.target.value as AppStateVariable['type'] })}>
                  {STATE_TYPES.map((x) => <option key={x} value={x}>{enumLabel(x)}</option>)}
                </select>
                <DraftText value={typeof v.initial === 'string' || typeof v.initial === 'number' ? String(v.initial) : ''} placeholder={t('dataVarInitial')} aria-label={t('dataVarInitial')} onCommit={(val) => editVar(i, { initial: v.type === 'number' ? Number(val) || 0 : val })} />
                <Button variant="quiet" size="sm" aria-label={t('dataRemove')} title={t('dataRemove')} onClick={() => dropVar(i)}><TrashIcon size={13} aria-hidden /></Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── models ── */}
      <section className="surface-card ab-data__section" aria-label={t('dataModels')}>
        <div className="ab-data__head">
          <h3>{t('dataModels')}</h3>
          <Button variant="secondary" size="sm" onClick={addModel}><PlusIcon size={13} aria-hidden /> {t('dataAddModel')}</Button>
        </div>
        {models.map((m, mi) => (
          <div key={mi} className="ab-data__model">
            <div className="ab-data__row">
              <DraftText value={m.name} aria-label={t('dataModelName')} onCommit={(val) => editModel(mi, (x) => { x.name = val; })} />
              <span className="chip chip--muted">{m.id}</span>
              <Button variant="quiet" size="sm" aria-label={t('dataRemove')} title={t('dataRemove')} onClick={() => dropModel(mi)}><TrashIcon size={13} aria-hidden /></Button>
            </div>
            <ul className="ab-data__rows">
              {(m.fields ?? []).map((f, fi) => (
                <li key={fi} className="ab-data__row">
                  <DraftText
                    value={f.name}
                    aria-label={t('dataFieldName')}
                    onCommit={(val) => editModel(mi, (x) => { const fld = x.fields[fi]; if (fld) fld.name = val; })}
                    {...identProps(identIssue(f.name, (m.fields ?? []).map((o) => o.name), fi))}
                  />
                  <select className="cv-editor__input" value={f.type} aria-label={t('dataFieldType')} onChange={(e) => editModel(mi, (x) => { const fld = x.fields[fi]; if (fld) { fld.type = e.target.value; if (e.target.value !== 'reference') delete fld.referenceTo; } })}>
                    {FIELD_TYPES.map((x) => <option key={x} value={x}>{enumLabel(x)}</option>)}
                  </select>
                  {f.type === 'reference' ? (
                    <select className="cv-editor__input" value={f.referenceTo ?? ''} aria-label={t('dataFieldRef')} onChange={(e) => editModel(mi, (x) => { const fld = x.fields[fi]; if (fld) fld.referenceTo = e.target.value; })}>
                      <option value="">—</option>
                      {models.map((o) => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
                    </select>
                  ) : null}
                  <label className="ab-data__req"><input type="checkbox" checked={Boolean(f.required)} onChange={(e) => editModel(mi, (x) => { const fld = x.fields[fi]; if (fld) { if (e.target.checked) fld.required = true; else delete fld.required; } })} /> {t('dataFieldRequired')}</label>
                  <Button variant="quiet" size="sm" aria-label={t('dataRemove')} title={t('dataRemove')} onClick={() => editModel(mi, (x) => { x.fields = x.fields.filter((_, j) => j !== fi); })}><TrashIcon size={13} aria-hidden /></Button>
                </li>
              ))}
            </ul>
            <Button variant="quiet" size="sm" onClick={() => editModel(mi, (x) => { x.fields = [...x.fields, { name: slug('field', new Set(x.fields.map((f) => f.name))), type: 'string' } satisfies AppModelField]; })}>
              <PlusIcon size={13} aria-hidden /> {t('dataAddField')}
            </Button>
          </div>
        ))}
        {models.length === 0 ? <p className="cv-editor__empty">{t('dataNoModels')}</p> : null}
      </section>

      {/* ── entity-relationship view (GraphSurface reuse) ── */}
      {models.length > 0 ? (
        <section className="surface-card ab-data__section ab-data__graph" aria-label={t('dataEntityGraph')}>
          <div className="ab-data__head"><h3>{t('dataEntityGraph')}</h3><span className="chip chip--muted">{t('dataEntityHint')}</span></div>
          <div className="ab-data__graph-box">
            <GraphSurface
              nodes={nodes}
              edges={edges}
              nodeSize={{ w: 200, h: 120 }}
              renderNode={(node) => {
                const m = node.data as AppModel;
                return (
                  <div className="ab-data__entity">
                    <strong>{m.name || m.id}</strong>
                    <ul>{(m.fields ?? []).slice(0, 5).map((f, i) => <li key={i}>{f.name}: {f.type}</li>)}</ul>
                  </div>
                );
              }}
              selectedNodeId={graphSel.node}
              selectedEdgeId={graphSel.edge}
              onSelectNode={(id) => setGraphSel({ node: id, edge: null })}
              onSelectEdge={(id) => setGraphSel({ node: null, edge: id || null })}
              onMoveNode={(id, x, y) => setPos((p) => ({ ...p, [id]: { x, y } }))}
              onConnect={(from, to) => {
                if (from === to) return false;
                const mi = models.findIndex((m) => m.id === from);
                if (mi < 0 || !models.some((m) => m.id === to)) return false;
                editModel(mi, (m) => { m.relationships = [...(m.relationships ?? []), { to, kind: 'hasOne' }]; });
                return true;
              }}
              onDeleteEdge={(id) => {
                const [miS, riS] = id.split(':');
                const mi = Number(miS), ri = Number(riS);
                if (!Number.isInteger(mi) || !Number.isInteger(ri)) return;
                editModel(mi, (m) => { m.relationships = (m.relationships ?? []).filter((_, j) => j !== ri); });
              }}
              onActivateNode={() => { /* entity nodes have no drill-in surface (yet) */ }}
              onAnnounce={(msg) => onAnnounce(msg)}
              labels={graphLabels}
            />
          </div>
          {edges.length ? (
            <ul className="ab-data__rows" aria-label={t('dataRelationships')}>
              {models.flatMap((m, mi) => (m.relationships ?? []).map((r, ri) => (
                <li key={`${mi}:${ri}`} className="ab-data__row">
                  <span>{m.name || m.id}</span>
                  <select className="cv-editor__input" value={r.kind} aria-label={t('dataRelKind')} onChange={(e) => editModel(mi, (x) => { const rel = (x.relationships ?? [])[ri]; if (rel) rel.kind = e.target.value; })}>
                    {REL_KINDS.map((k) => <option key={k} value={k}>{enumLabel(k)}</option>)}
                  </select>
                  <span>{models.find((o) => o.id === r.to)?.name ?? r.to}</span>
                  <Button variant="quiet" size="sm" aria-label={t('dataRemove')} title={t('dataRemove')} onClick={() => editModel(mi, (x) => { x.relationships = (x.relationships ?? []).filter((_, j) => j !== ri); })}><TrashIcon size={13} aria-hidden /></Button>
                </li>
              )))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* ── operations ── */}
      <section className="surface-card ab-data__section" aria-label={t('dataOperations')}>
        <div className="ab-data__head">
          <h3>{t('dataOperations')}</h3>
          <Button variant="secondary" size="sm" onClick={addOp}><PlusIcon size={13} aria-hidden /> {t('dataAddOp')}</Button>
        </div>
        {operations.map((o, oi) => (
          <div key={oi} className="ab-data__model">
            <div className="ab-data__row">
              <DraftText value={o.name} aria-label={t('dataOpName')} onCommit={(val) => editOp(oi, (x) => { x.name = val; })} />
              <span className="chip chip--muted">{o.id}</span>
              <select className="cv-editor__input" value={o.kind} aria-label={t('dataOpKind')} onChange={(e) => editOp(oi, (x) => { x.kind = e.target.value; })}>
                {OP_KINDS.map((k) => <option key={k} value={k}>{enumLabel(k)}</option>)}
              </select>
              <select className="cv-editor__input" value={o.modelId ?? ''} aria-label={t('dataOpModel')} onChange={(e) => editOp(oi, (x) => { if (e.target.value) x.modelId = e.target.value; else delete x.modelId; })}>
                <option value="">—</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
              </select>
              <select className="cv-editor__input" value={o.auth ?? 'none'} aria-label={t('dataOpAuth')} onChange={(e) => editOp(oi, (x) => { x.auth = e.target.value; })}>
                {OP_AUTH.map((a) => <option key={a} value={a}>{enumLabel(a)}</option>)}
              </select>
              <Button variant="quiet" size="sm" aria-label={t('dataRemove')} title={t('dataRemove')} onClick={() => dropOp(oi)}><TrashIcon size={13} aria-hidden /></Button>
            </div>
            <div className="ab-data__row">
              <select className="cv-editor__input" value={o.mock?.status ?? 'ok'} aria-label={t('dataMockStatus')} onChange={(e) => editOp(oi, (x) => { x.mock = { ...(x.mock ?? {}), status: e.target.value }; })}>
                <option value="ok">{enumLabel('ok')}</option>
                <option value="error">{enumLabel('error')}</option>
              </select>
              <textarea
                className={`cv-editor__input ab-data__mock${rowsInvalid[o.id] ? ' ab-data__mock--invalid' : ''}`}
                aria-label={t('dataMockRows')}
                aria-invalid={rowsInvalid[o.id] || undefined}
                placeholder={t('dataMockRowsHint')}
                value={rowsDraft[o.id] ?? JSON.stringify(o.mock?.rows ?? [], null, 0)}
                onChange={(e) => setRowsDraft((d) => ({ ...d, [o.id]: e.target.value }))}
                onBlur={() => commitRows(oi, o.id)}
              />
            </div>
            {rowsInvalid[o.id] ? <p className="ab-data__mock-error">{t('dataMockInvalid')}</p> : null}
          </div>
        ))}
        {operations.length === 0 ? <p className="cv-editor__empty">{t('dataNoOps')}</p> : null}
      </section>
    </div>
  );
}
