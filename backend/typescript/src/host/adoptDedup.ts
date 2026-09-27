/**
 * Pre-fold persona dedup for anon→user adoption (2026-07-16).
 *
 * When a signed-in user adopts an anon session, `reassignTenant` folds the anon
 * tenant's rows into the user's by rewriting `tenant_id`. For per-persona demo
 * entities this DUPLICATES:
 *   - `user_agents` (a table) — `agent_id` embeds the anon tenant
 *     (`user.anon:<sid>.iris`), so N adopted anon sessions fold in as N distinct
 *     rows → the agent-allowlists page shows "Chief of Staff" ×N.
 *   - roster (KV, listed by a `content.tenantId` filter) — distinct random
 *     `rosterId`s, same fold-in duplication.
 *
 * The demo pitch (anon visitors land on a populated app) is preserved — the fix
 * is HERE, not in the seed: before the fold, delete any anon row whose persona
 * the target tenant already has, so the fold moves only what the target lacks.
 * Idempotent (a re-run finds the anon side already drained) and best-effort per
 * row (a delete failure just leaves that row to fold in — no worse than today).
 *
 * ADR 0379 Phase 4 disposition (2026-07-17): the persona-scoped id cure SHIPPED
 * for all NEW data (Phase 2: `user.<slug>` + deterministic `host:<slug>` under
 * composite/tenant-qualified keys), so for new-scheme rows this module is no
 * longer cosmetic — it is the REQUIRED pre-fold step: two same-persona
 * new-scheme rows share an id, and `reassignTenant`'s blanket
 * `UPDATE tenant_id` would hit the composite-PK conflict mid-fold without this
 * dedup running first (test-pinned in adr0379-fold-idempotency.test.ts; the
 * ONE call site is routes/migrate.ts, immediately before the fold). For
 * GRANDFATHERED old-scheme rows (`user.<tenant>.<slug>` / random rosterIds,
 * pre-P2 tenants) it remains the persona-matching dedup. Full Phase 3 (rekey
 * old rows) is DEFERRED-WITH-REASON in the ADR — a 19-store reference rewrite
 * whose only benefit this module already provides at the only point it
 * matters. Retire on Phase 3 or old-tenant attrition, not before.
 */
import { listRoster, deleteRosterEntry } from './rosterService.js';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('adopt-dedup');

export interface AdoptDedupResult {
  userAgentsDropped: number;
  rosterDropped: number;
}

/**
 * Delete anon-tenant `user_agents` + roster rows whose persona already exists in
 * the target (user) tenant, so the subsequent `reassignTenant` fold can't
 * duplicate them. Call IMMEDIATELY before the fold.
 */
export async function dedupePersonasBeforeAdopt(
  anonTenantId: string,
  userTenantId: string,
  storage: Storage,
): Promise<AdoptDedupResult> {
  // Grade-pass fix (ADR 0379): dedup in the SLUG domain, not trim/lowercase —
  // the composite-PK collision domain IS the slug ("Iris-Chen" and "Iris Chen"
  // mint the same `user.iris-chen`, differ under a bare lowercase compare, and
  // an escaped pair would make the fold's blanket UPDATE hit the PK conflict →
  // the adopt 500s on every retry with no self-heal). Transforms mirror the
  // id mints: userAgents.ts slugify (chat agents) and rosterService slugify
  // (roster ids, 40-cap + fallback).
  const norm = (p: string): string => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const rosterNorm = (p: string): string => {
    const base = norm(p).slice(0, 40);
    return base.length > 0 ? base : 'agent';
  };
  let userAgentsDropped = 0;
  let rosterDropped = 0;

  // ── user_agents (the agent-allowlists page) ──
  try {
    const seen = new Set((await storage.listUserAgents(userTenantId)).map((a) => norm(a.persona)));
    for (const a of await storage.listUserAgents(anonTenantId)) {
      if (seen.has(norm(a.persona))) {
        if (await storage.deleteUserAgent(anonTenantId, a.agentId).catch(() => false)) userAgentsDropped += 1;
      } else {
        // Keep the first of a persona; guard against an anon side that somehow
        // holds two of the same persona folding in as two.
        seen.add(norm(a.persona));
      }
    }
  } catch (err) {
    log.warn('user_agent_dedup_failed', { anonTenantId, userTenantId, error: String(err) });
  }

  // ── roster ──
  try {
    const seen = new Set((await listRoster(userTenantId)).map((e) => rosterNorm(e.persona)));
    for (const e of await listRoster(anonTenantId)) {
      if (seen.has(rosterNorm(e.persona))) {
        if (await deleteRosterEntry(anonTenantId, e.rosterId).catch(() => false)) rosterDropped += 1;
      } else {
        seen.add(rosterNorm(e.persona));
      }
    }
  } catch (err) {
    log.warn('roster_dedup_failed', { anonTenantId, userTenantId, error: String(err) });
  }

  if (userAgentsDropped || rosterDropped) {
    log.info('adopt_dedup', { anonTenantId, userTenantId, userAgentsDropped, rosterDropped });
  }
  return { userAgentsDropped, rosterDropped };
}
