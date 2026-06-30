/**
 * Workflows dashboard — list view at `/builder`.
 *
 * Renders saved workflows as a searchable / sortable grid of cards.
 * Each card supports rename (inline), duplicate, delete, and export
 * JSON via a three-dot menu. Persistence is localStorage-only; the
 * `version` counter forces re-reads after mutations.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import {
  newWorkflowId,
  topUpSeededWorkflows,
} from './persistence/localStore.js';
// ADR 0163 Phase 3 — the builder dashboard is now backed by the per-tenant
// backend ownership index (durable, assignable), with localStorage as a
// draft/offline cache. The sync localStore API is left intact for other
// consumers (chat @workflow mentions) per the architect review (R-A).
import {
  listWorkflows as listBackendWorkflows,
  loadWorkflow as loadBackendWorkflow,
  saveWorkflow as saveBackendWorkflow,
  removeWorkflow as removeBackendWorkflow,
  migrateLocalToBackend,
  listChainTemplates,
  instantiateChain,
  type WorkflowSummary,
  type ChainTemplate,
} from './persistence/backendStore.js';
import { ChainTemplateModal } from './templates/ChainTemplateModal.js';
import { AssignWorkflowModal } from './AssignWorkflowModal.js';
import { InstallPackModal } from './InstallPackModal.js';
import { toast } from '../ui/toast.js';
import { serializeWorkflow } from './schema/serialize.js';
import {
  PREMADE_WORKFLOWS,
  cloneTemplateToUserWorkflow,
  type TemplateWorkflow,
} from './templates/premadeWorkflows.js';
import { loadDynamicCatalog, useCatalog } from './palette/catalogRegistry.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { ArrowUpIcon, ArrowDownIcon, WorkflowIcon } from '../ui/icons/index.js';
import { WorkflowCard, WorkflowRow } from './WorkflowCardViews.js';

/** A template is offerable when it needs no pack nodes, or every pack
 *  typeId it needs is present in the merged catalog (host has the pack). */
function templateAvailable(tpl: TemplateWorkflow, installed: ReadonlySet<string>): boolean {
  return !tpl.requiresTypeIds || tpl.requiresTypeIds.every((t) => installed.has(t));
}

type SortBy = 'updated' | 'created' | 'name';
type SortDir = 'asc' | 'desc';

const SORT_LABEL_KEYS: Record<SortBy, string> = {
  updated: 'sortUpdated',
  created: 'sortCreated',
  name: 'sortName',
};

function compareWorkflows(a: WorkflowSummary, b: WorkflowSummary, by: SortBy): number {
  switch (by) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    case 'created':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updated':
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}

