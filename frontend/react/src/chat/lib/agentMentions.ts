/**
 * Agent @-mention catalog for the chat input.
 *
 * Source: the host's `GET /v1/agents` inventory (RFC 0072 §A,
 * advertised via `capabilities.agents.manifestRuntime`). Pack-installed
 * agents land here automatically; user-authored agents land here once
 * Phase E1's `POST /v1/host/openwop-app/agents` endpoint merges them into
 * the same registry.
 *
 * Slug derivation is from `persona` (the human-named handle —
 * "Code Reviewer" → `code-reviewer`) NOT from `agentId` (the
 * fully-qualified pack-scoped id like
 * `core.openwop.agents.code-reviewer.default`). The persona slug is
 * what the user types after `@`; the agentId is what's resolved
 * server-side for dispatch.
 *
 * Two agents with the same persona slug (e.g. two `code-reviewer`s
 * from different packs) deduplicate via `-2`, `-3`, … suffixes in
 * inventory order, matching the workflow-mention collision policy.
 *
 * Cache: `useAgentMentions()` lives next to this lib in a hook —
 * `listAgents()` is async, so the picker can't pull it synchronously
 * the way `listWorkflowMentions()` reads localStorage. The fetch is
 * cached at the React-state level and refreshed on chat-mount; new
 * agents installed mid-session show up on the next chat reload.
 */

import { useEffect, useState } from 'react';
import i18n from '../../i18n/index.js';
import { listAgents, type AgentEntry } from '../../client/agentsClient.js';

export interface AgentMentionEntry {
  /** Persona name as shown in the popover row ("Code Reviewer"). */
  displayName: string;
  /** The human persona name ("Nora") — the welcome pills label by this,
   *  not the role title. */
  persona: string;
  /** Whitespace-free token inserted after `@`. Stable for the same
   *  agentId across renders. */
  slug: string;
  /** One-line description shown under the name in the popover. */
  description: string;
  /** Fully-qualified agent id resolved server-side. The chat
   *  dispatcher passes this in `inputs.agentId` when activating the
   *  agent (phases D2/D3). */
  agentId: string;
  /** Source pack name + version, surfaced as a small label in the
   *  picker row so users can tell two same-persona agents apart. */
  packName: string;
  packVersion: string;
  /** Model class the agent declares ("chat" / "reasoning" /
   *  "coding" / "extraction"). Shown as a chip in the picker. */
  modelClass: string;
}

/** Project an SDK inventory entry → a picker-row shape. Pure function
 *  so tests can exercise slug collision policy without React. */
export function projectAgentEntry(
  agent: AgentEntry,
  usedSlugs: Set<string>,
): AgentMentionEntry {
  const baseSlug = slugify(agent.persona) || 'agent';
  let slug = baseSlug;
  let n = 2;
  while (usedSlugs.has(slug)) {
    slug = `${baseSlug}-${n++}`;
  }
  usedSlugs.add(slug);
  return {
    displayName: agent.label || agent.persona,
    persona: agent.persona,
    slug,
    description: agent.description ?? i18n.t('chat:agentFallbackDescription', { modelClass: agent.modelClass, packName: agent.packName }),
    agentId: agent.agentId,
    packName: agent.packName,
    packVersion: agent.packVersion,
    modelClass: agent.modelClass,
  };
}

/** Content signature for collapsing IDENTICAL agents in the picker. Two
 *  inventory rows that match on persona + label + description + modelClass are
 *  the same agent to a user — e.g. a chat agent (`user.<tenant>.<slug>`) and its
 *  standing-roster twin (`host:<slug>-…`), or duplicate seeded roster rows. They
 *  must NOT each get a `@devon-2`/`-3` row. Genuinely different same-persona
 *  agents (a second `code-reviewer` from another pack, with its own description)
 *  differ in the signature, so they keep their distinct rows + suffix. */
function agentSignature(a: AgentEntry): string {
  return [
    a.persona.toLowerCase(),
    (a.label ?? '').toLowerCase(),
    (a.description ?? '').toLowerCase(),
    a.modelClass,
  ].join('|');
}

/** Project an array of inventory entries with dedup + collision resolution.
 *  Exact-duplicate agents (same {@link agentSignature}) collapse to ONE row,
 *  preferring the canonical chat agent (`user.<tenant>.<slug>`) as the kept
 *  dispatch identity so `@devon` resolves to the chat agent, not a roster twin. */
