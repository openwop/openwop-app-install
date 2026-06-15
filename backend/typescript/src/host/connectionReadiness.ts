/**
 * Connection readiness — the `requiredConnections` → activation gate (ADR 0033
 * §3.3 / T3.3).
 *
 * ADR 0033 records the day-1 honesty contract for the enterprise work-twins:
 * a twin may only ACT autonomously on an external integration once a Connection
 * for it is configured; otherwise it "stays at draft/recommend" and the
 * dependent surface advertises `supported: false`. This module is the single
 * place that resolves that state, so both the autonomous-execution seam
 * (`host/heartbeatService.ts` pick) and the advertisement seam (the
 * `GET .../agents/:id/connection-readiness` route in `routes/agentProfile.ts`)
 * read the SAME answer — never two drifting copies (ARCHITECTURE.md "advertise
 * only honored behavior").
 *
 * It owns no store: `requiredConnections` lives on the agent's `agentProfile`
 * (ADR 0031) and the connection records live in the Connections broker (ADR
 * 0024). This is pure resolution over those two existing owners.
 *
 * @see docs/adr/0033-work-twin-connector-reachability.md  §3.3 + the #221 correction
 * @see src/host/agentProfileService.ts
 * @see src/features/connections/connectionsService.ts
 */

import { getAgentProfile } from './agentProfileService.js';
import { listConnections, type ConnectionStatus } from '../features/connections/connectionsService.js';

/** Per-provider readiness for one `requiredConnections` entry. */
export interface ConnectionReadinessEntry {
  /** The provider id from `agentProfile.requiredConnections` (a
   *  `ProviderManifest.id` or a connection-pack `provider.id`). */
  provider: string;
  /** True only when an ACTIVE Connection for this provider resolves for the
   *  acting principal — fail-closed: any other status (or none) is NOT ready. */
  configured: boolean;
  /** The resolved connection status, when a (possibly non-active) Connection
   *  exists — surfaced so the UI can distinguish "missing" from
   *  "needs-reconsent"/"expired". Absent ⇒ no Connection at all. */
  status?: ConnectionStatus;
}

/** The resolved readiness of an agent's required connections. */
export interface ConnectionReadiness {
  /** The `requiredConnections` declared on the profile (empty when none). */
  required: string[];
  /** One entry per required provider, in declared order. */
  entries: ConnectionReadinessEntry[];
  /** True when every required provider is configured — OR when nothing is
   *  required. This is the activation gate: false ⇒ hold at draft/recommend. */
  allConfigured: boolean;
  /** The missing/un-ready provider ids (subset of `required`). */
  missing: string[];
}

/** A profile-less or requirement-less agent is trivially ready. */
const READY_EMPTY: ConnectionReadiness = { required: [], entries: [], allConfigured: true, missing: [] };

/**
 * Resolve an agent's connection readiness. `profileId` is the owning agent's
 * `rosterId` (the same key `agentProfileService` uses). `actingUserId` scopes
 * the connection lookup to the principal who would act (org/workspace
 * connections are visible to all members; a user connection only to its owner)
 * — mirroring the broker's own resolution axis (ADR 0024).
 *
 * Fail-closed throughout: an unknown/foreign profile, an absent profile, or no
 * `requiredConnections` resolves to "ready with nothing required" (the agent is
 * simply ungated); a declared requirement with no ACTIVE connection resolves to
 * `configured: false`.
 */
export async function resolveConnectionReadiness(
  tenantId: string,
  profileId: string,
  actingUserId?: string,
): Promise<ConnectionReadiness> {
  const profile = await getAgentProfile(tenantId, profileId);
  const required = profile?.requiredConnections ?? [];
  if (required.length === 0) return READY_EMPTY;

  const connections = await listConnections(tenantId, actingUserId);
  // Most-ready status wins per provider: an active connection anywhere on the
  // visible axes satisfies the requirement.
  const bestStatusByProvider = new Map<string, ConnectionStatus>();
  for (const c of connections) {
    const prev = bestStatusByProvider.get(c.provider);
    if (prev === 'active') continue;
    if (c.status === 'active' || prev === undefined) bestStatusByProvider.set(c.provider, c.status);
  }

  const entries: ConnectionReadinessEntry[] = required.map((provider) => {
    const status = bestStatusByProvider.get(provider);
    return {
      provider,
      configured: status === 'active',
      ...(status !== undefined ? { status } : {}),
    };
  });
  const missing = entries.filter((e) => !e.configured).map((e) => e.provider);
  return { required, entries, allConfigured: missing.length === 0, missing };
}

/**
 * Gate an autonomy level by connection readiness. When the agent's required
 * connections are NOT all configured, force `review` — "agents propose, humans
 * dispose": the heartbeat will queue a proposal instead of auto-starting a run,
 * so a twin never autonomously acts on an integration it can't reach (ADR 0033
 * §3.3 fail-closed). When ready, the level is unchanged.
 *
 * This is deliberately a pure function over the already-resolved readiness so
 * it composes at any activation seam without another store read.
 */
export function gateAutonomyByReadiness(
  level: 'auto' | 'guided' | 'review',
  readiness: ConnectionReadiness,
): 'auto' | 'guided' | 'review' {
  return readiness.allConfigured ? level : 'review';
}