export function WorkflowsDashboard() {
  const { t } = useTranslation('builder');
  const nav = useNavigate();
  const location = useLocation();
  // ADR 0137 — an accepted Ambient Work Graph suggestion lands here; create a fresh
  // workflow and forward the seed to its canvas (where the AI drawer consumes it).
  useEffect(() => {
    const seed = (location.state as { workGraphSeed?: unknown } | null)?.workGraphSeed;
    if (seed) nav(`/builder/${newWorkflowId()}`, { state: { workGraphSeed: seed }, replace: true });
  }, [location.state, nav]);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [viewMode, setViewMode] = useViewMode('workflows', 'grid');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The workflow whose "Assign to…" modal is open (ADR 0163 follow-on).
  const [assigning, setAssigning] = useState<{ id: string; name: string } | null>(null);
  // Bumped after mutations to re-read localStorage on next render.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  // First-visit seed: every built-in (non-pack) premade template lands
  // in "Your workflows" so the dashboard isn't empty on day one. Pack-
  // dependent templates (requiresTypeIds) are deliberately excluded from
  // the seed — see the seed effect below. Subsequent visits no-op (a
  // `seeded` flag is persisted alongside) — if the user deletes
  // everything, we honor that intent and don't re-seed.
  // Pull the dynamic (pack) catalog so pack-dependent templates can be
  // gated on what the connected host actually has installed.
  useEffect(() => { void loadDynamicCatalog(); }, []);
  const catalog = useCatalog();
  const installedTypeIds = useMemo(() => new Set(catalog.map((e) => e.typeId)), [catalog]);

  useEffect(() => {
    // First-visit seed (local cache) of the built-in templates, THEN a
    // best-effort COPY into the backend ownership index (ADR 0163 R-C —
    // never deletes localStorage). Then load the list. Run-once on mount.
    void (async () => {
      const seeds = PREMADE_WORKFLOWS
        .filter((tpl) => !tpl.requiresTypeIds)
        .map((tpl) => cloneTemplateToUserWorkflow(tpl));
      topUpSeededWorkflows(seeds);
      await migrateLocalToBackend();
      refresh();
    })();
  }, []);

  // "Your workflows" — backend-primary (the per-tenant ownership index), with a
  // localStorage fallback baked into listBackendWorkflows for the offline path.
  // `version` is the cache-bust trigger: mutations call refresh() to re-fetch.
  const [all, setAll] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void listBackendWorkflows().then((list) => {
      if (live) { setAll(list); setLoading(false); }
    });
    return () => { live = false; };
  }, [version]);

  // ADR 0163 Phase 4 — the template gallery, fed by installed workflow-chain packs.
  const [chains, setChains] = useState<ChainTemplate[]>([]);
  const refreshChains = () => { void listChainTemplates().then(setChains); };
  useEffect(refreshChains, []);
  // ADR 0163 follow-on — the in-app marketplace (runtime pack install).
  const [installing, setInstalling] = useState(false);
  const [activeChain, setActiveChain] = useState<ChainTemplate | null>(null);
  const [instantiating, setInstantiating] = useState(false);
  const [instError, setInstError] = useState<string | undefined>(undefined);

  async function runInstantiate(chain: ChainTemplate, params: Record<string, unknown>) {
    setInstantiating(true);
    setInstError(undefined);
    try {
      const out = await instantiateChain(chain.chainId, params);
      if (out.warnings?.length) {
        toast.warning(t('templateNeedsSetup', { nodes: out.warnings.join(', ') }));
      }
      setActiveChain(null);
      nav(`/builder/${out.workflowId}`);
    } catch {
      setInstError(t('templateInstantiateError'));
    } finally {
      setInstantiating(false);
    }
  }

  function onUseChain(chain: ChainTemplate) {
    // No declared params → instantiate straight away; else collect them first.
    if (Object.keys(chain.parameters?.properties ?? {}).length === 0) {
      void runInstantiate(chain, {});
    } else {
      setInstError(undefined);
      setActiveChain(chain);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? all.filter((wf) => wf.name.toLowerCase().includes(q)) : all;
    const sorted = [...matched].sort((a, b) => compareWorkflows(a, b, sortBy));
    return sortDir === 'desc' ? sorted.reverse() : sorted;
  }, [all, query, sortBy, sortDir]);

  // Single click-outside listener while any kebab menu is open.
  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (menuOpenId === null) return;
    function onDocClick(e: MouseEvent) {
      const { target } = e;
      if (!(target instanceof Element)) return;
      if (!target.closest('.workflow-card-menu')) setMenuOpenId(null);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpenId]);

  function onCreate() {
    nav(`/builder/${newWorkflowId()}`);
  }

  function onOpen(id: string) {
    nav(`/builder/${id}`);
  }

  async function onRenameCommit(id: string, name: string) {
    const trimmed = name.trim();
    setRenamingId(null);
    if (!trimmed) return;
    const wf = await loadBackendWorkflow(id);
    if (wf) await saveBackendWorkflow({ ...wf, name: trimmed, updatedAt: new Date().toISOString() });
    refresh();
  }

  async function onDuplicate(id: string) {
    setMenuOpenId(null);
    const wf = await loadBackendWorkflow(id);
    if (!wf) return;
    const now = new Date().toISOString();
    await saveBackendWorkflow({ ...wf, id: newWorkflowId(), name: `${wf.name} (copy)`, createdAt: now, updatedAt: now });
    refresh();
  }

  async function onDelete(wf: WorkflowSummary) {
    if (!(await confirm({ title: t('deleteConfirm', { name: wf.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    setMenuOpenId(null);
    await removeBackendWorkflow(wf.id);
    refresh();
  }

  async function onExport(id: string) {
    setMenuOpenId(null);
    const wf = await loadBackendWorkflow(id);
    if (!wf) return;
    const blob = new Blob([JSON.stringify(serializeWorkflow(wf), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wf.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'workflow'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Older Safari/iOS need the URL to outlive the synchronous click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function onUseTemplate(template: TemplateWorkflow) {
    const cloned = cloneTemplateToUserWorkflow(template);
    await saveBackendWorkflow(cloned); // write-through to the backend (real, assignable)
    nav(`/builder/${cloned.id}`);
  }

  return (
    <section className="workflows-dashboard">
      <PageHeader
        eyebrow={t('dashboardEyebrow')}
        title={t('dashboardTitle')}
        lede={t('dashboardLede')}
        actions={<button type="button" className="btn-accent-solid" onClick={onCreate}>{t('newWorkflow')}</button>}
      />

      <div className="workflows-section">
        <div className="workflows-section-header">
          <h2>{t('yourWorkflows')}</h2>
        </div>

        <div className="workflows-toolbar">
          <input
            type="search"
            className="workflows-search"
            placeholder={t('searchByNamePlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="workflows-sort">
            <label htmlFor="wf-sort">{t('sortBy')}</label>
            <select
              id="wf-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
            >
              {(['updated', 'created', 'name'] as SortBy[]).map((k) => (
                <option key={k} value={k}>{t(SORT_LABEL_KEYS[k])}</option>
              ))}
            </select>
            <button
              className="secondary workflows-sort-dir"
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              title={sortDir === 'asc' ? t('sortAscendingTitle') : t('sortDescendingTitle')}
              aria-label={t('sortDirectionAria', { dir: sortDir })}
            >
              {sortDir === 'asc' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
            </button>
          </div>
          <span className="workflows-toolbar-summary muted">
            {t('filteredOfTotal', { filtered: filtered.length, total: all.length })}
          </span>
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
        </div>

        {loading && all.length === 0 ? (
          <StateCard icon={<WorkflowIcon size={20} />} title={t('common:loading')} />
        ) : all.length === 0 ? (
          <StateCard
            icon={<WorkflowIcon size={20} />}
            title={t('noWorkflowsYet')}
            body={t('noWorkflowsYetHint')}
          />
        ) : filtered.length === 0 ? (
          <StateCard
            icon={<WorkflowIcon size={20} />}
            title={t('noWorkflowsMatch', { query })}
          />
        ) : (
          <div className={viewMode === 'grid' ? 'workflows-grid' : 'surface-card list-view'} ref={gridRef}>
            {filtered.map((wf) => {
              const cardProps = {
                wf,
                menuOpen: menuOpenId === wf.id,
                onMenuToggle: () => setMenuOpenId((cur) => (cur === wf.id ? null : wf.id)),
                renaming: renamingId === wf.id,
                onRenameStart: () => {
                  setRenamingId(wf.id);
                  setMenuOpenId(null);
                },
                onRenameCommit: (name: string) => onRenameCommit(wf.id, name),
                onRenameCancel: () => setRenamingId(null),
                onOpen: () => onOpen(wf.id),
                onAssign: () => { setMenuOpenId(null); setAssigning({ id: wf.id, name: wf.name }); },
                onDuplicate: () => onDuplicate(wf.id),
                onDelete: () => onDelete(wf),
                onExport: () => onExport(wf.id),
              };
              return viewMode === 'grid' ? (
                <WorkflowCard key={wf.id} {...cardProps} />
              ) : (
                <WorkflowRow key={wf.id} {...cardProps} />
              );
            })}
          </div>
        )}
      </div>

      <div className="workflows-section">
        <div className="workflows-section-header">
          <h2>{t('templatesFromPacks')}</h2>
          <span className="muted">{t('templatesFromPacksHint')}</span>
          <button type="button" className="btn-secondary btn-sm u-ml-auto" onClick={() => setInstalling(true)}>
            {t('installPackCta')}
          </button>
        </div>
        {chains.length > 0 ? (
          <div className="workflows-grid">
            {chains.map((chain) => (
              <ChainTemplateCard key={chain.chainId} chain={chain} onUse={() => onUseChain(chain)} />
            ))}
          </div>
        ) : (
          <p className="muted u-fs-13">{t('templatesFromPacksEmpty')}</p>
        )}
      </div>

      <div className="workflows-section">
        <div className="workflows-section-header">
          <h2>{chains.length > 0 ? t('templatesStarter') : t('templates')}</h2>
          <span className="muted">{t('templatesHint')}</span>
        </div>
        <div className="workflows-grid">
          {PREMADE_WORKFLOWS.filter((tpl) => templateAvailable(tpl, installedTypeIds)).map((tpl) => (
            <TemplateCard key={tpl.templateId} template={tpl} onUse={() => onUseTemplate(tpl)} />
          ))}
        </div>
      </div>

      {activeChain && (
        <ChainTemplateModal
          template={activeChain}
          submitting={instantiating}
          error={instError}
          onSubmit={(params) => { void runInstantiate(activeChain, params); }}
          onClose={() => setActiveChain(null)}
        />
      )}

      {assigning && (
        <AssignWorkflowModal workflow={assigning} onClose={() => setAssigning(null)} />
      )}

      {installing && (
        <InstallPackModal
          installedPackNames={[...new Set(chains.map((c) => c.packName))]}
          onInstalled={refreshChains}
          onClose={() => setInstalling(false)}
        />
      )}
    </section>
  );
}

interface ChainTemplateCardProps {
  chain: ChainTemplate;
  onUse(): void;
}

/** A workflow-chain pack rendered as a template card (mirrors TemplateCard;
 *  a `.chip` marks the source pack). */
function ChainTemplateCard({ chain, onUse }: ChainTemplateCardProps) {
  const { t } = useTranslation('builder');
  return (
    <div className="workflow-card workflow-template-card">
      <div className="workflow-card-title-row">
        <h3 className="workflow-card-title">{chain.label}</h3>
        <span className="chip chip--ai" title={chain.packName}>{t('categoryPack')}</span>
      </div>
      <p className="workflow-template-description muted">{chain.description}</p>
      <div className="workflow-card-meta muted">
        <span title={chain.packName}>{chain.packName}</span>
      </div>
      <div className="workflow-template-actions">
        <button onClick={onUse}>{t('useTemplate')}</button>
      </div>
    </div>
  );
}

interface TemplateCardProps {
  template: TemplateWorkflow;
  onUse(): void;
}

const TEMPLATE_CATEGORY_LABEL_KEYS: Record<TemplateWorkflow['category'], string> = {
  quickstart: 'categoryQuickstart',
  hitl: 'categoryHitl',
  ai: 'categoryAi',
  pipeline: 'categoryPipeline',
};

function TemplateCard({ template, onUse }: TemplateCardProps) {
  const { t } = useTranslation('builder');
  const nodeCount = template.nodes.length;
  return (
    <div className="workflow-card workflow-template-card">
      <div className="workflow-card-title-row">
        <h3 className="workflow-card-title">{template.name}</h3>
        <span className={`workflow-template-badge workflow-template-badge-${template.category}`}>
          {t(TEMPLATE_CATEGORY_LABEL_KEYS[template.category])}
        </span>
      </div>
      <p className="workflow-template-description muted">{template.description}</p>
      <div className="workflow-card-meta muted">
        <span>{t('nodeCount', { count: nodeCount })}</span>
        {template.requiresBYOK && (
          <>
            <span aria-hidden="true">·</span>
            <span className="workflow-template-byok-pill" title={t('requiresByokTitle')}>
              {t('requiresByok')}
            </span>
          </>
        )}
      </div>
      <div className="workflow-template-actions">
        <button onClick={onUse}>{t('useTemplate')}</button>
      </div>
    </div>
  );
}
