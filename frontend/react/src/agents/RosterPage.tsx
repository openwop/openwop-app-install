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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { DataTable, DensityToggle, type DataColumn } from '../ui/DataTable.js';
import { Skeleton, SkeletonRows } from '../ui/Skeleton.js';
import { KeyFigureBand } from '../ui/KeyFigure.js';
import { Field, TextField } from '../ui/Field.js';
import { Modal } from '../ui/Modal.js';
import { IconButton } from '../ui/IconButton.js';
import {
  PlusIcon, TrashIcon, BotIcon, BuildingIcon, ZapIcon, UserIcon, XIcon, ShieldIcon,
} from '../ui/icons/index.js';
import { AgentGuardrailsPanel } from './AgentGuardrailsPanel.js';
import {
  createRosterEntry,
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

/** Autonomy → a labelled StatusBadge tone (status semantics come from the badge,
 *  never an inline color). `review` is a held/needs-sign-off posture → amber;
 *  `auto` runs immediately → completed/green. */
function autonomyBadge(level: RosterEntry['autonomyLevel'], t: TFunction): JSX.Element {
  if (level === 'review') return <StatusBadge status="waiting-approval" label={t('rosterLevelReview')} />;
  if (level === 'guided') return <StatusBadge status="paused" label={t('rosterLevelGuided')} />;
  return <StatusBadge status="completed" label={t('rosterLevelAuto')} />;
}

export function RosterPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [rollups, setRollups] = useState<Record<string, ResponsibilityView>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [persona, setPersona] = useState('');
  const [agentId, setAgentId] = useState('core.openwop.agents.brief-writer');
  const [workflows, setWorkflows] = useState('');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  // Key-figure filter: which autonomy bucket the figures band has pinned (null = all).
  const [autonomyFilter, setAutonomyFilter] = useState<string | null>(null);
  // The roster entry awaiting destructive-delete confirmation (cohesion <Modal>).
  const [pendingDelete, setPendingDelete] = useState<RosterEntry | null>(null);
  // The roster entry whose governance profile is open in the editor modal (ADR 0031).
  const [profileFor, setProfileFor] = useState<RosterEntry | null>(null);
  const personaInputRef = useRef<HTMLInputElement>(null);

  const focusAddAgent = useCallback(() => {
    personaInputRef.current?.focus();
    personaInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([listRoster(), getOrgChart()]);
      setRoster(r);
      setChart(c);
      // Department rollups in parallel, not sequentially (GAP-ANALYSIS E3):
      // one serial await per department turned N departments into N round-trip
      // latencies on load. Each still degrades independently on failure.
      const views: Record<string, ResponsibilityView> = {};
      await Promise.all(
        c.departments.map(async (d) => {
          try { views[d.departmentId] = await getDepartmentRollup(d.departmentId); } catch { /* skip */ }
        }),
      );
      setRollups(views);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!persona.trim() || !agentId.trim()) return;
    try {
      await createRosterEntry({
        persona: persona.trim(),
        agentRef: { agentId: agentId.trim() },
        workflows: workflows.split(',').map((w) => w.trim()).filter(Boolean),
      });
      setPersona('');
      setWorkflows('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onConfirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      await deleteRosterEntry(target.rosterId);
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
    if (!autonomyFilter || autonomyFilter === 'all') return roster;
    if (autonomyFilter === 'review') return roster.filter((r) => autonomyOf(r) === 'review');
    if (autonomyFilter === 'auto') return roster.filter((r) => autonomyOf(r) !== 'review');
    return roster;
  }, [roster, autonomyFilter]);

  const columns: DataColumn<RosterEntry>[] = [
    {
      key: 'persona',
      header: t('rosterColPersona'),
      sortValue: (r) => r.persona.toLowerCase(),
      render: (r) => (
        <div className="u-flex u-flex-col">
          <strong>{r.persona}</strong>
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
          <button
            type="button"
            className="secondary u-fs-12"
            onClick={() => void onToggleAutonomy(r)}
            title={autonomyOf(r) === 'review'
              ? t('rosterSetAutoTitle')
              : t('rosterSetReviewTitle')}
          >
            {autonomyOf(r) === 'review' ? t('rosterSetAuto') : t('rosterSetReview')}
          </button>
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
          <button
            type="button"
            className="secondary u-fs-12 u-flex u-items-center u-gap-1"
            onClick={() => setProfileFor(r)}
            title={t('rosterProfileTitle', { persona: r.persona })}
          >
            <ShieldIcon size={13} aria-hidden /> {t('rosterProfile')}
          </button>
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
    <section className="page-stack">
      <PageHeader
        eyebrow={t('rosterEyebrow')}
        title={t('rosterTitle')}
        lede={<Trans t={t} i18nKey="rosterLede" components={{ 0: <strong /> }} />}
        actions={
          <button type="button" className="btn-accent-solid u-flex u-items-center u-gap-2" onClick={focusAddAgent}>
            <PlusIcon size={14} aria-hidden /> {t('rosterAddAgent')}
          </button>
        }
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <h2 className="u-fs-16">{t('rosterHeading')}</h2>

      {loading ? (
        <>
          <div className="figure-band" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div className="figure-tile" key={i}>
                <Skeleton width={48} height={34} />
                <Skeleton width={96} height={11} />
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

          <form onSubmit={onCreate} className="action-bar u-wrap u-items-center">
            <TextField
              ref={personaInputRef}
              label={t('rosterPersona')}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder={t('rosterPersonaPlaceholder')}
            />
            <TextField
              label={t('rosterAgentId')}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="u-minw-240"
            />
            <Field label={t('rosterPortfolio')} help={t('rosterPortfolioHelp')}>
              {(w) => (
                <input
                  {...w}
                  value={workflows}
                  onChange={(e) => setWorkflows(e.target.value)}
                  placeholder={t('rosterPortfolioPlaceholder')}
                  className="u-minw-240"
                />
              )}
            </Field>
            <button type="submit" className="btn-accent-solid u-flex u-items-center u-gap-2">
              <PlusIcon size={14} aria-hidden /> {t('rosterAddAgent')}
            </button>
          </form>

          {roster.length === 0 ? (
            <StateCard
              icon={<BotIcon size={28} />}
              title={t('rosterEmptyTitle')}
              body={t('rosterEmptyBody')}
              action={
                <button type="button" className="btn-accent-solid u-flex u-items-center u-gap-2" onClick={focusAddAgent}>
                  <PlusIcon size={14} aria-hidden /> {t('rosterAddFirst')}
                </button>
              }
            />
          ) : (
            <>
              <div className="filterbar u-flex u-justify-between u-items-center u-wrap">
                <span className="muted u-fs-13">
                  {autonomyFilter && autonomyFilter !== 'all'
                    ? t('rosterCountFiltered', { count: visibleRoster.length, visible: visibleRoster.length, total: roster.length })
                    : t('rosterCount', { count: visibleRoster.length, visible: visibleRoster.length })}
                </span>
                <DensityToggle value={density} onChange={setDensity} />
              </div>
              <DataTable
                columns={columns}
                rows={visibleRoster}
                rowKey={(r) => r.rosterId}
                density={density}
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
      ) : !chart || chart.departments.length === 0 ? (
        <StateCard
          icon={<BuildingIcon size={28} />}
          title={t('rosterOrgEmptyTitle')}
          body={t('rosterOrgEmptyBody')}
          action={
            <button type="button" className="btn-accent-solid u-flex u-items-center u-gap-2" onClick={() => void buildFlatChart()} disabled={roster.length === 0}>
              <ZapIcon size={14} aria-hidden /> {t('rosterGenerateChart')}
            </button>
          }
        />
      ) : (
        <>
          <div className="action-bar">
            <button type="button" className="secondary u-flex u-items-center u-gap-2" onClick={() => void buildFlatChart()} disabled={roster.length === 0}>
              <ZapIcon size={14} aria-hidden /> {t('rosterRebuildChart')}
            </button>
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
            <button type="button" className="secondary btn-sm" onClick={() => setPendingDelete(null)}>{t('newCancel')}</button>
            <button type="button" className="btn-accent-solid btn-sm u-flex u-items-center u-gap-2" onClick={() => void onConfirmDelete()}>
              <TrashIcon size={14} aria-hidden /> {t('rosterDeleteAgent')}
            </button>
          </div>
        </Modal>
      ) : null}

      {profileFor ? (
        <Modal
          onClose={() => setProfileFor(null)}
          label={t('rosterProfileModalLabel', { persona: profileFor.persona })}
          className="surface-card agentprofile-modal"
        >
          <div className="hire-head">
            <div>
              <div className="hire-eyebrow">{t('rosterGovernanceProfile')}</div>
              <h2 className="hire-title">{profileFor.persona}</h2>
              <p className="hire-lede">
                {t('rosterProfileModalLede')}
              </p>
            </div>
            <IconButton label={t('drawerClose')} icon={<XIcon size={16} />} onClick={() => setProfileFor(null)} />
          </div>
          <AgentGuardrailsPanel
            rosterId={profileFor.rosterId}
            roleKey={profileFor.roleKey}
            persona={profileFor.persona}
            autonomyLevel={profileFor.autonomyLevel ?? 'auto'}
          />
        </Modal>
      ) : null}
    </section>
  );
}
