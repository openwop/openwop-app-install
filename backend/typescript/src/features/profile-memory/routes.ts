/**
 * Personal memory routes (ADR 0041) — host-extension, best-effort.
 *
 * The human counterpart of the per-agent Knowledge surface (ADR 0038): a person
 * trains their OWN profile with personal memories (facts/notes), building toward
 * a digital twin of themselves. Memories live in the shared RFC-0004 store under
 * `user:<userId>` (the subject-memory seam), NEVER inlined into the descriptive
 * `Profile` record (ADR 0005 boundary).
 *
 * Surface under /v1/host/openwop-app/profiles/me/memory:
 *   GET    /                 list the caller's own memories (newest first)
 *   POST   /                 add a memory                          [self only]
 *   DELETE /:noteId          remove a memory                       [self only]
 *
 * Authority is INTRINSIC self-ownership: every handler keys the subject on the
 * caller's OWN resolved `userId` (a caller can only ever touch their own memory).
 * Tenant-scoped (CTI-1 — `tenantId` bound from the principal). ALWAYS-ON (ADR 0041
 * § Correction 2026-06-15 — graduated off its toggle, like `profiles`): the routes
 * serve unconditionally; `resolveCallerUser` fails closed for anonymous callers.
 *
 * @see docs/adr/0041-subject-memory.md
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { addSubjectNote, listSubjectNotes, removeSubjectNote, type MemorySubject } from '../../host/subjectMemory.js';

export function registerProfileMemoryRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/profiles/me/memory';

  const selfSubject = (userId: string): MemorySubject => ({ kind: 'user', id: userId });

  // GET /me/memory — the caller's own memories.
  app.get(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      res.json({ notes: await listSubjectNotes(user.tenantId, selfSubject(user.userId)) });
    } catch (err) { next(err); }
  });

  // POST /me/memory — add a memory. Validation + cap are owned by the seam.
  app.post(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      await addSubjectNote(user.tenantId, selfSubject(user.userId), (req.body ?? {})?.content);
      res.status(201).json({ notes: await listSubjectNotes(user.tenantId, selfSubject(user.userId)) });
    } catch (err) { next(err); }
  });

  // DELETE /me/memory/:noteId — remove a memory (only a curated memory is
  // removable). 404 when none matched (no existence leak).
  app.delete(`${BASE}/:noteId`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const removed = await removeSubjectNote(user.tenantId, selfSubject(user.userId), req.params.noteId);
      if (!removed) throw new OpenwopError('not_found', 'Memory not found.', 404, { noteId: req.params.noteId });
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
