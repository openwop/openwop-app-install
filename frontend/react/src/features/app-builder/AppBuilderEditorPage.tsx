/**
 * App-builder full-screen editor (ADR 0153 Phase 2b). Edits a `host.canvas` working
 * copy of a `canvas.app-builder` design — outside the chat — with a component palette
 * (from the closed host catalog), a screen switcher, a live preview, a component-tree
 * outline for selection, and a catalog-driven property panel. Saves with optimistic
 * concurrency (the run artifact is never mutated — the editor edits the seeded copy).
 *
 * Reached at `/app-builder/:canvasId`, or `/app-builder/new?fromArtifact=<runId:nodeId>`
 * to seed an editable copy from a chat artifact and edit it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard, Notice } from '../../ui/index.js';
import { AppBuilderContentView } from '../../chat/artifacts/AppBuilderPreview.js';
import {
  listOrgs, getCatalog, getCanvas, seedFromArtifact, saveCanvas,
  type ComponentDef, type CatalogResponse, type CanvasRecord,
} from './canvasEditorClient.js';
import { nodeAt, addChild, deleteAt, setPropAt, type CompNode, type Screen } from './canvasTree.js';

interface App { name: string; description?: string; theme?: string; screens: Screen[]; connectors?: unknown[] }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Narrow the canvas state (opaque `Record<string, unknown>`) into the editable App
 *  shape with safe fallbacks — avoids laundering through `as unknown as`. */
function coerceApp(state: Record<string, unknown>): App {
  return {
    name: typeof state.name === 'string' ? state.name : 'Untitled app',
    ...(typeof state.description === 'string' ? { description: state.description } : {}),
    ...(typeof state.theme === 'string' ? { theme: state.theme } : {}),
    screens: Array.isArray(state.screens) ? (state.screens as Screen[]) : [],
    ...(Array.isArray(state.connectors) ? { connectors: state.connectors } : {}),
  };
}

/** Default props for a freshly-added component, from its catalog prop defaults. */
function defaultProps(def: ComponentDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.props ?? []) if (p.default !== undefined) out[p.name] = p.default;
  return out;
}

