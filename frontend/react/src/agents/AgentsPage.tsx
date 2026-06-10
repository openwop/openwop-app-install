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
import { EmptyBlock, slugify } from './agentUi.js';
import { Link, useNavigate } from 'react-router-dom';
import { listAgents, type AgentEntry } from '../client/agentsClient.js';
import { PageHeader } from '../ui/PageHeader.js';

interface State {
  agents: readonly AgentEntry[];
  isLoading: boolean;
  error: string | null;
}

export function AgentsPage(): JSX.Element {
  const [state, setState] = useState<State>({ agents: [], isLoading: true, error: null });
  const [query, setQuery] = useState('');
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

  return (
    <section>
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

      <div className="u-mb-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, description, or pack…"
          aria-label="Filter agents"
          className="u-w-full u-pad-2-3 u-fs-13 u-border u-radius u-bg-surface u-text"
        />
      </div>

      {state.isLoading && (
        <EmptyBlock>Loading agents…</EmptyBlock>
      )}
      {state.error && (
        <EmptyBlock tone="error">Couldn't load agents: {state.error}</EmptyBlock>
      )}
      {!state.isLoading && !state.error && state.agents.length === 0 && (
        <EmptyBlock>
          No agent templates installed yet. Use “Install from registry” or
          “+ Author new” above to add one.
        </EmptyBlock>
      )}
      {!state.isLoading && !state.error && state.agents.length > 0 && filtered.length === 0 && (
        <EmptyBlock>No agents match <code>{query}</code>.</EmptyBlock>
      )}

      {filtered.length > 0 && (
        <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-2">
          {filtered.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentEntry }): JSX.Element {
  return (
    <li>
      <Link
        to={`/agents/templates/${encodeURIComponent(agent.agentId)}`}
        className="agentspage-row-link"
      >
        <div className="u-flex u-items-baseline u-gap-3 u-mb-1 u-wrap">
          <strong className="u-fs-14">{agent.label || agent.persona}</strong>
          <code className="muted u-fs-11">@{slugify(agent.persona)}</code>
          <ModelClassChip modelClass={agent.modelClass} />
          {agent.degraded && agent.degraded.length > 0 && (
            <DegradedChip count={agent.degraded.length} />
          )}
        </div>
        {agent.description && (
          <p className="muted agentspage-desc">
            {agent.description}
          </p>
        )}
        <div className="muted u-fs-11 u-flex u-gap-3 u-wrap">
          <span>
            Pack: <code>{agent.packName}@{agent.packVersion}</code>
          </span>
          {agent.toolAllowlist.length > 0 && (
            <span>{agent.toolAllowlist.length} tool{agent.toolAllowlist.length === 1 ? '' : 's'}</span>
          )}
          {agent.hasHandoffSchemas && <span>Handoff schemas declared</span>}
          {agent.confidenceThreshold !== undefined && (
            <span>Confidence ≥ {agent.confidenceThreshold.toFixed(2)}</span>
          )}
        </div>
      </Link>
    </li>
  );
}

function ModelClassChip({ modelClass }: { modelClass: string }): JSX.Element {
  return (
    <span className="agentspage-modelclass-chip">
      {modelClass}
    </span>
  );
}

function DegradedChip({ count }: { count: number }): JSX.Element {
  return (
    <span
      title={`${count} declared capability tier${count === 1 ? '' : 's'} this host does not satisfy — see agent detail.`}
      className="agentspage-degraded-chip"
    >
      degraded ×{count}
    </span>
  );
}

