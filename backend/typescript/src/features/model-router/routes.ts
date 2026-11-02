/**
 * Model-router config routes (ADR 0130 Phase 2; ADR 1016 D1/D2/D6).
 *
 * ONE config per workspace (the active tenant) — the key the chat exchange reads:
 *   `GET  /v1/host/openwop-app/model-router/config`          → `{ config, canManage }`
 *   `PUT  /v1/host/openwop-app/model-router/config`
 *   `POST /v1/host/openwop-app/model-router/config/enable`
 *   `POST /v1/host/openwop-app/model-router/config/preview`  → `{ decision, why }`
 *
 * Authority (ADR 1016 D2): writes point every chat in the workspace at a provider
 * and spend its key, so they take the ONE "point work at a stored key" predicate,
 * `requireByokManage` (ADR 0779 D1 — the BYOK routes and ADR 0943 D6 call the
 * same). Reads take `workspace:read`. Both after the toggle + plan gate.
 *
 * The pre-1016 per-org routes `…/model-router/orgs/:orgId/config[/enable]` stay as
 * ALIASES for the workspace root only (`orgId === tenantId`, no org-row lookup — a
 * personal workspace usually has no root org row), so `openwop model-router
 * enable <workspaceId>` keeps working. Any other org id answers 409: its config was
 * never read by any chat (ADR 1016 MR66WF-1), so accepting it would be a silent
 * write nobody reads.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { requireByokManage, requireFeatureEnabled, requireTenantScope, tenantOf } from '../featureRoute.js';
import { actingHumanUserId, isAnonymous, requireSignedIn } from '../users/usersGuards.js';
import { getRouterConfig, setRouterConfig, setRouterEnabled } from './configService.js';
import { previewRoute } from './preview.js';

/** ADR 0820 §8.2 — the config routes gate on toggle + plan. */
const FEATURE = { toggleId: 'model-router', label: 'Model router' } as const;

/** Toggle + plan, then `workspace:read`. Returns the workspace (active tenant). */
async function authorizeRead(req: Request): Promise<string> {
  await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
  await requireTenantScope(req, 'workspace:read');
  return tenantOf(req);
}

/** Toggle + plan, a signed-in caller, then BYOK-manage. Returns the workspace and
 *  the acting subject (the canonical user, or the principal for an API key /
 *  operator token — MR66CD-5: `resolveCallerUser` 401'd those AFTER authority
 *  had passed). */
async function authorizeWrite(req: Request): Promise<{ tenantId: string; actor: string }> {
  await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
  requireSignedIn(req);
  await requireByokManage(req);
  const tenantId = tenantOf(req);
  return { tenantId, actor: (await actingHumanUserId(req)) ?? req.principal?.principalId ?? tenantId };
}

/** The legacy alias accepts only the workspace root's own id. */
function assertWorkspaceAlias(req: Request): void {
  const orgId = req.params.orgId;
  if (orgId !== tenantOf(req)) {
    throw new OpenwopError(
      'conflict',
      'Model routing is configured per workspace, not per organization. Use /model-router/config, or pass this workspace\'s id.',
      409,
      { reason: 'model_router_workspace_scoped', orgId },
    );
  }
}

/** Does the caller hold the write authority? Evaluated for the console's read-only
 *  state — the caller's own boolean, no other data. An anonymous session never
 *  can (writes need a signed-in caller). Only the authority REFUSAL reads as
 *  false: any other failure (storage, access-control store) propagates instead
 *  of silently rendering a read-only console (MR66CD-4). */
async function canManage(req: Request): Promise<boolean> {
  if (isAnonymous(req)) return false;
  try {
    await requireByokManage(req);
    return true;
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus === 403) return false;
    throw err;
  }
}

export function registerModelRouterRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/model-router/config';
  const LEGACY = '/host/openwop-app/model-router/orgs/:orgId/config';

  // Handlers take an ALREADY-authorized context, so the legacy aliases below run
  // each gate once (MR66CD-13).
  const read = async (req: Request, tenantId: string) =>
    ({ config: await getRouterConfig(tenantId), canManage: await canManage(req) });
  const put = async (req: Request, ctx: { tenantId: string; actor: string }) =>
    ({ config: await setRouterConfig(ctx.tenantId, ctx.actor, req.body) });
  const enable = async (req: Request, ctx: { tenantId: string; actor: string }) => {
    const enabled = (req.body as { enabled?: unknown })?.enabled !== false;
    return { config: await setRouterEnabled(ctx.tenantId, ctx.actor, enabled) };
  };

  app.get(BASE, async (req, res, next) => {
    try { res.json(await read(req, await authorizeRead(req))); } catch (err) { next(err); }
  });
  app.put(BASE, async (req, res, next) => {
    try { res.json(await put(req, await authorizeWrite(req))); } catch (err) { next(err); }
  });
  app.post(`${BASE}/enable`, async (req, res, next) => {
    try { res.json(await enable(req, await authorizeWrite(req))); } catch (err) { next(err); }
  });
  app.post(`${BASE}/preview`, async (req, res, next) => {
    try {
      const tenantId = await authorizeRead(req);
      res.json(await previewRoute(tenantId, req.body));
    } catch (err) { next(err); }
  });

  // Legacy per-org aliases (ADR 1016 D1). The D2 gates run FIRST, so a caller
  // without authority learns nothing from the 409.
  app.get(LEGACY, async (req, res, next) => {
    try { const tenantId = await authorizeRead(req); assertWorkspaceAlias(req); res.json(await read(req, tenantId)); } catch (err) { next(err); }
  });
  app.put(LEGACY, async (req, res, next) => {
    try { const ctx = await authorizeWrite(req); assertWorkspaceAlias(req); res.json(await put(req, ctx)); } catch (err) { next(err); }
  });
  app.post(`${LEGACY}/enable`, async (req, res, next) => {
    try { const ctx = await authorizeWrite(req); assertWorkspaceAlias(req); res.json(await enable(req, ctx)); } catch (err) { next(err); }
  });
}
