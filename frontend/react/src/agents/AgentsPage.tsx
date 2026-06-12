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
import { slugify } from './agentUi.js';
import { Link, useNavigate } from 'react-router-dom';
import { listAgents, type AgentEntry } from '../client/agentsClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { DataTable, DensityToggle, type DataColumn } from '../ui/DataTable.js';
import { StateCard } from '../ui/StateCard.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { TextField } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PackageIcon, SearchIcon } from '../ui/icons/index.js';

interface State {
  agents: readonly AgentEntry[];
  isLoading: boolean;
  error: string | null;
}

export function AgentsPage(): JSX.Element {
  const [state, setState] = useState<State>({ agents: [], isLoading: true, error: null });
  const [query, setQuery] = useState('');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const agents = await listAgents();
        if (cancelled) return;
        setState({ agents, isLoading: false, error: null });
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
      header: 'Template',
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
      header: 'Model class',
      sortValue: (a) => a.modelClass,
      render: (a) => <span className="chip chip--muted">{a.modelClass}</span>,
    },
    {
      key: 'pack',
      header: 'Pack',
      cellClassName: 'muted',
      sortValue: (a) => `${a.packName}@${a.packVersion}`,
      render: (a) => <code className="u-fs-11">{a.packName}@{a.packVersion}</code>,
    },
    {
      key: 'tools',
      header: 'Tools',
      align: 'right',
      cellClassName: 'muted',
      sortValue: (a) => a.toolAllowlist.length,
      render: (a) => (a.toolAllowlist.length > 0 ? String(a.toolAllowlist.length) : '—'),
    },
    {
      key: 'signals',
      header: 'Signals',
      render: (a) => (
        <div className="u-flex u-gap-2 u-wrap u-items-center">
          {a.degraded && a.degraded.length > 0 ? (
            <span
              className="chip chip--warning"
              title={`${a.degraded.length} declared capability tier${a.degraded.length === 1 ? '' : 's'} this host does not satisfy — see agent detail.`}
            >
              degraded ×{a.degraded.length}
            </span>
          ) : null}
          {a.hasHandoffSchemas ? <span className="chip chip--muted">handoff</span> : null}
          {a.confidenceThreshold !== undefined ? (
            <span className="chip chip--muted">conf ≥ {a.confidenceThreshold.toFixed(2)}</span>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Agents"
        title="Agent templates"
        lede={<>Reusable persona-driven LLM workers. A named coworker on the <Link to="/agents">Agents</Link> page instantiates a template; mention one in chat with <code>@</code> to add it to your active-agents lineup.</>}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => navigate('/agents/install')}>
              Install from registry
            </button>
            <button type="button" className="primary" onClick={() => navigate('/agents/new')}>
              + Author new
            </button>
          </>
        }
      />

      {state.error ? (
        <StateCard
          icon={<PackageIcon size={26} />}
          title="Couldn’t load agent templates"
          body={state.error}
          action={
            <button
              type="button"
              className="secondary"
              onClick={() => setState({ agents: [], isLoading: true, error: null })}
            >
              Retry
            </button>
          }
        />
      ) : state.isLoading ? (
        <div aria-busy="true">
          <StateCard loading title="Loading agent templates…" />
          <SkeletonRows rows={4} columns={['2fr', '88px', '140px', '40px', '120px']} />
        </div>
      ) : state.agents.length === 0 ? (
        <StateCard
          icon={<PackageIcon size={26} />}
          title="No agent templates installed yet"
          body="Install a template from the registry, or author one from scratch, to start building reusable AI coworkers."
          action={
            <>
              <button type="button" className="secondary" onClick={() => navigate('/agents/install')}>
                Install from registry
              </button>
              <button type="button" className="primary" onClick={() => navigate('/agents/new')}>
                + Author new
              </button>
            </>
          }
        />
      ) : (
        <>
          <div className="filterbar" role="group" aria-label="Filter agent templates">
            <TextField
              label="Filter templates"
              className="filterbar-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, description, or pack…"
            />
            <span className="muted u-fs-12">
              {filtered.length} of {state.agents.length} template{state.agents.length === 1 ? '' : 's'}
            </span>
            <DensityToggle value={density} onChange={setDensity} />
          </div>

          <DataTable<AgentEntry>
            columns={columns}
            rows={[...filtered]}
            rowKey={(a) => a.agentId}
            density={density}
            caption="Installed agent templates"
            initialSort={{ key: 'template', dir: 'asc' }}
            onRowClick={(a) => navigate(`/agents/templates/${encodeURIComponent(a.agentId)}`)}
            empty={
              <Notice variant="info">
                <span className="u-flex u-gap-2 u-items-center">
                  <SearchIcon size={15} aria-hidden />
                  No agents match <code>{query}</code>.
                </span>
              </Notice>
            }
          />
        </>
      )}
    </section>
  );
}
