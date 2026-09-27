/**
 * ADR 0137 Phase 3 — ambient-work-graph REST (authed, host-extension).
 *
 *   GET  /v1/host/openwop-app/work-graph/orgs/:orgId/suggestions
 *   POST /v1/host/openwop-app/work-graph/orgs/:orgId/suggestions/refresh
 *   POST /v1/host/openwop-app/work-graph/orgs/:orgId/suggestions/:id/dismiss
 *   POST /v1/host/openwop-app/work-graph/orgs/:orgId/suggestions/:id/accept
 *
 * Tenant-wide insight; always-on (toggle removed) — `requireOrgScope` RBAC only. GET
 * READS stored suggestions (fast, no sweep); `refresh` runs a bounded sweep.
 * `accept` marks accepted + returns a draftSeed the FE hands to the EXISTING chat-driven
 * workflow-author (no second author; no backend node-schema coupling). by-id ops verify
 * tenant ownership (IDOR-safe).
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { requireOrgScope } from '../featureRoute.js';
import { listSuggestions, getSuggestion, setSuggestionStatus } from './suggestionStore.js';
import { sweepTenant } from './workGraphSweep.js';
import { createProposalFromAcceptedPattern } from '../proposals/proposalsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('ambient-work-graph');

// Always-on (toggle removed, 2026-06-24) — RBAC-gated only.
const BASE = '/v1/host/openwop-app/work-graph/orgs/:orgId/suggestions';

export function registerAmbientWorkGraphRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  // READ — non-dismissed suggestions (suggested + accepted). No sweep on the hot path.
  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId } = await requireOrgScope(req, 'workspace:read');
      const suggestions = (await listSuggestions(tenantId)).filter((s) => s.status !== 'dismissed');
      res.json({ suggestions });
    } catch (err) { next(err); }
  });

  // Explicit on-demand refresh (bounded sweep) — kept off GET to protect the read path.
  app.post(`${BASE}/refresh`, async (req, res, next) => {
    try {
      const { tenantId } = await requireOrgScope(req, 'workspace:write');
      await sweepTenant({ storage }, tenantId);
      const suggestions = (await listSuggestions(tenantId)).filter((s) => s.status !== 'dismissed');
      res.json({ suggestions });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:id/dismiss`, async (req, res, next) => {
    try {
      const { tenantId } = await requireOrgScope(req, 'workspace:write');
      await requireOwned(req.params.id, tenantId);
      res.json({ suggestion: await setSuggestionStatus(req.params.id, 'dismissed') });
    } catch (err) { next(err); }
  });

  // Accept → mark accepted + return a draftSeed the FE hands to the chat-driven
  // workflow-author (the Workflow Architect agent); no second author, no schema coupling.
  app.post(`${BASE}/:id/accept`, async (req, res, next) => {
    try {
      const { user, tenantId } = await requireOrgScope(req, 'workspace:write');
      const existing = await requireOwned(req.params.id, tenantId);
      const suggestion = await setSuggestionStatus(req.params.id, 'accepted');
      // RFC 0096 — record the human-vetted accept as a durable reviewable-learning
      // proposal (the ONE real producer). Idempotent (deterministic id from the
      // suggestionId), tenant-scoped; best-effort so a proposals hiccup never
      // fails the accept + draftSeed the FE needs.
      let proposalId: string | undefined;
      try {
        const proposal = await createProposalFromAcceptedPattern(
          tenantId,
          {
            suggestionId: existing.suggestionId,
            toolSequence: existing.toolSequence,
            count: existing.count,
            exampleRunIds: existing.exampleRunIds,
            ...(existing.sampleGoal ? { sampleGoal: existing.sampleGoal } : {}),
          },
          user.userId,
        );
        proposalId = proposal.id;
      } catch (err) {
        // Best-effort: a proposals hiccup must not fail the accept + draftSeed.
        log.warn('work_graph_proposal_create_failed', { suggestionId: existing.suggestionId, error: err instanceof Error ? err.message : String(err) });
      }
      res.json({
        suggestion,
        ...(proposalId ? { proposalId } : {}),
        draftSeed: {
          name: existing.sampleGoal ?? `Workflow from ${existing.toolSequence.join(' → ')}`,
          toolSequence: existing.toolSequence,
          ...(existing.sampleGoal ? { sampleGoal: existing.sampleGoal } : {}),
        },
      });
    } catch (err) { next(err); }
  });

  /** Fetch a suggestion + verify it belongs to the caller's tenant (IDOR-safe 404). */
  async function requireOwned(id: string, tenantId: string) {
    const s = await getSuggestion(id);
    if (!s || s.tenantId !== tenantId) throw new OpenwopError('not_found', `suggestion "${id}" not found.`, 404);
    return s;
  }
}
