/**
 * `/roster` route — Standing Agent Roster + Org-Chart (RFCS/0086 + 0087).
 *
 * Manage named "digital-twin employee" agents (persona + the manifest they
 * run + their workflow portfolio), and view/build the org-chart — departments
 * of members with a responsibility roll-up (the union of a department's
 * members' portfolios). The org edge is descriptive only: it confers no
 * authority (RFC 0087 §B).
 *
 * Tenant scoping is server-side; the page never sends a tenantId.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { RosterCard, autonomyBadge } from './RosterViews.js';
import { Skeleton, SkeletonRows } from '../ui/Skeleton.js';
import { KeyFigureBand } from '../ui/KeyFigure.js';
import { Modal } from '../ui/Modal.js';
import { IconButton } from '../ui/IconButton.js';
import {
  PlusIcon, TrashIcon, BotIcon, BuildingIcon, ZapIcon, UserIcon, XIcon, ShieldIcon,
} from '../ui/icons/index.js';
import {
  deleteRosterEntry,
  getDepartmentRollup,
  getOrgChart,
  listRoster,
  putOrgChart,
  updateRosterEntry,
  type OrgChart,
  type OrgDepartment,
  type ResponsibilityView,
  type RosterEntry,
} from './rosterClient.js';
import { toast } from '../ui/toast.js';

export function RosterPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [rollups, setRollups] = useState<Record<string, ResponsibilityView>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** The roster/org-chart read FAILED. `chart === null` already means BOTH "this
   *  workspace has no chart" and "we could not read one", and those render very
   *  differently — see the org-chart section. */
  const [loadFailed, setLoadFailed] = useState(false);
  /** Departments whose responsibility roll-up could not be read. Distinct from a
   *  department that genuinely owns nothing, which renders "Nothing yet". */
  const [rollupFailures, setRollupFailures] = useState<string[]>([]);
  const [view, setView] = useViewMode('roster', 'list');
  // Key-figure filter: which autonomy bucket the figures band has pinned (null = all).
  const [autonomyFilter, setAutonomyFilter] = useState<string | null>(null);
  // §4.5 collection kit (DESIGN.md rule 13): a name search feeding the same
  // visible-rows computation as the autonomy facet.
  const [query, setQuery] = useState('');
  // The roster entry awaiting destructive-delete confirmation (cohesion <Modal>).
  const [pendingDelete, setPendingDelete] = useState<RosterEntry | null>(null);
  const navigate = useNavigate();
  // Deep-link spine (Phase 3): the guardrails profile IS the agent workspace's
  // instructions tab (ADR 0493) — open the real route instead of a divergent
  // modal copy, so it's shareable/refreshable and there's one owner.
  const openProfile = useCallback(
    (r: RosterEntry) => navigate(`/agents/${encodeURIComponent(r.rosterId)}?tab=instructions`),
    [navigate],
  );

  const refresh = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([listRoster(), getOrgChart()]);
      setRoster(r);
      setChart(c);
      // Department rollups in parallel, not sequentially (GAP-ANALYSIS E3):
      // one serial await per department turned N departments into N round-trip
      // latencies on load. Each still degrades independently on failure.
      const views: Record<string, ResponsibilityView> = {};
      const failed: string[] = [];
      await Promise.all(
        c.departments.map(async (d) => {
          // A skipped roll-up used to render as NOTHING — no "Responsible for"
          // row at all — which reads as less configured than a department that
          // legitimately owns nothing and says "Nothing yet". Record the misses
          // so the omission can be disclosed instead of inferred.
          try { views[d.departmentId] = await getDepartmentRollup(d.departmentId); }
          catch { failed.push(d.departmentId); }
        }),
      );
      setRollups(views);
      setRollupFailures(failed);
      setLoadFailed(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onConfirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      await deleteRosterEntry(target.rosterId);
      // Backend cascade unpins the dead rosterId; nudge the live sidebar + chat
      // welcome to re-read so a pinned copy doesn't linger until a full reload.
      window.dispatchEvent(new Event('openwop:pinned-agents-changed'));
      window.dispatchEvent(new Event('openwop:pinned-chat-agents-changed'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Flip a member between autonomy levels: `auto` runs heartbeat picks
  // immediately; `review` routes them to the approval inbox for human sign-off.
  const onToggleAutonomy = async (r: RosterEntry) => {
    const next = r.autonomyLevel === 'review' ? 'auto' : 'review';
    try {
      await updateRosterEntry(r.rosterId, { autonomyLevel: next });
      await refresh();
      toast.success(
        next === 'review'
          ? t('rosterToggleReview', { persona: r.persona })
          : t('rosterToggleAuto', { persona: r.persona }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Convenience: put every roster member into one flat "All Agents" department,
  // so the org-chart + responsibility roll-up are demonstrable without a full
  // tree editor. reportsTo is null for all (no hierarchy) — descriptive only.
  const buildFlatChart = async () => {
    try {
      await putOrgChart({
        departments: [{ departmentId: 'dept-all', name: t('rosterFlatDeptName'), parentDepartmentId: null, roles: [{ roleId: 'role-member', name: t('rosterFlatRoleName') }] }],
        members: roster.map((r) => ({ rosterId: r.rosterId, departmentId: 'dept-all', roleId: 'role-member', reportsTo: null })),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const personaOf = (rosterId: string): string => roster.find((r) => r.rosterId === rosterId)?.persona ?? rosterId;

  const autonomyOf = (r: RosterEntry): 'auto' | 'guided' | 'review' => r.autonomyLevel ?? 'auto';

  // The figures band: count agents and the two posture buckets. Tiles double as
  // filters over the roster table (DESIGN.md §4.5 "stats are filters").
  const figures = useMemo(() => {
    const autoCount = roster.filter((r) => autonomyOf(r) !== 'review').length;
    const reviewCount = roster.filter((r) => autonomyOf(r) === 'review').length;
    return [
      { key: 'all', label: t('rosterFigureAgents'), value: roster.length },
      { key: 'auto', label: t('rosterFigureAuto'), value: autoCount },
      { key: 'review', label: t('rosterFigureReview'), value: reviewCount, tone: 'attention' as const },
    ];
  }, [roster, t]);

  const visibleRoster = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster.filter((r) => {
      if (autonomyFilter === 'review' && autonomyOf(r) !== 'review') return false;
      if (autonomyFilter === 'auto' && autonomyOf(r) === 'review') return false;
      if (q && !`${r.persona} ${r.label ?? ''} ${r.agentRef.agentId}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [roster, autonomyFilter, query]);
  const clearRosterFilters = (): void => { setAutonomyFilter(null); setQuery(''); };

  const columns: DataColumn<RosterEntry>[] = [
    {
      key: 'persona',
      header: t('rosterColPersona'),
      sortValue: (r) => r.persona.toLowerCase(),
      render: (r) => (
        <div className="u-flex u-flex-col">
          <Link className="inline-link" to={`/agents/${encodeURIComponent(r.rosterId)}`}><strong>{r.persona}</strong></Link>
          <span className="muted u-fs-12">{r.rosterId}{r.enabled ? '' : t('rosterDisabled')}</span>
        </div>
      ),
    },
    {
      key: 'agent',
      header: t('rosterColAgent'),
      sortValue: (r) => r.agentRef.agentId,
      cellClassName: 'muted',
      render: (r) => <code className="roster-wf-code">{r.agentRef.agentId}</code>,
    },
    {
      key: 'autonomy',
      header: t('rosterColAutonomy'),
      sortValue: (r) => autonomyOf(r),
      render: (r) => (
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          {autonomyBadge(r.autonomyLevel, t)}
          <Button
            variant="secondary" className="u-fs-12"
            onClick={() => void onToggleAutonomy(r)}
            title={autonomyOf(r) === 'review'
              ? t('rosterSetAutoTitle')
              : t('rosterSetReviewTitle')}
          >
            {autonomyOf(r) === 'review' ? t('rosterSetAuto') : t('rosterSetReview')}
          </Button>
        </div>
      ),
    },
    {
      key: 'portfolio',
      header: t('rosterColPortfolio'),
      render: (r) => (
        r.workflows.length > 0 ? (
          <div className="u-flex u-gap-2 u-wrap">
            {r.workflows.map((w) => <span key={w} className="chip chip--muted">{w}</span>)}
          </div>
        ) : <span className="muted u-fs-13">{t('rosterNoWorkflows')}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '120px',
      render: (r) => (
        <div className="u-flex u-items-center u-gap-2 u-justify-end">
          <Button
            variant="secondary" className="u-fs-12 u-flex u-items-center u-gap-1"
            onClick={() => openProfile(r)}
            title={t('rosterProfileTitle', { persona: r.persona })}
          >
            <ShieldIcon size={13} aria-hidden /> {t('rosterProfile')}
          </Button>
          <IconButton
            label={t('rosterDeletePersona', { persona: r.persona })}
            icon={<TrashIcon size={15} />}
            onClick={() => setPendingDelete(r)}
          />
        </div>
      ),
    },
  ];

  // Departments indented by parentDepartmentId so the chart reads as a tree.
  const depth = useCallback((d: OrgDepartment): number => {
    let n = 0;
    let cur: OrgDepartment | undefined = d;
    const seen = new Set<string>();
    while (cur?.parentDepartmentId && !seen.has(cur.departmentId)) {
      seen.add(cur.departmentId);
      const parent: OrgDepartment | undefined = chart?.departments.find((x) => x.departmentId === cur!.parentDepartmentId);
      if (!parent) break;
      cur = parent;
      n += 1;
    }
    return n;
  }, [chart]);

  return (
    <section data-walkthrough="roster.page" className="page-stack">
      <PageHeader
        eyebrow={t('rosterEyebrow')}
        title={t('rosterTitle')}
        lede={<Trans t={t} i18nKey="rosterLede" components={{ 0: <strong /> }} />}
        actions={
          <Link to="/agents/new" className="btn btn-accent-solid u-flex u-items-center u-gap-2">
            <PlusIcon size={14} aria-hidden /> {t('rosterAddAgent')}
          </Link>
        }
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <h2 className="u-fs-16">{t('rosterHeading')}</h2>

      {loading ? (
        <>
          <div className="figure-band" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div className="figure-tile" key={i}>
                {/* Label above value, mirroring the real tile since the band was
                    redesigned — a skeleton that models the OLD order shifts the
                    layout the moment the data lands. */}
                <Skeleton width={96} height={11} />
                <Skeleton width={48} height={34} />
              </div>
            ))}
          </div>
          <div className="surface-card">
            <SkeletonRows rows={4} columns={['28%', '24%', '20%', '20%']} />
          </div>
        </>
      ) : (
        <>
          <KeyFigureBand
            figures={figures}
            activeKey={autonomyFilter}
            onToggle={(k) => setAutonomyFilter((cur) => (cur === k ? null : k))}
            ariaLabel={t('rosterByAutonomy')}
          />

          {/* Deferred Phase C (AGENT-4): the raw add-form (persona + a raw wire
              agentId + comma-separated workflow ids) is retired — the create
              wizard is the ONE create path and already writes the roster entry
              (AgentCreateWizard:createRosterEntry). This page stays the
              org-chart/governance view. */}
          <div className="action-bar u-wrap u-items-center">
            <Link to="/agents/new" className="btn btn-accent-solid u-flex u-items-center u-gap-2">
              <PlusIcon size={14} aria-hidden /> {t('rosterHireViaWizard')}
            </Link>
          </div>

          {roster.length === 0 ? (
            <StateCard
              icon={<BotIcon size={28} />}
              title={t('rosterEmptyTitle')}
              body={t('rosterEmptyBody')}
              action={
                <Link to="/agents/new" className="btn btn-accent-solid u-flex u-items-center u-gap-2">
                  <PlusIcon size={14} aria-hidden /> {t('rosterAddFirst')}
                </Link>
              }
            />
          ) : (
            <>
              <div className="filterbar u-flex u-items-center u-wrap u-gap-2">
                {roster.length > 3 ? (
                  <input
                    type="search"
                    className="ui-input filterbar-search"
                    placeholder={t('rosterSearchPlaceholder')}
                    aria-label={t('rosterSearchAria')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                ) : null}
                <span className="muted u-fs-13">
                  {autonomyFilter && autonomyFilter !== 'all'
                    ? t('rosterCountFiltered', { count: visibleRoster.length, visible: visibleRoster.length, total: roster.length })
                    : t('rosterCount', { count: visibleRoster.length, visible: visibleRoster.length })}
                </span>
                <ViewToggle value={view} onChange={setView} className="u-ml-auto" />
              </div>
              {visibleRoster.length === 0 ? (
                <StateCard
                  icon={<BotIcon size={28} />}
                  title={t('rosterNoViewTitle')}
                  body={t('rosterNoViewBody')}
                  action={<Button variant="secondary" onClick={clearRosterFilters}>{t('rosterClearFilters')}</Button>}
                />
              ) : view === 'grid' ? (
                <div className="card-grid">
                  {visibleRoster.map((r) => (
                    <RosterCard
                      key={r.rosterId}
                      entry={r}
                      onToggleAutonomy={(x) => void onToggleAutonomy(x)}
                      onProfile={openProfile}
                      onDeleteRequest={setPendingDelete}
                    />
                  ))}
                </div>
              ) : (
                <DataTable
                  columns={columns}
                  rows={visibleRoster}
                  rowKey={(r) => r.rosterId}
                  caption={t('rosterCaption')}
                  initialSort={{ key: 'persona', dir: 'asc' }}
                  empty={
                    <StateCard
                      icon={<BotIcon size={28} />}
                      title={t('rosterNoViewTitle')}
                      body={t('rosterNoViewBody')}
                    />
                  }
                />
              )}
            </>
          )}
        </>
      )}

      <h2 className="u-fs-16 u-mt-5">{t('rosterOrgHeading')}</h2>
      <p className="roster-orgchart-lede">
        {t('rosterOrgLede')}
      </p>

      {loading ? (
        <div className="page-stack">
          {[0, 1].map((i) => (
            <div className="surface-card" key={i}>
              <Skeleton width={160} height={18} />
              <div className="u-mt-3"><Skeleton width="70%" /></div>
              <div className="u-mt-1"><Skeleton width="55%" /></div>
            </div>
          ))}
        </div>
      ) : loadFailed ? (
        // Tested BEFORE the empty state, not after. `chart === null` is what a
        // failed read leaves behind, so the empty branch would otherwise announce
        // "No org-chart yet" to a workspace that has one — and offer to BUILD a
        // replacement. `buildFlatChart` PUTs a single flat "All Agents"
        // department over whatever is stored, so accepting that offer would
        // flatten a real hierarchy on the strength of a network error.
        //
        // The write is not reachable today: this path leaves `roster` empty too
        // (one `Promise.all`, so a rejection discards both results) and the
        // button is `disabled={roster.length === 0}`. That guard is INCIDENTAL —
        // it protects against this by accident, not by intent — so the test pins
        // it, and this branch removes the reliance by not rendering the offer.
        <StateCard announce
          icon={<BuildingIcon size={28} />}
          title={t('rosterLoadFailedTitle')}
          body={error ?? t('rosterLoadFailedBody')}
          action={
            <Button variant="secondary" className="u-flex u-items-center u-gap-2" onClick={() => { setLoading(true); void refresh(); }}>
              {t('rosterRetry')}
            </Button>
          }
        />
      ) : !chart || chart.departments.length === 0 ? (
        <StateCard
          icon={<BuildingIcon size={28} />}
          title={t('rosterOrgEmptyTitle')}
          body={t('rosterOrgEmptyBody')}
          action={
            <Button variant="accent-solid" className="u-flex u-items-center u-gap-2" onClick={() => void buildFlatChart()} disabled={roster.length === 0}>
              <ZapIcon size={14} aria-hidden /> {t('rosterGenerateChart')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="action-bar">
            <Button variant="secondary" className="u-flex u-items-center u-gap-2" onClick={() => void buildFlatChart()} disabled={roster.length === 0}>
              <ZapIcon size={14} aria-hidden /> {t('rosterRebuildChart')}
            </Button>
          </div>
          <div className="page-stack">
            {chart.departments.map((d) => {
              const view = rollups[d.departmentId];
              const members = chart.members.filter((m) => m.departmentId === d.departmentId);
              const indent = depth(d);
              const parent = d.parentDepartmentId
                ? chart.departments.find((x) => x.departmentId === d.parentDepartmentId)?.name ?? d.parentDepartmentId
                : null;
              return (
                <div
                  key={d.departmentId}
                  className="surface-card"
                  style={indent > 0 ? { marginInlineStart: `calc(var(--space-4) * ${indent})` } : undefined}
                >
                  <div className="u-flex u-items-center u-gap-2 u-wrap">
                    <BuildingIcon size={16} aria-hidden />
                    <strong>{d.name}</strong>
                    {parent ? <span className="chip chip--muted">{t('rosterDeptUnder', { parent })}</span> : null}
                    <span className="chip chip--muted">{t('rosterMemberCount', { count: members.length })}</span>
                  </div>

                  {members.length > 0 ? (
                    <ul className="roster-member-list">
                      {members.map((m) => (
                        <li key={m.rosterId} className="u-flex u-items-center u-gap-2 u-fs-14">
                          <UserIcon size={13} aria-hidden />
                          <span>{personaOf(m.rosterId)}</span>
                          <span className="chip chip--muted">{d.roles.find((r) => r.roleId === m.roleId)?.name ?? m.roleId}</span>
                          {m.reportsTo ? <span className="muted u-fs-12">{t('rosterReportsTo', { persona: personaOf(m.reportsTo) })}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <div className="muted u-fs-13 u-mt-1">{t('rosterNoMembers')}</div>}

                  {!view && rollupFailures.includes(d.departmentId) ? (
                    // Say the roll-up is missing rather than omitting the row.
                    // Silence here is read as an answer: the neighbouring cards
                    // all carry a "Responsible for" line, so a department with no
                    // line looks LESS owned than one that says "Nothing yet".
                    <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-13 u-mt-1">
                      <span className="muted">{t('rosterResponsibleFor')}</span>
                      <span className="chip chip--warning">{t('rosterRollupUnavailable')}</span>
                    </div>
                  ) : null}
                  {view ? (
                    <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-13 u-mt-1">
                      <span className="muted">{t('rosterResponsibleFor')}</span>
                      {view.responsibilities.length > 0
                        ? view.responsibilities.map((w) => <span key={w} className="chip chip--accent">{w}</span>)
                        : <span className="muted">{t('rosterNothingYet')}</span>}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      {pendingDelete ? (
        <Modal onClose={() => setPendingDelete(null)} label={t('rosterDeleteModalLabel', { persona: pendingDelete.persona })}>
          <div className="hire-head">
            <div>
              <div className="hire-eyebrow">{t('rosterDeleteEyebrow')}</div>
              <h2 className="hire-title">{t('rosterDeleteConfirmTitle', { persona: pendingDelete.persona })}</h2>
              <p className="hire-lede">
                {t('rosterDeleteConfirmBody')}
              </p>
            </div>
            <IconButton label={t('drawerClose')} icon={<XIcon size={16} />} onClick={() => setPendingDelete(null)} />
          </div>
          <div className="hire-foot action-bar">
            <Button variant="secondary" size="sm" onClick={() => setPendingDelete(null)}>{t('newCancel')}</Button>
            <Button variant="accent-solid" size="sm" className="u-flex u-items-center u-gap-2" onClick={() => void onConfirmDelete()}>
              <TrashIcon size={14} aria-hidden /> {t('rosterDeleteAgent')}
            </Button>
          </div>
        </Modal>
      ) : null}

    </section>
  );
}
