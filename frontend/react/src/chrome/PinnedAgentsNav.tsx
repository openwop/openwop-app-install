/**
 * Pinned-agents sub-nav (ADR 0023) — the agents a user pinned from an agent
 * workspace page, rendered as an indented, collapsible sub-menu directly under
 * the "Agents" top-level nav item. Pure per-user UI preference
 * (Profile.pinnedAgentIds); an unresolvable id is silently skipped (the agent
 * was deleted). Re-reads on the `openwop:pinned-agents-changed` event the pin
 * button dispatches.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation } from 'react-router-dom';
import { getMyProfile, setAgentPinned } from '../features/profiles/profilesClient.js';
import { listRoster, type RosterEntry } from '../agents/rosterClient.js';
import { roleThemeForAgent } from '../agents/roleTemplates.js';
import { ChevronDownIcon } from '../ui/icons/index.js';
import { navItemIsActive, type NavItem } from './features.js';

// Per-user, per-device: whether the pinned-agents sub-menu is expanded.
// Open by default (absent key → expanded); only an explicit '0' collapses it.
const EXPAND_KEY = 'openwop.nav.agentsExpanded';

/** Load + live-refresh the caller's pinned agents (resolved against the roster). */
function usePinnedAgents(): RosterEntry[] {
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

  return agents;
}

/**
 * The whole "Agents" nav row: the top-level link, a disclosure toggle (shown
 * only when the user has pinned agents), and the collapsible pinned-agents
 * sub-menu. Replaces the bare NavLink for the `/agents` item so the toggle can
 * live on the same row without disturbing the generic nav loop.
 */
export function AgentsNavItem({ item, badge }: { item: NavItem; badge?: string | null }): JSX.Element {
  const { t } = useTranslation('chrome');
  const { t: tn } = useTranslation('nav');
  const location = useLocation();
  const agents = usePinnedAgents();
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(EXPAND_KEY) !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(EXPAND_KEY, expanded ? '1' : '0'); } catch { /* ignore */ }
  }, [expanded]);

  const Icon = item.icon;
  const active = navItemIsActive(item, location.pathname);
  const hasPinned = agents.length > 0;

  return (
    <li>
      <div className="app-nav-row">
        <NavLink
          to={item.to}
          {...(item.end !== undefined ? { end: item.end } : {})}
          className={`app-nav-link${active ? ' is-active' : ''}`}
          {...(active ? { 'aria-current': 'page' as const } : {})}
          title={item.hintKey ? tn(item.hintKey, { defaultValue: item.hint }) : item.hint}
        >
          <span className="app-nav-icon" aria-hidden><Icon size={16} /></span>
          <span className="app-nav-label">{item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label}</span>
          {badge ? <span className="nav-badge nav-badge--beta">{badge}</span> : null}
        </NavLink>
        {hasPinned ? (
          <button
            type="button"
            className="app-nav-subtoggle"
            aria-expanded={expanded}
            aria-label={expanded ? t('collapsePinnedAgents') : t('expandPinnedAgents')}
            title={expanded ? t('collapsePinnedAgents') : t('expandPinnedAgents')}
            onClick={() => setExpanded((v) => !v)}
          >
            <span className={`app-nav-chevron${expanded ? '' : ' is-collapsed'}`} aria-hidden>
              <ChevronDownIcon size={14} />
            </span>
          </button>
        ) : null}
      </div>
      {hasPinned && expanded ? <PinnedAgentsList agents={agents} /> : null}
    </li>
  );
}

/** The indented list of pinned-agent links. */
function PinnedAgentsList({ agents }: { agents: RosterEntry[] }): JSX.Element {
  const { t } = useTranslation('chrome');
  const location = useLocation();
  return (
    <ul className="app-nav-subitems" aria-label={t('pinnedAgents')}>
      {agents.map((a) => {
        const Icon = roleThemeForAgent(a.agentRef?.agentId, a.workflows, a.roleKey).Icon;
        const to = `/agents/${encodeURIComponent(a.rosterId)}`;
        const active = location.pathname === to || location.pathname.startsWith(`${to}/`);
        return (
          <li key={a.rosterId}>
            <NavLink
              to={to}
              className={`app-nav-link app-nav-subitem${active ? ' is-active' : ''}`}
              {...(active ? { 'aria-current': 'page' as const } : {})}
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
