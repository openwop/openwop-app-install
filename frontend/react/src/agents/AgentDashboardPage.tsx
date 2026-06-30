/**
 * `/agents` — the agent MANAGEMENT page (IA refresh 2026-06). "Who works here":
 * browse the workforce as profile tiles (or a dense list toggle for a big
 * fleet), filter by status/role, open/configure each agent, and hire new ones.
 *
 * DECISIONS LIVE IN THE INBOX now. The former "Needs you" hero (approvals +
 * board blockers) moved to /inbox — the single action portal — and the run
 * ledger moved to Mission Control (/mission), which owns the live fleet view.
 * This page is decision-free management.
 *
 * First visit seeds the built-in demo agents automatically (idempotent); the
 * roster/board/schedule data all come from the host-extension surfaces.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { checkAgent, seedExampleAgents } from './rosterClient.js';
import { listApprovals, type PendingApproval } from './approvalsClient.js';
import { getCapabilities } from '../client/runsClient.js';
import { loadAgentViews, type AgentView, type AgentStatus } from './agentViewModel.js';
import { roleKeyForAgent, roleThemeForKey } from './roleTemplates.js';
import { RosterRow } from './RosterRow.js';
import { AgentTile } from './AgentTile.js';
import { AgentDrawer, type DrawerTab } from './AgentDrawer.js';
import { HireAgentModal } from './HireAgentModal.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { KeyFigureBand } from '../ui/KeyFigure.js';
import { PageHeader } from '../ui/PageHeader.js';
import { BotIcon, AlertIcon } from '../ui/icons/index.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';

type SortKey = 'attention' | 'name';

// How much each agent wants the operator's eyes (highest first). "Waiting on a
// human" outranks everything; an idle agent with a full To Do queue outranks an
// empty one. Drives the default "Needs attention" sort so a 20-agent fleet
// surfaces what to look at first.
const STATUS_WEIGHT: Record<AgentStatus, number> = {
  error: 500,
  waiting: 400,
  'needs-setup': 300,
  working: 200,
  active: 100,
  paused: 0,
};
function attentionScore(v: AgentView): number {
  return STATUS_WEIGHT[v.status] + Math.min(v.laneCounts.todo, 99);
}

function ConceptStrip(): JSX.Element {
  const { t } = useTranslation('agents');
  const steps = [
    { n: '1', label: t('dashStep1') },
    { n: '2', label: t('dashStep2') },
    { n: '3', label: t('dashStep3') },
    { n: '4', label: t('dashStep4') },
  ];
  return (
    <div className="agentdash-concept-strip">
      {steps.map((s) => (
        <div key={s.n} className="agentdash-concept-step">
          <span className="agentdash-concept-badge">{s.n}</span>
          <span className="u-fs-14">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

export function AgentDashboardPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const [views, setViews] = useState<AgentView[]>([]);
  // Per-agent approvals power the quick-look drawer's "waiting on you" peek
  // (the GLOBAL queue lives in the Inbox; here it's agent-scoped context).
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [hiring, setHiring] = useState(false);
  // Quick-look drawer state rides the URL (?agent=<rosterId>&tab=) so a
  // drawer view is shareable/refreshable.
  const [searchParams, setSearchParams] = useSearchParams();
  const drawerId = searchParams.get('agent');
  const drawerTabParam = searchParams.get('tab');
  const drawerTab: DrawerTab = drawerTabParam === 'board' || drawerTabParam === 'activity' ? drawerTabParam : 'overview';
  const openDrawer = useCallback((rosterId: string, tab?: string) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('agent', rosterId);
      if (tab === 'board' || tab === 'activity') p.set('tab', tab);
      else p.delete('tab');
      return p;
    });
  }, [setSearchParams]);
  const closeDrawer = useCallback(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete('agent');
      p.delete('tab');
      return p;
    });
  }, [setSearchParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | AgentStatus>('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('attention');
  // Grid (profile tiles) is the default; the dense list toggles in for a big
  // fleet. The shared <ViewToggle> persists the choice per-surface.
  const [viewMode, setViewMode] = useViewMode('agents', 'grid');

  // Role families present in the current roster (for the role filter dropdown).
  const roleOptions = useMemo(() => {
    const keys = new Set(views.map((v) => roleKeyForAgent(v.entry.agentRef?.agentId, v.entry.workflows, v.entry.roleKey)));
    return [...keys].map((k) => ({ key: k, label: roleThemeForKey(k).label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [views]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = views.filter((v) => {
      if (statusFilter !== 'all' && v.status !== statusFilter) return false;
      if (roleFilter !== 'all' && roleKeyForAgent(v.entry.agentRef?.agentId, v.entry.workflows, v.entry.roleKey) !== roleFilter) return false;
      if (q) {
        const hay = `${v.entry.persona} ${v.entry.label ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return filtered.sort((a, b) =>
      sortKey === 'name'
        ? a.entry.persona.localeCompare(b.entry.persona)
        : attentionScore(b) - attentionScore(a) || a.entry.persona.localeCompare(b.entry.persona),
    );
  }, [views, query, statusFilter, roleFilter, sortKey]);

  const refresh = useCallback(async () => {
    try {
      const [v, ap] = await Promise.all([
        loadAgentViews(),
        listApprovals('pending').catch(() => []),
      ]);
      setViews(v);
      setApprovals(ap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // First load: hydrate; if the tenant has no agents yet, seed the example set
  // automatically (idempotent) so the first visit is never an empty screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let loaded = await loadAgentViews();
        if (loaded.length === 0) {
          // Only the public demo deployment auto-seeds on an empty roster; a
          // clean / white-label install stays empty and shows the explicit
          // "Load example agents" / "Create" empty state instead.
          const caps = await getCapabilities().catch(() => ({} as Record<string, unknown>));
          if ((caps as { demoMode?: boolean }).demoMode === true) {
            await seedExampleAgents();
            loaded = await loadAgentViews();
          }
        }
        if (!cancelled) {
          setViews(loaded);
          const ap = await listApprovals('pending').catch(() => []);
          if (!cancelled) setApprovals(ap);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const figures = useMemo(() => ({
    staff: views.length,
    working: views.filter((v) => v.status === 'working').length,
    waiting: views.filter((v) => v.status === 'waiting').length,
    ready: views.filter((v) => v.status === 'active').length,
  }), [views]);

  const onCheckNow = async (rosterId: string, persona: string) => {
    setBusyAgent(rosterId);
    setNotice(null);
    setError(null);
    try {
      const result = await checkAgent(rosterId);
      if (result.picked) {
        setNotice(t('dashPickedUp', { persona, title: result.cardTitle }));
      } else {
        setNotice(t('dashNoEligible', { persona, reason: result.reason ?? t('dashIdle') }));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAgent(null);
    }
  };

  const onLoadDemo = async () => {
    setSeeding(true);
    setError(null);
    try {
      await seedExampleAgents({ heal: true });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSeeding(false);
    }
  };

  const onOpenRow = (view: AgentView) => (tab?: string) => {
    if (tab === 'workflows') {
      // Editing flow — the full workspace, not the quick look.
      navigate(`/agents/${encodeURIComponent(view.entry.rosterId)}?tab=workflows`);
      return;
    }
    openDrawer(view.entry.rosterId, tab);
  };
  const onChatRow = (view: AgentView) => () => {
    const agentId = view.entry.agentRef?.agentId;
    navigate(agentId ? `/?agent=${encodeURIComponent(agentId)}` : '/');
  };

  return (
    <section>
      <PageHeader
        eyebrow={t('templatesEyebrow')}
        title={t('dashTitle')}
        lede={t('dashLede')}
        actions={
          <button type="button" className="btn-accent-solid" onClick={() => setHiring(true)}>{t('dashHireAgent')}</button>
        }
      />

      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {loading ? (
        <StateCard loading title={t('dashLoading')} />
      ) : views.length === 0 ? (
        <>
        <ConceptStrip />
        <StateCard
          icon={<BotIcon size={26} />}
          title={t('dashEmptyTitle')}
          body={t('dashEmptyBody')}
          action={
            <>
              <button type="button" className="primary" onClick={() => navigate('/agents/new')}>{t('dashCreateFromTemplate')}</button>
              <button type="button" className="secondary" onClick={() => void onLoadDemo()} disabled={seeding}>
                {seeding ? t('dashLoadingDemo') : t('dashLoadExample')}
              </button>
            </>
          }
        />
        </>
      ) : (
        <>
          {/* Key figures double as the status FILTER: a tile both reports the
              count and narrows the roster to it (the shared <KeyFigureBand>,
              DESIGN.md §4.5). */}
          <KeyFigureBand
            ariaLabel={t('dashKeyFiguresAria')}
            activeKey={statusFilter}
            onToggle={(key) => setStatusFilter(key as 'all' | AgentStatus)}
            figures={[
              { key: 'all', label: t('dashFigureOnStaff'), value: figures.staff },
              { key: 'working', label: t('dashFigureWorking'), value: figures.working },
              {
                key: 'waiting',
                label: t('dashFigureWaiting'),
                value: figures.waiting,
                ...(figures.waiting > 0 ? { tone: 'attention' as const, glyph: <AlertIcon size={11} aria-hidden /> } : {}),
              },
              { key: 'active', label: t('dashFigureReady'), value: figures.ready },
            ]}
          />

          <div className="filterbar" role="group" aria-label={t('dashFilterGroup')}>
            {views.length > 3 ? (
              <>
                <input
                  type="search"
                  className="ui-input filterbar-search"
                  placeholder={t('dashSearchPlaceholder')}
                  aria-label={t('dashSearchAria')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {roleOptions.length > 1 ? (
                  <select className="ui-input filterbar-select" aria-label={t('dashFilterRoleAria')} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                    <option value="all">{t('dashAllRoles')}</option>
                    {roleOptions.map((r) => (
                      <option key={r.key} value={r.key}>{r.label}</option>
                    ))}
                  </select>
                ) : null}
                <select className="ui-input filterbar-select" aria-label={t('dashSortAria')} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  <option value="attention">{t('dashSortAttention')}</option>
                  <option value="name">{t('dashSortName')}</option>
                </select>
              </>
            ) : null}
            <ViewToggle
              value={viewMode}
              onChange={setViewMode}
              className="u-ml-auto"
              labels={{ grid: t('dashTiles'), list: t('dashList') }}
            />
          </div>

          {visible.length === 0 ? (
            <StateCard
              icon={<BotIcon size={26} />}
              title={t('dashNoMatchTitle')}
              body={t('dashNoMatchBody')}
              action={<button type="button" className="secondary" onClick={() => { setQuery(''); setStatusFilter('all'); setRoleFilter('all'); }}>{t('dashClearFilters')}</button>}
            />
          ) : viewMode === 'grid' ? (
            <div className="card-grid">
              {visible.map((view) => (
                <AgentTile
                  key={view.entry.rosterId}
                  view={view}
                  busy={busyAgent === view.entry.rosterId}
                  onOpen={onOpenRow(view)}
                  onCheckNow={() => void onCheckNow(view.entry.rosterId, view.entry.persona)}
                  onChat={onChatRow(view)}
                />
              ))}
            </div>
          ) : (
            <div className="surface-card roster-list">
              {visible.map((view) => (
                <RosterRow
                  key={view.entry.rosterId}
                  view={view}
                  busy={busyAgent === view.entry.rosterId}
                  onOpen={onOpenRow(view)}
                  onCheckNow={() => void onCheckNow(view.entry.rosterId, view.entry.persona)}
                  onChat={onChatRow(view)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {hiring ? <HireAgentModal onClose={() => setHiring(false)} /> : null}

      {(() => {
        const drawerView = drawerId ? views.find((v) => v.entry.rosterId === drawerId) : undefined;
        if (!drawerView) return null;
        return (
          <AgentDrawer
            view={drawerView}
            approvals={approvals.filter((a) => a.rosterId === drawerView.entry.rosterId)}
            tab={drawerTab}
            onTab={(tab) => openDrawer(drawerView.entry.rosterId, tab)}
            onClose={closeDrawer}
            busy={busyAgent === drawerView.entry.rosterId}
            onCheckNow={() => void onCheckNow(drawerView.entry.rosterId, drawerView.entry.persona)}
            onResolved={() => void refresh()}
            onChat={() => {
              const agentId = drawerView.entry.agentRef?.agentId;
              navigate(agentId ? `/?agent=${encodeURIComponent(agentId)}` : '/');
            }}
          />
        );
      })()}
    </section>
  );
}
