/**
 * Memory auto-extraction grant routes (ADR 0120 Phase 1) — host-extension.
 * Self-service opt-in for the CALLER's own subject:
 *   GET    /v1/host/openwop-app/profiles/me/memory-extraction → { granted }
 *   PUT    …                                                   → grant (opt in)
 *   DELETE …                                                   → revoke (opt out)
 * Toggle-gated (404 when off). Only the owner grants their own memory (the
 * subject IS the caller); an anonymous caller fails closed (no subject).
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../featureRoute.js';
import { callerSubject } from '../../host/requestSubject.js';
import { OpenwopError } from '../../types.js';
import { getExtractionGrant, setExtractionGrant } from './grantService.js';

const PATH = '/v1/host/openwop-app/profiles/me/memory-extraction';

export function registerMemoryExtractRoutes(deps: RouteDeps): void {
  const { app } = deps;

  const subjectOf = (req: Parameters<typeof callerSubject>[0]): string => {
    const s = callerSubject(req);
    if (!s) throw new OpenwopError('forbidden', 'Sign in to manage memory extraction.', 403);
    return s;
  };

  app.get(PATH, async (req, res, next) => {
    try {
      const g = await getExtractionGrant(tenantOf(req), subjectOf(req));
      res.json({ granted: g?.granted === true, updatedAt: g?.updatedAt ?? null });
    } catch (err) { next(err); }
  });

  app.put(PATH, async (req, res, next) => {
    try {
      const subject = subjectOf(req);
      const g = await setExtractionGrant(tenantOf(req), subject, true, subject);
      res.json({ granted: g.granted, updatedAt: g.updatedAt });
    } catch (err) { next(err); }
  });

  app.delete(PATH, async (req, res, next) => {
    try {
      const subject = subjectOf(req);
      await setExtractionGrant(tenantOf(req), subject, false, subject);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
