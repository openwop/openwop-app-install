/**
 * Tutorials host-extension routes (ADR 0488 P1).
 *
 * `/v1/host/openwop-app/tutorials*` — NON-NORMATIVE host-extension surface, so
 * no OpenWOP RFC is involved (verified free of collisions: no other module
 * registers this prefix).
 *
 * NOT toggle-gated, and that is deliberate rather than an oversight. ADR 0490
 * made `/tutorials` always-on under the access-hub posture — "tutorials teach
 * features a workspace may not have enabled yet, so the reader itself is never
 * toggle-gated" — and ADR 0488 D3 preserves it: reads degrade to the shipped
 * seed when the `entities` kernel is off, they never 404 and never empty.
 *
 * Reads are tenant-scoped through `tenantOf(req)`; a tenant only ever sees its
 * own kernel rows plus the shipped seeds, so there is no cross-tenant surface
 * here. There are no mutating routes in P1 — authoring is the P6 lane and will
 * arrive with its own authorization, not by widening these.
 */
import type { Express } from 'express';
import { tenantOf, callerSubject, isDurableCaller } from '../../host/requestSubject.js';
import { getTutorial, listTutorials } from './tutorialsService.js';
import { listTutorialProgress, putTutorialProgress } from './progressStore.js';
import { OpenwopError } from '../../types.js';

export function registerTutorialsRoutes(app: Express): void {
  /** The tenant's tutorial library. `degraded` tells the client the kernel was
   *  unreachable so it can say "shipped copy, not editable here" instead of
   *  implying these are the tenant's own rows. */
  app.get('/v1/host/openwop-app/tutorials', (req, res, next) => {
    void (async () => {
      try {
        const { tutorials, degraded } = await listTutorials(tenantOf(req));
        res.json({
          tutorials: tutorials.map((t) => ({
            id: t.id,
            category: t.category,
            title: t.title,
            description: t.description,
            ...(t.difficulty ? { difficulty: t.difficulty } : {}),
            ...(t.estimatedMinutes ? { estimatedMinutes: t.estimatedMinutes } : {}),
            ...(t.surfaces ? { surfaces: t.surfaces } : {}),
            source: t.source,
            ...(t.customized ? { customized: true } : {}),
          })),
          degraded,
        });
      } catch (err) { next(err); }
    })();
  });

  /**
   * ADR 0488 D4 — the caller's OWN progress. An anonymous caller has no durable
   * subject, so there is nothing to return: `[]` with `persisted:false` tells the
   * client to keep using its localStorage copy rather than showing an empty
   * server state as if it were the truth.
   */
  app.get('/v1/host/openwop-app/tutorials/progress', (req, res, next) => {
    void (async () => {
      try {
        // §Correction (grade-data `GEN-1`/`TUT-5`): `callerSubject` is NOT the
        // durability test. A cookie-anon caller has a principal
        // (`session:<sid>`, middleware/auth.ts), so `!userId` never fired and
        // anon sessions were told `persisted: true` for rows in a throwaway
        // tenant. `isDurableCaller` is the app's single home for this rule.
        const userId = isDurableCaller(req) ? callerSubject(req) : undefined;
        if (!userId) { res.json({ progress: [], persisted: false }); return; }
        const rows = await listTutorialProgress(tenantOf(req), userId);
        res.json({
          progress: rows.map(({ tutorialId, completedStepIds, updatedAt }) => ({ tutorialId, completedStepIds, updatedAt })),
          persisted: true,
        });
      } catch (err) { next(err); }
    })();
  });

  /** Upsert one tutorial's completed steps. The subject is SERVER-stamped — a
   *  client cannot write another member's progress by supplying a userId. */
  app.post('/v1/host/openwop-app/tutorials/progress', (req, res, next) => {
    void (async () => {
      try {
        // Durable subjects only — see the GET's correction note. Writing a row
        // for an `anon:<sid>` session was the SOURCE of the orphan the fold
        // creates: `reassignTenant` rewrites the tenant segment of the key but
        // NOT the `userId` field, so a folded anon row keeps `session:<sid>`
        // while the signed-in caller is `user:<hash>` — invisible to the
        // learner's own reads AND permanently beyond subject erasure. Not
        // writing it is a better fix than teaching the eraser to chase it.
        const userId = isDurableCaller(req) ? callerSubject(req) : undefined;
        // Fail honestly: an anonymous caller is not silently "saved".
        if (!userId) throw new OpenwopError('forbidden', 'Sign in to save tutorial progress.', 403, {});
        const body = (req.body ?? {}) as { tutorialId?: unknown; completedStepIds?: unknown };
        if (typeof body.tutorialId !== 'string' || !body.tutorialId) {
          throw new OpenwopError('validation_error', '`tutorialId` is required.', 400, {});
        }
        if (!Array.isArray(body.completedStepIds)) {
          throw new OpenwopError('validation_error', '`completedStepIds` must be an array of step ids.', 400, {});
        }
        // `mode:'clear'` is the explicit reset path — the one write that must not
        // union with a concurrent writer (grade-data `TUT-7`). Anything else is a
        // normal CAS'd replace.
        const mode = (body as { mode?: unknown }).mode === 'clear' ? 'clear' as const : 'replace' as const;
        const stored = await putTutorialProgress({
          tenantId: tenantOf(req),
          userId,
          tutorialId: body.tutorialId,
          completedStepIds: body.completedStepIds as string[],
          mode,
        });
        // Echo what is now STORED. When a concurrent device forced a union the
        // client's optimistic set is stale, so returning `ok:true` alone would
        // leave it quietly diverged from the server.
        res.json({ ok: true, ...stored });
      } catch (err) { next(err); }
    })();
  });

  /** One tutorial in full. 404 only when NO kernel row AND no seed matches — a
   *  kernel failure degrades to the seed rather than surfacing as not-found. */
  app.get('/v1/host/openwop-app/tutorials/:slug', (req, res, next) => {
    void (async () => {
      try {
        const tutorial = await getTutorial(tenantOf(req), req.params.slug);
        if (!tutorial) { res.status(404).json({ error: 'not_found', message: 'Tutorial not found.' }); return; }
        res.json({ tutorial });
      } catch (err) { next(err); }
    })();
  });
}