export function AppBuilderEditorPage(): JSX.Element {
  const { t } = useTranslation('app-builder');
  const { canvasId: routeCanvasId } = useParams();
  const [search] = useSearchParams();
  const fromArtifact = search.get('fromArtifact');

  const [orgId, setOrgId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [app, setApp] = useState<App | null>(null);
  const [version, setVersion] = useState(0);
  const [screenIdx, setScreenIdx] = useState(0);
  const [selPath, setSelPath] = useState<number[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  // Load: org → catalog → (seed-from-artifact | get) the canvas.
  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        const orgs = await listOrgs();
        const org = orgs[0]?.orgId;
        if (!org) throw new Error(t('noOrg'));
        const cat = await getCatalog(org);
        let rec: CanvasRecord;
        if (routeCanvasId === 'new' && fromArtifact) {
          rec = await seedFromArtifact(org, fromArtifact);
        } else if (routeCanvasId) {
          rec = await getCanvas(org, routeCanvasId);
        } else {
          throw new Error(t('loadError'));
        }
        if (!live) return;
        setOrgId(org); setCatalog(cat); setCanvasId(rec.canvasId);
        setApp(coerceApp(rec.state)); setVersion(rec.version);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : t('loadError'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [routeCanvasId, fromArtifact, t]);

  const screen = app?.screens?.[screenIdx] ?? null;
  const selNode = useMemo(() => (screen && selPath ? nodeAt(screen, selPath) : null), [screen, selPath]);
  const selDef = useMemo(() => (selNode && catalog ? catalog.components.find((c) => c.type === selNode.type) ?? null : null), [selNode, catalog]);

  // Mutate the active screen via a cloning updater (immutable; marks dirty).
  const editScreen = useCallback((fn: (s: Screen) => void) => {
    setApp((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      const s = next.screens[screenIdx];
      if (s) fn(s);
      return next;
    });
    setDirty(true);
  }, [screenIdx]);

  const addComponent = useCallback((def: ComponentDef) => {
    const node: CompNode = { type: def.type, props: defaultProps(def) };
    // Add into the selected container if it accepts children, else at screen root.
    const parent = selPath && selDef?.acceptsChildren ? selPath : null;
    editScreen((s) => addChild(s, parent, node));
  }, [editScreen, selPath, selDef]);

  const setProp = useCallback((name: string, value: unknown) => {
    if (!selPath) return;
    editScreen((s) => setPropAt(s, selPath, name, value));
  }, [editScreen, selPath]);

  const deleteSelected = useCallback(() => {
    if (!selPath || selPath.length === 0) return;
    editScreen((s) => deleteAt(s, selPath));
    setSelPath(null);
  }, [editScreen, selPath]);

  const onSave = useCallback(async () => {
    if (!orgId || !canvasId || !app) return;
    setSaving(true); setError(null); setConflict(false);
    try {
      const res = await saveCanvas(orgId, canvasId, { ...app }, version);
      setVersion(res.newVersion); setDirty(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) setConflict(true);
      else setError(e instanceof Error ? e.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }, [orgId, canvasId, app, version, t]);

  if (loading) return <div className="ab-editor"><StateCard loading title={t('loading')} /></div>;
  if (error && !app) return <div className="ab-editor"><Notice variant="error">{error}</Notice></div>;
  if (!app || !catalog) return <div className="ab-editor"><Notice variant="error">{t('loadError')}</Notice></div>;

  return (
    <div className="ab-editor">
      <header className="ab-editor__bar">
        <input
          className="ab-editor__name"
          value={app.name}
          aria-label={t('appName')}
          onChange={(e) => { setApp((p) => (p ? { ...p, name: e.target.value } : p)); setDirty(true); }}
        />
        <span className="ab-editor__version">{t('version', { n: version })}</span>
        {dirty ? <span className="chip chip--muted">{t('unsaved')}</span> : null}
        <button type="button" className="primary btn-sm ab-editor__save" disabled={saving || !dirty} onClick={onSave}>
          {saving ? t('saving') : t('save')}
        </button>
      </header>

      {conflict ? <Notice variant="warning">{t('conflict')}</Notice> : null}
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="ab-editor__cols">
        {/* Palette — the closed component catalog. */}
        <aside className="ab-editor__palette" aria-label={t('palette')}>
          <h2 className="ab-editor__panel-title">{t('palette')}</h2>
          <ul className="ab-editor__palette-list">
            {catalog.components.map((c) => (
              <li key={c.type}>
                <button type="button" className="ab-editor__palette-item" onClick={() => addComponent(c)} title={c.description ?? c.label}>
                  <span className="ab-editor__palette-label">{c.label}</span>
                  {c.acceptsChildren ? <span className="ab-editor__palette-tag">{t('container')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Center — screen switcher + live preview + component outline. */}
        <main className="ab-editor__center">
          <nav className="ab-editor__screens" aria-label={t('screens')}>
            {app.screens.map((s, i) => (
              <button key={s.id} type="button" aria-pressed={i === screenIdx} className={`ab-editor__screen-tab${i === screenIdx ? ' is-active' : ''}`} onClick={() => { setScreenIdx(i); setSelPath(null); }}>
                {s.name}{s.isInitial ? <span className="ab-editor__home-tag">{t('home')}</span> : null}
              </button>
            ))}
          </nav>
          <div className="ab-editor__preview">
            <AppBuilderContentView content={JSON.stringify({ ...app, screens: screen ? [screen] : [] })} />
          </div>
          {screen ? (
            <div className="ab-editor__outline" aria-label={t('outline')}>
              <h2 className="ab-editor__panel-title">{t('outline')}</h2>
              <OutlineTree nodes={screen.components ?? []} path={[]} selPath={selPath} onSelect={setSelPath} />
            </div>
          ) : null}
        </main>

        {/* Right — catalog-driven property panel for the selected component. */}
        <aside className="ab-editor__props" aria-label={t('properties')}>
          <h2 className="ab-editor__panel-title">{t('properties')}</h2>
          {selNode && selDef ? (
            <div className="ab-editor__prop-form">
              <div className="ab-editor__prop-type">{selDef.label}</div>
              {(selDef.props ?? []).map((p) => {
                const val = selNode.props?.[p.name];
                const id = `prop-${p.name}`;
                return (
                  <div key={p.name} className="ab-editor__field">
                    <label htmlFor={id} className="ab-editor__field-label">{p.label ?? p.name}{p.required ? ' *' : ''}</label>
                    {p.type === 'boolean' ? (
                      <input id={id} type="checkbox" checked={Boolean(val)} onChange={(e) => setProp(p.name, e.target.checked)} />
                    ) : p.type === 'number' ? (
                      <input id={id} type="number" className="ab-editor__input" value={typeof val === 'number' ? val : ''} onChange={(e) => setProp(p.name, e.target.value === '' ? undefined : Number(e.target.value))} />
                    ) : p.type === 'enum' ? (
                      <select id={id} className="ab-editor__input" value={typeof val === 'string' ? val : ''} onChange={(e) => setProp(p.name, e.target.value)}>
                        <option value="">—</option>
                        {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : p.type === 'longtext' ? (
                      <textarea id={id} className="ab-editor__input ab-editor__textarea" value={typeof val === 'string' ? val : ''} onChange={(e) => setProp(p.name, e.target.value)} />
                    ) : (
                      <input id={id} type="text" className="ab-editor__input" value={typeof val === 'string' ? val : ''} onChange={(e) => setProp(p.name, e.target.value)} />
                    )}
                  </div>
                );
              })}
              <button type="button" className="secondary btn-sm ab-editor__delete" onClick={deleteSelected}>{t('deleteComponent')}</button>
            </div>
          ) : (
            <p className="ab-editor__empty">{t('selectHint')}</p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Recursive component-tree outline (the "layers" panel) — click a row to select it. */
function OutlineTree({ nodes, path, selPath, onSelect }: {
  nodes: CompNode[]; path: number[]; selPath: number[] | null; onSelect: (p: number[]) => void;
}): JSX.Element {
  return (
    <ul className="ab-editor__tree">
      {nodes.map((n, i) => {
        const here = [...path, i];
        const selected = selPath?.length === here.length && selPath.every((v, k) => v === here[k]);
        return (
          <li key={i}>
            <button type="button" className={`ab-editor__tree-row${selected ? ' is-sel' : ''}`} onClick={() => onSelect(here)}>
              {n.type}
            </button>
            {n.children && n.children.length ? <OutlineTree nodes={n.children} path={here} selPath={selPath} onSelect={onSelect} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
