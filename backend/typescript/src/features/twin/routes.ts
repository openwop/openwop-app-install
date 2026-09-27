/**
 * Digital-twin routes (ADR 0044, Phase 1) — host-extension. Two surfaces over the
 * host-owned `twinService`:
 *
 *   Admin LINK (operational) — /v1/host/openwop-app/agents/:id/twin
 *     GET     read the link + the linked user's grant status
 *     PUT     link the agent to a user                    [workspace:write + agent IDOR]
 *     DELETE  unlink (also revokes the grant)             [workspace:write + agent IDOR]
 *
 *   User GRANT (authorization) — /v1/host/openwop-app/profiles/me/twin-grants
 *     GET                  the caller's issued grants (who may recall my memory)
 *     POST                 grant for { agentId, scopes }   [self; agent must be linked to me]
 *     DELETE /:agentId     revoke my grant                 [self]
 *
 * Everything is gated by the `twin-recall` toggle (OFF by default, tenant-bucketed)
 * — the whole twin surface is opt-in per tenant. Fail-closed throughout: a caller
 * may only grant/revoke for an agent LINKED to their own account; the admin link is
 * tenant-IDOR-guarded.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveCallerUser } from '../users/usersGuards.js';
// TWIN-5 / ADR 0587 §5 — the CANONICAL `requireTenantScope`, from the module this
// file already imported. The local copy deleted here was the third hand-rolled
// `resolveEffectiveAccess({ subject })` predicate in the repo, and it carried all
// three of that shape's defects: org-first-match non-determinism, NO wildcard-
// operator exit (a live 403 for an operator principal on a scope it can never
// obtain), and fail-open when `subject === undefined`.
import { requireFeatureEnabled, requireString, requireTenantScope } from '../featureRoute.js';
import { getRosterEntry } from '../../host/rosterService.js';
import {
  getTwinLink, linkTwin, unlinkTwin,
  grantTwin, revokeTwin, listGrantsForUser, getActiveGrant,
  isTwinScope,
  type TwinScope,
} from '../../host/twinService.js';

const TOGGLE_ID = 'twin-recall';
const LABEL = 'Digital twin recall';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Tenant-IDOR: the agent MUST exist in the caller's tenant (else a generic 404). */
async function requireOwnedAgent(req: Request): Promise<string> {
  const id = req.params.id;
  const entry = await getRosterEntry(tenantOf(req), id);
  if (!entry) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { id });
  }
  return id;
}

/** TWIN-20 — validate, never cast. `return raw as TwinScope[]` was safe only
 *  because `grantTwin` re-filters against `ALL_SCOPES`; the route-level type was a
 *  lie, and a second reader of this value would have inherited it. */
function parseScopes(body: Record<string, unknown>): TwinScope[] {
  const raw = body.scopes;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) {
    throw new OpenwopError('validation_error', '`scopes` must be an array of strings (`memory` / `knowledge`).', 400, { field: 'scopes' });
  }
  const unknown = (raw as string[]).filter((s) => !isTwinScope(s));
  if (unknown.length > 0) {
    throw new OpenwopError('validation_error', `Unknown \`scopes\` value(s): ${unknown.join(', ')}. Allowed: memory, knowledge.`, 400, { field: 'scopes' });
  }
  return (raw as string[]).filter(isTwinScope);
}

