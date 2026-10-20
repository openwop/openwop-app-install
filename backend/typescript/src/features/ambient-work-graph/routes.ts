/**
 * ADR 0137 Phase 3 + ADR 0930 — ambient-work-graph REST (authed, host-extension).
 *
 *   GET  /host/openwop-app/work-graph/orgs/:orgId/suggestions
 *   POST /host/openwop-app/work-graph/orgs/:orgId/suggestions/refresh
 *   POST /host/openwop-app/work-graph/orgs/:orgId/suggestions/:id/dismiss
 *   POST /host/openwop-app/work-graph/orgs/:orgId/suggestions/:id/accept
 *   GET  /host/openwop-app/work-graph/orgs/:orgId/settings
 *   PUT  /host/openwop-app/work-graph/orgs/:orgId/settings     { paused: boolean }
 *
 * PERSONAL (ADR 0930 D1): every route serves and decides the CALLER's rows only — the
 * owner key their runs are mined under (`ownership.ts`). Another person's id is the same
 * 404 as an unknown one, and admins get no wider view. The data is the caller's own, so
 * reading, scanning, dismissing and pausing need `workspace:read` (A12); accepting needs
 * `workspace:write`, because it mints a proposal the whole workspace can list (A3). Every
 * route reads runs, so `runs:read` follows the org gate (D8/A11). A suppressed owner's
 * rows are never served, whatever a racing sweep wrote (A2).
 *
 * `accept` returns a draftSeed the FE hands to the EXISTING chat-driven workflow-author
 * (no second author; no backend node-schema coupling).
 *
 * @see docs/adr/0137-ambient-work-graph.md
 * @see docs/adr/0930-ambient-work-graph-per-owner.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { requireOrgScope } from '../featureRoute.js';
import { requireProtocolScope } from '../../host/protocolAuthorization.js';
import type { Scope } from '../../host/accessControlService.js';
import { decideSuggestion, forgetOwner, listOwnerSuggestions } from './suggestionStore.js';
import { clearSuppression, getSuppression, setSuppression } from './pauseStore.js';
import { sweepOwner } from './workGraphSweep.js';
import { callerOwnerKey } from './ownership.js';
import { createProposalFromAcceptedPattern } from '../proposals/proposalsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('ambient-work-graph');

// Always-on (toggle removed, 2026-06-24) — RBAC-gated only.
const ORG = '/host/openwop-app/work-graph/orgs/:orgId';
const BASE = `${ORG}/suggestions`;

/** The org gate, then `runs:read`, then the caller's owner key in the tenant they were
 *  authorized in. `ownerKey` is null when the request carries no person: reads then
 *  answer EMPTY and writes 404 (`requireOwner`). An anonymous session never gets this
 *  far — `requireOrgScope` refuses it 401 (probed, grade-code AWG2CD-11). */
async function authorize(req: Request, scope: Scope): Promise<{ userId: string; tenantId: string; ownerKey: string | null }> {
  const { user, tenantId } = await requireOrgScope(req, scope);
  await requireProtocolScope(req, 'runs:read');
  return { userId: user.userId, tenantId, ownerKey: callerOwnerKey(req) };
}
function requireOwner(ownerKey: string | null, id = ''): string {
  if (ownerKey === null) throw decisionError(id, 'not_found');
  return ownerKey;
}

/** The caller's visible rows: their own, not dismissed, and nothing while suppressed. */
async function visible(tenantId: string, ownerKey: string) {
  if (await getSuppression(tenantId, ownerKey)) return [];
  return (await listOwnerSuggestions(tenantId, ownerKey)).filter((s) => s.status !== 'dismissed');
}

export function registerAmbientWorkGraphRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  // READ — the caller's non-dismissed suggestions. No sweep on the hot path.
  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId, ownerKey } = await authorize(req, 'workspace:read');
      res.json({ suggestions: ownerKey === null ? [] : await visible(tenantId, ownerKey) });
    } catch (err) { next(err); }
  });

  // Explicit on-demand Scan of the caller's own runs — kept off GET to protect the read path.
  app.post(`${BASE}/refresh`, async (req, res, next) => {
    try {
      const { tenantId, ownerKey } = await authorize(req, 'workspace:read');
      if (ownerKey === null) { res.json({ suggestions: [], paused: false, scanned: 0, truncated: false }); return; }
      // `sweepOwner` reads no run of a suppressed owner (ADR 0930 D7) — the one place that rule lives.
      const scan = await sweepOwner({ storage }, tenantId, ownerKey);
      const paused = (await getSuppression(tenantId, ownerKey)) !== null;
      res.json({ suggestions: await visible(tenantId, ownerKey), paused, scanned: scan.scanned, truncated: scan.truncated });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:id/dismiss`, async (req, res, next) => {
    try {
      const { tenantId, ownerKey: key } = await authorize(req, 'workspace:read');
      const ownerKey = requireOwner(key, req.params.id);
      // A paused owner has no rows to decide on (AWG2CD-12): the page shows none.
      if (await getSuppression(tenantId, ownerKey)) throw decisionError(req.params.id, 'not_found');
      const r = await decideSuggestion(req.params.id, tenantId, ownerKey, 'dismissed');
      if (!r.ok) throw decisionError(req.params.id, r.reason);
      res.json({ suggestion: r.after });
    } catch (err) { next(err); }
  });

  // Accept → mark accepted + return a draftSeed the FE hands to the chat-driven
  // workflow-author (the Workflow Architect agent); no second author, no schema coupling.
  app.post(`${BASE}/:id/accept`, async (req, res, next) => {
    try {
      const { userId, tenantId, ownerKey: key } = await authorize(req, 'workspace:write');
      const ownerKey = requireOwner(key, req.params.id);
      if (await getSuppression(tenantId, ownerKey)) throw decisionError(req.params.id, 'not_found');
      const r = await decideSuggestion(req.params.id, tenantId, ownerKey, 'accepted');
      if (!r.ok) throw decisionError(req.params.id, r.reason);
      // AWG2CD-3 — a pause or an erasure that landed during the decision wins: no proposal
      // is minted for a profile its owner just withdrew.
      if (await getSuppression(tenantId, ownerKey)) throw decisionError(req.params.id, 'not_found');
      const existing = r.before;
      // RFC 0096 — record the human-vetted accept as a durable reviewable-learning
      // proposal (the ONE real producer). Idempotent (deterministic id from the
      // suggestionId), tenant-scoped; best-effort so a proposals hiccup never fails the
      // accept + draftSeed the FE needs. ADR 0930 A3 — the proposal is listed to the whole
      // workspace, so it carries the step pattern and the owner's own run ids, never the
      // goal text: accepting SHARES the steps, the page says so.
      let proposalId: string | undefined;
      try {
        const proposal = await createProposalFromAcceptedPattern(
          tenantId,
          { suggestionId: existing.suggestionId, toolSequence: existing.toolSequence, count: existing.count, exampleRunIds: existing.exampleRunIds },
          userId,
        );
        proposalId = proposal.id;
      } catch (err) {
        log.warn('work_graph_proposal_create_failed', { suggestionId: existing.suggestionId, error: err instanceof Error ? err.message : String(err) });
      }
      res.json({
        suggestion: r.after,
        ...(proposalId ? { proposalId } : {}),
        draftSeed: {
          name: existing.sampleGoal ?? `Workflow from ${existing.toolSequence.join(' → ')}`,
          toolSequence: existing.toolSequence,
          ...(existing.sampleGoal ? { sampleGoal: existing.sampleGoal } : {}),
        },
      });
    } catch (err) { next(err); }
  });

  // ADR 0930 D7 — the caller's own pause. An erasure tombstone reads as paused too, and
  // says so (`reason`), so the page can tell the person why (grade-ux AWG2UX-15).
  app.get(`${ORG}/settings`, async (req, res, next) => {
    try {
      const { tenantId, ownerKey } = await authorize(req, 'workspace:read');
      const s = ownerKey === null ? null : await getSuppression(tenantId, ownerKey);
      res.json({ paused: s !== null, ...(s ? { reason: s.reason } : {}) });
    } catch (err) { next(err); }
  });

  // Pausing writes the suppression FIRST, then forgets the rows (A2): a sweep already in
  // flight re-checks after its writes, and the reads refuse a suppressed owner.
  app.put(`${ORG}/settings`, async (req, res, next) => {
    try {
      const { tenantId, ownerKey: key } = await authorize(req, 'workspace:read');
      const ownerKey = requireOwner(key);
      const paused = (req.body as { paused?: unknown } | undefined)?.paused;
      if (typeof paused !== 'boolean') throw new OpenwopError('validation_error', '`paused` must be a boolean.', 400, { field: 'paused' });
      if (paused) {
        await setSuppression(tenantId, ownerKey, 'paused');
        await forgetOwner(tenantId, ownerKey, { keepDismissals: true });
      } else {
        await clearSuppression(tenantId, ownerKey);
      }
      res.json({ paused });
    } catch (err) { next(err); }
  });
}

function decisionError(id: string, reason: 'not_found' | 'conflict'): OpenwopError {
  return reason === 'conflict'
    ? new OpenwopError('conflict', `suggestion "${id}" was dismissed; it cannot be accepted.`, 409)
    : new OpenwopError('not_found', `suggestion "${id}" not found.`, 404);
}
