/**
 * Agent Author host-extension routes (ADR 0514 OQ1) — the wizard's side of
 * the draft-stash handoff. NON-NORMATIVE `/v1/host/openwop-app/*` surface; no
 * RFC involved. Prefix verified collision-free (no other module registers
 * `/v1/host/openwop-app/agent-author`).
 *
 * SELF-SCOPED: both routes touch only the CALLER'S OWN stash row (tenant +
 * durable subject), which is the same predicate the persist tool's draft mode
 * enforces (`scope.actingUserId` — a signed-in user turn). Route and tool
 * therefore share ONE access rule by construction: "your own row, and only
 * with a durable subject" — there is no admin surface and no by-id read that
 * could IDOR.
 */
import type { Express } from 'express';
import { tenantOf, callerSubject, isDurableCaller } from '../../host/requestSubject.js';
import { clearStashedDraft, getStashedDraft } from './draftStash.js';

export function registerAgentAuthorRoutes(app: Express): void {
  /** The caller's own stashed draft, if any. An anonymous caller has no
   *  durable subject and therefore no stash — `{ draft: null }`, which is the
   *  TRUE state, not a masked failure. */
  app.get('/v1/host/openwop-app/agent-author/draft', (req, res, next) => {
    void (async () => {
      try {
        const subject = isDurableCaller(req) ? callerSubject(req) : undefined;
        if (!subject) { res.json({ draft: null }); return; }
        const row = await getStashedDraft(tenantOf(req), subject);
        res.json(row ? { draft: row.draft, stashedAt: row.stashedAt } : { draft: null });
      } catch (err) { next(err); }
    })();
  });

  /** Consume/dismiss the caller's own stash (idempotent). */
  app.delete('/v1/host/openwop-app/agent-author/draft', (req, res, next) => {
    void (async () => {
      try {
        const subject = isDurableCaller(req) ? callerSubject(req) : undefined;
        if (subject) await clearStashedDraft(tenantOf(req), subject);
        res.status(204).end();
      } catch (err) { next(err); }
    })();
  });
}