export function registerTwinRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── admin LINK ──
  app.get('/v1/host/openwop-app/agents/:id/twin', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:read');
      const link = await getTwinLink(tenantOf(req), id);
      const grant = link ? await getActiveGrant(tenantOf(req), id, link.userId) : null;
      res.json({ link, grant: grant ? { scopes: grant.scopes, version: grant.version, grantedAt: grant.grantedAt } : null });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/agents/:id/twin', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      const userId = requireString((req.body ?? {})?.userId, 'userId');
      await linkTwin(deps.storage, tenantOf(req), id, userId, actingUserOf(req) ?? 'unknown');
      res.json({ link: await getTwinLink(tenantOf(req), id) });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/agents/:id/twin', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      const removed = await unlinkTwin(deps.storage, tenantOf(req), id, actingUserOf(req) ?? 'unknown');
      // TWIN-UX-3 (unlink lane) — mirror the revoke route below: report whether a
      // link actually existed instead of a 204 that made "unlinked a live twin and
      // revoked its grant" and "there was nothing here" indistinguishable. The SPA
      // branches its notice on this, and a no-op writes no `twin.unlink` audit row.
      res.status(200).json({ removed });
    } catch (err) { next(err); }
  });

  // ── user GRANT (self) ──
  //
  // ADR 0589 §D1 — the tenant is `tenantOf(req)` (ACTIVE), and `user.userId` is
  // the SUBJECT only. This is the ADR 0508 precedent, spelled out at
  // `features/featureRoute.ts:209-218`.
  //
  // What was wrong: these three routes derived their tenant from
  // `resolveCallerUser(req).tenantId`, which is the caller's HOME tenant
  // (`features/users/usersGuards.ts:85-93` returns the canonical home-tenant user
  // for every real signed-in caller), while the LINK half above uses
  // `tenantOf(req)`. Inside any ADR 0015 shared `ws:` workspace the two differ, so
  // `grantTwin` resolved the link under a tenant the agent does not live in,
  // `getRosterEntry` returned null, and the ONE button the whole feature exists
  // for answered 404 — under a panel simultaneously rendering "Twin of you".
  //
  // NO MIGRATION, and structurally so: the 404 at `twinService.ts:111-114` sits
  // INSIDE `grantTwin`, before the only `grants.put` in the codebase, so no row
  // has ever been minted under a mismatched tenant. That 404 is a real
  // authorization check ("you are not the person this agent is linked to") and is
  // deliberately NOT removed or relaxed — the `GEN-TWIN-1` ordering constraint is
  // satisfied by fixing the CALLER, which leaves the guard's meaning intact.
  app.get('/v1/host/openwop-app/profiles/me/twin-grants', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      res.json({ grants: await listGrantsForUser(tenantOf(req), user.userId) });
    } catch (err) { next(err); }
  });

  // TWIN-UX-4 (the carried Blocker) — the recall audit READER. The `twin.recall`
  // row existed since Phase 2 and had no reader the SUBJECT could reach: the only
  // reading route is the superadmin governance view, so the person whose memory
  // was read could never see when. This returns the CALLER'S OWN rows — subject-
  // PUSHED-DOWN to the store (PR #3409 review F2b: the previous newest-500-
  // then-filter window truncated the subject's own history behind unrelated
  // rows — review-probed at 7 eligible → 1 shown — rendering "Never recalled
  // yet." over real recalls, empty-as-success at the data layer directly under
  // the copy added to prevent exactly that). Subject-scoped by construction
  // (`resource === user:<callerUserId>`; the resolver writes the row against
  // the OWNER, so nobody else's recalls can match) and tenant-scoped
  // fail-closed (rows without a payload tenant stamp, i.e. rows predating
  // RCL-3's stamping, are withheld rather than guessed). Denied rows ride
  // along — a probe by someone else is precisely what a grantor reviews
  // consent FOR; their `attempts` carries the F3 window aggregate. The limit
  // is now a bound on the SUBJECT'S OWN newest rows, not a host-global one.
  app.get('/v1/host/openwop-app/profiles/me/twin-recalls', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      const tenantId = tenantOf(req);
      const rows = await deps.storage.listAudit({ actionPrefix: 'twin.recall', resource: `user:${user.userId}`, limit: 500 });
      const recalls = rows
        .filter((r) => {
          if (r.resource !== `user:${user.userId}`) return false;
          const p = r.payload as Record<string, unknown> | undefined | null;
          return p !== undefined && p !== null && typeof p === 'object' && p.tenantId === tenantId;
        })
        .map((r) => {
          const p = r.payload as Record<string, unknown>;
          return {
            timestamp: r.timestamp,
            outcome: r.outcome === 'denied' ? 'denied' : 'ok',
            ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
            ...(typeof p.chunks === 'number' ? { chunks: p.chunks } : {}),
            ...(Array.isArray(p.scopes) ? { scopes: p.scopes.filter((s): s is string => typeof s === 'string') } : {}),
            ...(typeof p.runId === 'string' ? { runId: p.runId } : {}),
            ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
            ...(typeof p.attempts === 'number' && p.attempts > 1 ? { attempts: p.attempts } : {}),
          };
        });
      res.json({ recalls });
    } catch (err) { next(err); }
  });

  app.post('/v1/host/openwop-app/profiles/me/twin-grants', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      const agentId = requireString((req.body ?? {})?.agentId, 'agentId');
      const scopes = parseScopes((req.body ?? {}) as Record<string, unknown>);
      const grant = await grantTwin(deps.storage, tenantOf(req), agentId, user.userId, scopes);
      res.status(201).json({ grant });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/profiles/me/twin-grants/:agentId', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      const removed = await revokeTwin(deps.storage, tenantOf(req), req.params.agentId, user.userId);
      // TWIN-UX-25 — a re-revoke is the natural outcome of a double-click or a
      // stale list, and it achieved exactly what the user wanted. Report the
      // outcome instead of inventing a scary 404 for a benign idempotent call;
      // `removed:false` also lets the SPA suppress a misleading success notice
      // (TWIN-UX-3's "204 when it removed nothing" on the sibling route).
      res.status(200).json({ removed });
    } catch (err) { next(err); }
  });
}
