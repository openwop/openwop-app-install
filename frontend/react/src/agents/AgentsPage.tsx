/**
 * Agent Templates — the installed manifest-agent LIBRARY (System A).
 *
 * Sources from `GET /v1/agents` (RFC 0072 §A normative read-only inventory):
 * every installed manifest agent the host knows about, with its source pack +
 * version per row so two same-persona templates are distinguishable. These are
 * reusable *templates* — a named "AI coworker" (the roster, /agents) instantiates
 * one via `agentRef.agentId`. Row affordances: View → detail, Author new →
 * `/agents/new`, Install from registry → `/agents/install`, per-row Fork.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { slugify } from './agentUi.js';
import { Link, useNavigate } from 'react-router-dom';
import { listAgents, type AgentEntry } from '../client/agentsClient.js';
import { listRoster } from './rosterClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { AgentTemplateCard, TemplateSignals } from './AgentTemplateViews.js';
import { StateCard } from '../ui/StateCard.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { TextField } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PackageIcon, SearchIcon } from '../ui/icons/index.js';

interface State {
  agents: readonly AgentEntry[];
  isLoading: boolean;
  error: string | null;
  /** The advisor filter could not be read, so the list may include agents that
   *  are NOT reusable templates. Distinct from "there are no advisors". */
  filterUnavailable: boolean;
}

