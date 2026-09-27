/**
 * Agent identity normalization (ADR 0277) — THE owner of the rosterId↔agentId
 * duality.
 *
 * Every roster persona has two projections: a standing ROSTER entry
 * (`rosterId = host:<slug>-…` — owns the `agentProfile`: knowledge bindings,
 * permissions, capabilities, per-agent voice, seeded memories) and a
 * chat-callable REGISTRY agent (`user.<tenant>.<slug>` / pack id — owns the
 * persona `systemPrompt` + manifest `toolAllowlist`), linked by
 * `RosterEntry.agentRef.agentId`. Before this module, every consumer
 * hand-rolled its own mapping (or none): `composeChatContext` resolved persona
 * by the raw id (a rosterId → registry miss → generic scaffold, dropping the
 * persona AND the caller's name), the voice tool bridge looked up manifests by
 * the raw id (a rosterId → empty allowlist), and `voicePreamble` matched both
 * forms for the work snapshot but passed the raw id to the rosterId-keyed
 * profile. Each id form silently lost a different half of the context.
 *
 * Canonical mapping (the ADR 0277 decision):
 *   - persona + manifest tool allowlist  → `agentId` (`agentRef.agentId`)
 *   - profile / knowledge / voice / memory scope → `profileId` (the rosterId
 *     when a roster entry exists — matches the advisor seed, the roster
 *     cascade, and the advisory-board Shared-knowledge bindings)
 *
 * Cost model: the FORWARD path (`host:*` id → point-get `getRosterEntry`) is
 * one keyed read; non-`host:` ids pay only a `startsWith` check on the text
 * hot path. The REVERSE path (agentId → its roster entry) is a tenant-filtered
 * roster scan — callers on per-turn hot paths must not request it (voice
 * session mint is once-per-session, which is why `allowReverseScan` exists as
 * an explicit opt-in rather than a default).
 */
import { getRosterEntry, listRoster, type RosterEntry } from './rosterService.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.agentIdentity');

/** ADR 0277 P2 — per-tenant reverse index (agentRef.agentId → RosterEntry) with a
 *  short TTL, so the per-TEXT-TURN knowledge fold-in doesn't pay a tenant roster
 *  scan per turn. TTL-only (no invalidation hook — rosterService↔here would
 *  cycle); cross-instance safe. A ≤TTL window where a brand-new roster member's
 *  knowledge isn't composed is harmless — the next turn picks it up. */
const REVERSE_TTL_MS = 30_000;
/** Entry cap — a multi-tenant process holds at most this many tenant snapshots;
 *  above it the oldest entry is evicted (expired entries are swept on every
 *  refresh). Without a bound, a long-lived instance serving many tenants would
 *  accumulate one roster snapshot per tenant forever. */
const REVERSE_CACHE_MAX_TENANTS = 200;
const reverseCache = new Map<string, { at: number; byAgentId: Map<string, RosterEntry> }>();

function pruneReverseCache(now: number): void {
  for (const [k, v] of reverseCache) if (now - v.at >= REVERSE_TTL_MS) reverseCache.delete(k);
  while (reverseCache.size >= REVERSE_CACHE_MAX_TENANTS) {
    const oldest = reverseCache.keys().next().value; // Map preserves insertion order
    if (oldest === undefined) break;
    reverseCache.delete(oldest);
  }
}

