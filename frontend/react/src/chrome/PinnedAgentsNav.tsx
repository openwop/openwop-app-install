/**
 * Pinned-agents sub-nav (ADR 0023) — the agents a user pinned from an agent
 * workspace page, rendered as an indented sub-menu directly under the "Agents"
 * top-level nav item. Pure per-user UI preference (Profile.pinnedAgentIds);
 * an unresolvable id is silently skipped (the agent was deleted). Re-reads on
 * the `openwop:pinned-agents-changed` event the pin button dispatches.
 */
import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { getMyProfile, setAgentPinned } from '../features/profiles/profilesClient.js';
import { listRoster, type RosterEntry } from '../agents/rosterClient.js';
import { roleThemeForAgent } from '../agents/roleTemplates.js';

export function PinnedAgentsNav(): JSX.Element | null {
  const [agents, setAgents] = useState<RosterEntry[]>([]);

  const load = useCallback(() => {
    void Promise.all([
      getMyProfile().catch(() => null),
      // Track whether the roster ACTUALLY loaded — a transient failure must not
      // be read as "every agent was deleted" (which would unpin everything).
      listRoster().then((r) => ({ ok: true, roster: r })).catch(() => ({ ok: false, roster: [] as RosterEntry[] })),
    ])
      .then(([profile, { ok, roster }]) => {
        const ids = profile?.pinnedAgentIds ?? [];
        if (ids.length === 0) { setAgents([]); return; }
        const byId = new Map(roster.map((r) => [r.rosterId, r]));
        // Display: preserve pin order; skip ids that no longer resolve.
        setAgents(ids.map((id) => byId.get(id)).filter((r): r is RosterEntry => r !== undefined));
        // Self-heal: when the roster loaded cleanly and a pinned id no longer
        // resolves (its agent was deleted), PERSIST the unpin so the dead pin
        // doesn't linger in the profile (best-effort; a failure just leaves it
        // for the next load to retry). Guarded on `ok` so a transient roster
        // failure never unpins everything.
        if (ok) {
          const dead = ids.filter((id) => !byId.has(id));
          if (dead.length > 0) void Promise.allSettled(dead.map((id) => setAgentPinned(id, false)));
        }
      })
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    load();
    const onChange = (): void => load();
    window.addEventListener('openwop:pinned-agents-changed', onChange);
    return () => window.removeEventListener('openwop:pinned-agents-changed', onChange);
  }, [load]);

  if (agents.length === 0) return null;

  return (
    <ul className="app-nav-subitems" aria-label="Pinned agents">
      {agents.map((a) => {
        const Icon = roleThemeForAgent(a.agentRef?.agentId, a.workflows, a.roleKey).Icon;
        return (
          <li key={a.rosterId}>
            <NavLink
              to={`/agents/${encodeURIComponent(a.rosterId)}`}
              className={({ isActive }) => `app-nav-link app-nav-subitem${isActive ? ' is-active' : ''}`}
              title={`${a.persona}${a.label ? ` — ${a.label}` : ''}`}
            >
              <span className="app-nav-icon" aria-hidden><Icon size={14} /></span>
              <span className="app-nav-label">{a.persona}</span>
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}
