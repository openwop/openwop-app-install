/**
 * Memory auto-extraction consent routes (ADR 0120 Phase 1, ADR 0982 D2) — host-extension.
 * Self-service opt-in for the CALLER's own memory:
 *   GET    /v1/host/openwop-app/profiles/me/memory-extraction → { granted, updatedAt, available }
 *   PUT    …                                                   → grant (opt in)
 *   DELETE …                                                   → revoke (opt out)
 *
 * The caller is resolved through `resolveCallerUser`, the same door Personal Memory uses, so an
 * anonymous caller is refused 401 (they could never open what extraction writes), and the grant
 * is keyed on the person's HOME tenant and canonical `User.userId` from whichever workspace they
 * are in. That is the key the extraction lane reads (`extractionBinding.ts`).
 *
 * `available` is true only when the home tenant is a personal `user:` tenant, because only those
 * can ever extract (ADR 0982 D1). Opting in while unavailable is refused 409 rather than filing a
 * grant that can never act. `resolveCallerUser` can create the canonical row and fold an IdP email
 * (ADR 0982 A9); Personal Memory pays the same on the same page.
 *
 * @see docs/adr/0982-memory-extraction-closed-world-personal-lane.md
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { getExtractionGrant, setExtractionGrant } from './grantService.js';

const PATH = '/host/openwop-app/profiles/me/memory-extraction';

/** ADR 0982 D1 — only a personal `user:` home tenant can ever run the extraction lane. */
const extractionAvailable = (homeTenant: string): boolean => homeTenant.startsWith('user:');

export function registerMemoryExtractRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(PATH, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const g = await getExtractionGrant(user.tenantId, user.userId);
      res.json({ granted: g?.granted === true, updatedAt: g?.updatedAt ?? null, available: extractionAvailable(user.tenantId) });
    } catch (err) { next(err); }
  });

  app.put(PATH, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      if (!extractionAvailable(user.tenantId)) {
        throw new OpenwopError('conflict', 'Learning from chats needs a personal workspace, which this account does not have.', 409, { reason: 'memory_extraction_unavailable' });
      }
      const g = await setExtractionGrant(user.tenantId, user.userId, true, user.userId);
      res.json({ granted: g.granted, updatedAt: g.updatedAt, available: true });
    } catch (err) { next(err); }
  });

  app.delete(PATH, async (req, res, next) => {
    try {
      // Opting OUT is always allowed, available or not.
      const user = await resolveCallerUser(req);
      await setExtractionGrant(user.tenantId, user.userId, false, user.userId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