async function reverseLookup(tenantId: string, agentId: string): Promise<RosterEntry | null> {
  const cached = reverseCache.get(tenantId);
  if (cached && Date.now() - cached.at < REVERSE_TTL_MS) {
    return cached.byAgentId.get(agentId) ?? null;
  }
  try {
    const roster = await listRoster(tenantId);
    const byAgentId = new Map<string, RosterEntry>();
    // First projection wins on a (rare) duplicate agentRef — deterministic
    // (listRoster sorts by createdAt), matching the pre-cache find() semantics.
    // GRADE-17 — cache a SLIM entry: `avatarUrl` is an inline base64 thumbnail
    // (~20-150KB per member) that no identity consumer needs (the preamble's
    // work snapshot reads `workflows`/`rosterId` only); caching it pinned
    // ~0.2-1.5MB per tenant.
    for (const e of roster) {
      if (byAgentId.has(e.agentRef.agentId)) continue;
      const { avatarUrl: _avatar, ...slim } = e;
      byAgentId.set(e.agentRef.agentId, slim);
    }
    const now = Date.now();
    pruneReverseCache(now);
    reverseCache.set(tenantId, { at: now, byAgentId });
    return byAgentId.get(agentId) ?? null;
  } catch (err) {
    // CS-XC-4 — this swallow was SILENT: a persistent roster-store fault made
    // every reverse identity degrade invisibly (personas/tools quietly missing).
    // Keep the fail-soft null, but make the fault visible in ops.
    log.warn('agent_identity_reverse_lookup_failed', { tenantId, agentId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * ADR 0665 D5 — display names for a set of registry-form agent ids.
 *
 * The cross-agent narrative cast (`[Persona]: …` in `turnsToMessages`) promised
 * names and emitted raw slugs. `turnsToMessages` is pure and has no registry or
 * roster access, so resolution belongs here — the module that already owns the
 * rosterId↔agentId duality — and the map is passed in.
 *
 * Cost: the roster half rides the SAME per-tenant reverse index the per-turn
 * knowledge fold-in already warms (`composeChatContext` calls `resolveAgentIdentity`
 * with `allowReverseScan` on every turn), so a council turn pays cache hits, not a
 * scan per advisor. The registry half is an in-process point lookup. Callers should
 * pass only the ids they will actually render — a 1:1 chat has none, and pays
 * nothing.
 *
 * Fail-soft: an id that resolves to neither is simply ABSENT from the map, so the
 * caller falls back to the slug. It never returns a blank name.
 */
export async function resolvePersonaNames(
  tenantId: string,
  agentIds: Iterable<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(agentIds)).filter((id) => id.length > 0);
  if (ids.length === 0) return out;
  await Promise.all(ids.map(async (id) => {
    const entry = await reverseLookup(tenantId, id);
    const fromRoster = entry?.persona?.trim();
    if (fromRoster) { out.set(id, fromRoster); return; }
    // A pack/definition agent with no roster row still has a manifest persona.
    const manifest = getAgentRegistry().get(id, tenantId);
    const fromManifest = manifest?.persona?.trim();
    if (fromManifest) out.set(id, fromManifest);
  }));
  return out;
}

/** Test seam — drop the reverse cache (e.g. after creating roster entries). */
export function __clearAgentIdentityCache(): void {
  reverseCache.clear();
}

export interface AgentIdentity {
  /** The registry/persona id (`agentRef.agentId` for roster entries; the input
   *  id when no roster entry is involved). Resolves the manifest + systemPrompt. */
  agentId: string;
  /** The standing roster entry id, when one backs this identity. */
  rosterId?: string;
  /** The id that keys `agentProfile` (knowledge/permissions/voice/memory):
   *  the rosterId when present, else the input id (definition-level profiles). */
  profileId: string;
  /** The resolved roster entry, when found (saves a re-read for callers that
   *  need the portfolio/persona label). */
  entry?: RosterEntry;
}

/**
 * Resolve either id form to the full identity. Fail-soft: an unknown id (no
 * roster entry, not `host:`-prefixed) normalizes to itself — persona/profile
 * lookups then behave exactly as they did pre-normalization.
 *
 * `opts.allowReverseScan` opts into the tenant roster scan for the reverse
 * direction (agentId → roster entry). Leave it off on per-turn hot paths.
 */
export async function resolveAgentIdentity(
  tenantId: string,
  id: string,
  opts?: { allowReverseScan?: boolean },
): Promise<AgentIdentity> {
  // Forward: a host:* id IS a rosterId — one point-get.
  if (id.startsWith('host:')) {
    const entry = await getRosterEntry(tenantId, id).catch(() => null);
    if (entry) {
      return { agentId: entry.agentRef.agentId, rosterId: entry.rosterId, profileId: entry.rosterId, entry };
    }
    // A host:* id with no roster row (deleted member): keep it as both — the
    // profile may still exist and the registry miss is unavoidable either way.
    return { agentId: id, profileId: id };
  }
  // Reverse: find the roster entry that instantiates this registry agent.
  // TTL-cached per tenant (ADR 0277 P2) so per-turn callers stay cheap; still
  // behind the explicit opt-in so id-only normalizations pay nothing.
  if (opts?.allowReverseScan) {
    const entry = await reverseLookup(tenantId, id);
    if (entry) return { agentId: id, rosterId: entry.rosterId, profileId: entry.rosterId, entry };
  }
  return { agentId: id, profileId: id };
}
