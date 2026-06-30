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

import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { slugify } from './agentUi.js';
import { Link, useNavigate } from 'react-router-dom';
import { listAgents, type AgentEntry } from '../client/agentsClient.js';
import { listRoster } from './rosterClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { DataTable, DensityToggle, type DataColumn } from '../ui/DataTable.js';
import { StateCard } from '../ui/StateCard.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { TextField } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PackageIcon, SearchIcon } from '../ui/icons/index.js';
import { formatNumber } from '../i18n/format.js';

interface State {
  agents: readonly AgentEntry[];
  isLoading: boolean;
  error: string | null;
}

export function AgentsPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const [state, setState] = useState<State>({ agents: [], isLoading: true, error: null });
  const [query, setQuery] = useState('');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Advisor-subject agents (ADR 0040) are backed by user-agents, so they
        // surface in the `/v1/agents` inventory (and stay @-mentionable in chat) —
        // but they live ONLY in the Board of Advisors feature and MUST NOT appear
        // as reusable templates here. Cross-reference the roster (the single
        // source of the `roleKey:'advisor'` marker) and drop their backing agents.
        // Best-effort: a roster failure must not blank the templates list.
        const [agents, advisorRoster] = await Promise.all([
          listAgents(),
          listRoster({ includeAdvisors: true })
            .then((r) => r.filter((e) => e.roleKey === 'advisor'))
            .catch(() => []),
        ]);
        if (cancelled) return;
        const advisorAgentIds = new Set(advisorRoster.map((e) => e.agentRef.agentId));
        const visible = agents.filter((a) => !advisorAgentIds.has(a.agentId));
        setState({ agents: visible, isLoading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          agents: [],
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
      render: (a) => (
        <div className="u-flex u-gap-2 u-wrap u-items-center">
          {a.degraded && a.degraded.length > 0 ? (
            <span
              className="chip chip--warning"
              title={t('templatesDegradedTitle', { count: a.degraded.length })}
            >
              {t('templatesDegraded', { count: a.degraded.length })}
            </span>
          ) : null}
          {a.hasHandoffSchemas ? <span className="chip chip--muted">{t('templatesHandoff')}</span> : null}
          {a.confidenceThreshold !== undefined ? (
            <span className="chip chip--muted">{t('templatesConfidence', { value: formatNumber(a.confidenceThreshold, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</span>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow={t('templatesEyebrow')}
        title={t('templatesTitle')}
        lede={<Trans t={t} i18nKey="templatesLede" components={{ 0: <Link to="/agents" />, 1: <code /> }} />}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => navigate('/agents/install')}>
              {t('templatesInstallFromRegistry')}
            </button>
            <button type="button" className="primary" onClick={() => navigate('/agents/new')}>
              {t('templatesAuthorNew')}
            </button>
          </>
        }
      />

      {state.error ? (
        <StateCard
          icon={<PackageIcon size={26} />}
          title={t('templatesLoadErrorTitle')}
          body={state.error}
          action={
            <button
              type="button"
              className="secondary"
              onClick={() => setState({ agents: [], isLoading: true, error: null })}
            >
              {t('templatesRetry')}
            </button>
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
              <button type="button" className="secondary" onClick={() => navigate('/agents/install')}>
                {t('templatesInstallFromRegistry')}
              </button>
              <button type="button" className="primary" onClick={() => navigate('/agents/new')}>
                {t('templatesAuthorNew')}
              </button>
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
            <DensityToggle value={density} onChange={setDensity} />
          </div>

          <DataTable<AgentEntry>
            columns={columns}
            rows={[...filtered]}
            rowKey={(a) => a.agentId}
            density={density}
            caption={t('templatesCaption')}
            initialSort={{ key: 'template', dir: 'asc' }}
            onRowClick={(a) => navigate(`/agents/templates/${encodeURIComponent(a.agentId)}`)}
            empty={
              <Notice variant="info">
                <span className="u-flex u-gap-2 u-items-center">
                  <SearchIcon size={15} aria-hidden />
                  <Trans t={t} i18nKey="templatesNoMatchQuery" values={{ query }} components={{ 0: <code /> }} />
                </span>
              </Notice>
            }
          />
        </>
      )}
    </section>
  );
}