export function AgentsPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const [state, setState] = useState<State>({ agents: [], isLoading: true, error: null, filterUnavailable: false });
  const [query, setQuery] = useState('');
  const [view, setView] = useViewMode('agent-templates', 'list');
  const navigate = useNavigate();

  /** Shared by the mount effect and the Retry button. It used to live inline in
   *  a `[]`-dep effect while Retry only set `isLoading: true` — so Retry cleared
   *  the error, showed the loading card, and NOTHING EVER REFETCHED. The page
   *  then claimed to be loading forever, which is the exact failure-as-loading
   *  state the error card existed to avoid. A retry that cannot retry is worse
   *  than no retry: it converts a stated failure back into a false claim. */
  const load = useCallback(async (isCancelled: () => boolean = () => false): Promise<void> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        // Advisor-subject agents (ADR 0040) are backed by user-agents, so they
        // surface in the `/v1/agents` inventory (and stay @-mentionable in chat) —
        // but they live ONLY in the Board of Advisors feature and MUST NOT appear
        // as reusable templates here. Cross-reference the roster (the single
        // source of the `roleKey:'advisor'` marker) and drop their backing agents.
        // Best-effort: a roster failure must not blank the templates list.
        let filterUnavailable = false;
        const [agents, advisorRoster] = await Promise.all([
          listAgents(),
          listRoster({ includeAdvisors: true })
            .then((r) => r.filter((e) => e.roleKey === 'advisor'))
            // `[]` here means "no advisors exist" AND "we could not check" — the
            // same value for two different facts. Blanking the whole library over
            // it would be worse, so the degrade stays; what was missing is SAYING
            // so. Undisclosed, the page presents advisor-backed agents as
            // installable templates and counts them in "N templates".
            .catch(() => { filterUnavailable = true; return []; }),
        ]);
        if (isCancelled()) return;
        const advisorAgentIds = new Set(advisorRoster.map((e) => e.agentRef.agentId));
        const visible = agents.filter((a) => !advisorAgentIds.has(a.agentId));
        setState({ agents: visible, isLoading: false, error: null, filterUnavailable });
      } catch (err) {
        if (isCancelled()) return;
        setState({
          agents: [],
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
          filterUnavailable: false,
        });
      }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => { cancelled = true; };
  }, [load]);

  const filtered = state.agents.filter((a) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      a.persona.toLowerCase().includes(q) ||
      a.label.toLowerCase().includes(q) ||
      (a.description?.toLowerCase().includes(q) ?? false) ||
      a.packName.toLowerCase().includes(q)
    );
  });

  const columns: DataColumn<AgentEntry>[] = [
    {
      key: 'template',
      header: t('templatesColTemplate'),
      width: '2fr',
      sortValue: (a) => (a.label || a.persona).toLowerCase(),
      render: (a) => (
        <div className="u-flex u-flex-col u-gap-1">
          <div className="u-flex u-items-baseline u-gap-3 u-wrap">
            <strong className="u-fs-14">{a.label || a.persona}</strong>
            <code className="muted u-fs-11">@{slugify(a.persona)}</code>
          </div>
          {a.description ? <span className="muted u-fs-12">{a.description}</span> : null}
        </div>
      ),
    },
    {
      key: 'modelClass',
      header: t('templatesColModelClass'),
      sortValue: (a) => a.modelClass,
      render: (a) => <span className="chip chip--muted">{a.modelClass}</span>,
    },
    {
      key: 'pack',
      header: t('templatesColPack'),
      cellClassName: 'muted',
      sortValue: (a) => `${a.packName}@${a.packVersion}`,
      render: (a) => <code className="u-fs-11">{a.packName}@{a.packVersion}</code>,
    },
    {
      key: 'tools',
      header: t('templatesColTools'),
      align: 'right',
      cellClassName: 'muted',
      sortValue: (a) => a.toolAllowlist.length,
      render: (a) => (a.toolAllowlist.length > 0 ? String(a.toolAllowlist.length) : '—'),
    },
    {
      key: 'signals',
      header: t('templatesColSignals'),
      render: (a) => <TemplateSignals agent={a} />,
    },
  ];

  return (
    <section data-walkthrough="agent-templates.page" className="page-stack">
      <PageHeader
        eyebrow={t('templatesEyebrow')}
        title={t('templatesTitle')}
        lede={<Trans t={t} i18nKey="templatesLede" components={{ 0: <Link to="/agents" />, 1: <code /> }} />}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/agents/install')}>
              {t('templatesInstallFromRegistry')}
            </Button>
            <Button variant="primary" onClick={() => navigate('/agents/new')}>
              {t('templatesAuthorNew')}
            </Button>
          </>
        }
      />

      {/* Warn, don't block: the library itself loaded, but one of its filters
          did not, so a row here may not actually be a reusable template. */}
      {state.filterUnavailable ? (
        <Notice variant="warning" announce={t('templatesAdvisorFilterUnavailable')}>{t('templatesAdvisorFilterUnavailable')}</Notice>
      ) : null}

      {state.error ? (
        <StateCard announce
          icon={<PackageIcon size={26} />}
          title={t('templatesLoadErrorTitle')}
          body={state.error}
          action={
            <Button
              variant="secondary"
              onClick={() => { void load(); }}
            >
              {t('templatesRetry')}
            </Button>
          }
        />
      ) : state.isLoading ? (
        <div aria-busy="true">
          <StateCard loading title={t('templatesLoading')} />
          <SkeletonRows rows={4} columns={['2fr', '88px', '140px', '40px', '120px']} />
        </div>
      ) : state.agents.length === 0 ? (
        <StateCard
          icon={<PackageIcon size={26} />}
          title={t('templatesEmptyTitle')}
          body={t('templatesEmptyBody')}
          action={
            <>
              <Button variant="secondary" onClick={() => navigate('/agents/install')}>
                {t('templatesInstallFromRegistry')}
              </Button>
              <Button variant="primary" onClick={() => navigate('/agents/new')}>
                {t('templatesAuthorNew')}
              </Button>
            </>
          }
        />
      ) : (
        <>
          <div className="filterbar" role="group" aria-label={t('templatesFilterGroup')}>
            <TextField
              label={t('templatesFilterLabel')}
              className="filterbar-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('templatesFilterPlaceholder')}
            />
            <span className="muted u-fs-12">
              {t('templatesCountLabel', { count: state.agents.length, filtered: filtered.length, total: state.agents.length })}
            </span>
            <ViewToggle value={view} onChange={setView} className="u-ml-auto" />
          </div>

          {filtered.length === 0 ? (
            <Notice variant="info">
              <span className="u-flex u-gap-2 u-items-center">
                <SearchIcon size={15} aria-hidden />
                <Trans t={t} i18nKey="templatesNoMatchQuery" values={{ query }} components={{ 0: <code /> }} />
              </span>
            </Notice>
          ) : view === 'grid' ? (
            <div className="card-grid">
              {filtered.map((a) => (
                <AgentTemplateCard key={a.agentId} agent={a} />
              ))}
            </div>
          ) : (
            <DataTable<AgentEntry>
              columns={columns}
              rows={[...filtered]}
              rowKey={(a) => a.agentId}
              caption={t('templatesCaption')}
              initialSort={{ key: 'template', dir: 'asc' }}
              onRowClick={(a) => navigate(`/agents/templates/${encodeURIComponent(a.agentId)}`)}
            />
          )}
        </>
      )}
    </section>
  );
}