export function projectAgents(agents: readonly AgentEntry[]): AgentMentionEntry[] {
  const bySig = new Map<string, AgentEntry>();
  for (const a of agents) {
    const sig = agentSignature(a);
    const kept = bySig.get(sig);
    if (!kept) {
      bySig.set(sig, a);
    } else if (!kept.agentId.startsWith('user.') && a.agentId.startsWith('user.')) {
      // Prefer a `user.` chat agent over a host:/pack twin for the kept identity.
      bySig.set(sig, a);
    }
  }
  const usedSlugs = new Set<string>();
  return [...bySig.values()].map((a) => projectAgentEntry(a, usedSlugs));
}

/** React hook: fetch agents on mount, expose `{ entries, isLoading,
 *  error }`. Cached at the hook-instance level — every consumer
 *  refetches on mount, which is the right behavior for a picker
 *  (newly-installed agents show up immediately on chat reload). For
 *  a session-scoped cache, hoist the fetch into a higher provider in
 *  a follow-up.
 *
 *  Returns `entries: []` while loading so callers can skip the
 *  `isLoading` branch when they're fine showing an empty picker
 *  briefly — common case for `@`-typed-then-paused. */
export function useAgentMentions(): {
  entries: readonly AgentMentionEntry[];
  isLoading: boolean;
  error: string | null;
} {
  const [entries, setEntries] = useState<readonly AgentMentionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const agents = await listAgents();
        if (cancelled) return;
        setEntries(projectAgents(agents));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { entries, isLoading, error };
}

/** Case-insensitive substring filter — same shape as
 *  `filterMentions()` for workflows so the autocomplete code stays
 *  parallel between the two surfaces. */
export function filterAgentMentions(
  entries: readonly AgentMentionEntry[],
  query: string,
): AgentMentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) =>
    e.displayName.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q),
  );
}

/** Capture-the-cursor agent-mention detector — symmetric to
 *  `detectMention` in workflowMentions.ts but resolves against the
 *  agent catalog. Used by the submit path (phase D3) to recognize
 *  `@code-reviewer review this` as an agent activation.
 *
 *  Async because the agent catalog itself is async; if the catalog
 *  hasn't fetched yet, returns `null` (caller falls through to
 *  normal send, which is the right behavior — race-on-first-message
 *  is rare and the user can retry). */
export interface AgentMentionMatch {
  entry: AgentMentionEntry;
  /** Text after the `@<slug>` token. */
  trailing: string | null;
}

export function detectAgentMention(
  text: string,
  entries: readonly AgentMentionEntry[],
): AgentMentionMatch | null {
  // Scan every `@<slug>` token — not only a start-anchored one — and route to
  // the FIRST that resolves to a known agent. Entry-gated, so a non-agent token
  // ("@here", an email's "@", a bare "@5pm") never routes. This lets a user
  // write "review this @nora" mid-message, not only "@nora review this".
  const re = /@([a-z0-9][a-z0-9-]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const slug = (match[1] ?? '').toLowerCase();
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) continue;
    const trailingRaw = text.slice(match.index + match[0].length).trim();
    return { entry, trailing: trailingRaw.length > 0 ? trailingRaw : null };
  }
  return null;
}

/** A `@@<board-handle>` summon (Board of Advisors, ADR 0040). Distinct from a
 *  single `@<agent>` mention — `@@` convenes a whole board: the caller resolves
 *  the handle to its cohort and activates every advisor into the active-agents
 *  lineup. Detected BEFORE `detectAgentMention` so `@@timeless` isn't mistaken for
 *  a single `@timeless` agent. */
export interface BoardMentionMatch {
  handle: string;
  /** Text after the `@@<handle>` token (the actual question), or null. */
  trailing: string | null;
}

export function detectBoardMention(text: string): BoardMentionMatch | null {
  const m = /@@([a-z0-9][a-z0-9-]*)/i.exec(text);
  if (!m) return null;
  const handle = (m[1] ?? '').toLowerCase();
  const trailingRaw = text.slice(m.index + m[0].length).trim();
  return { handle, trailing: trailingRaw.length > 0 ? trailingRaw : null };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Humanize a handle slug into a display name: `andru-carnagie` → `Andru
 *  Carnagie`. The inverse of `slugify` for attribution labels + rail rows where
 *  only the slug is in scope; also accepts a trailing agentId segment
 *  (`…advisor-leo-da-vincio` → `Leo Da Vincio`). Title-cases each word. */
export function slugToName(slug: string): string {
  const tail = slug.includes('advisor-') ? slug.slice(slug.lastIndexOf('advisor-') + 'advisor-'.length) : slug;
  const words = tail.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return slug;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
