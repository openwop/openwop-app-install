/**
 * Brand routes (ADR 0155) — host-extension under /v1/host/openwop-app/brand/*.
 *
 * Gating order, fail-closed (ADR 0006), mirroring the priority-matrix per-entity
 * org gate so a brand can't be read/mutated across orgs. Brand is **always-on/core**
 * (ADR 0170) — there is NO feature-toggle gate; the RBAC + governance gates ARE the
 * authority:
 *   1. RBAC IN THE BRAND'S ORG — read ops need workspace:read in `brand.orgId`
 *      (a caller without it gets a uniform 404, no existence leak); write ops
 *      additionally need workspace:write there.
 *   2. GOVERNANCE AUTHORITY — `brand.governance.lockLevel` raises the write bar:
 *      'full'   → org admin (`host:org:manage`) only;
 *      'partial'→ the brand creator, a listed `allowedEditors` member, or an org admin;
 *      'none'   → plain workspace:write.
 *
 * Governance maps onto accessControl (RFC 0049) — NOT a parallel ACL.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireString } from '../featureRoute.js';
import { BRAND_CHANNELS, type Brand } from './types.js';
import {
  listBrands, getBrand, createBrand, updateBrand, deleteBrand,
} from './brandService.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}

async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/**
 * Load a brand + gate on the caller's scope IN THE BRAND'S ORG. No-existence-leak:
 * a caller without `workspace:read` in the brand's org gets a uniform 404. A WRITE
 * op missing write → 403.
 */
async function loadBrandScoped(req: Request, scope: Scope): Promise<Brand> {
  const brand = await getBrand(tenantOf(req), req.params.brandId);
  if (!brand || !(await hasOrgScope(req, brand.orgId, 'workspace:read'))) {
    throw new OpenwopError('not_found', 'Brand not found.', 404, { brandId: req.params.brandId });
  }
  if (scope !== 'workspace:read') await requireOrgScopeFor(req, brand.orgId, scope);
  return brand;
}

/** ADR 0155 §governance — the elevated write bar a brand's lockLevel imposes,
 *  resolved against accessControl. Called after the base workspace:write gate. */
async function requireGovernanceAuthority(req: Request, brand: Brand): Promise<void> {
  const actor = actingUserOf(req);
  const isOrgAdmin = await hasOrgScope(req, brand.orgId, 'host:org:manage');
  switch (brand.governance.lockLevel) {
    case 'full':
      if (!isOrgAdmin) {
        throw new OpenwopError('forbidden_scope', 'This brand is locked — only an org admin may edit it.', 403, { requiredScope: 'host:org:manage', lockLevel: 'full' });
      }
      return;
    case 'partial':
      if (isOrgAdmin) return;
      if (actor && brand.createdBy === actor) return;
      if (actor && brand.governance.allowedEditors.includes(actor)) return;
      throw new OpenwopError('forbidden_scope', 'This brand restricts editing — you must be the creator, a listed editor, or an org admin.', 403, { lockLevel: 'partial' });
    default:
      return; // 'none' — base workspace:write already enforced
  }
}

/** The brands in the caller's workspace they can READ (per-org readability filter). */
async function readableBrands(req: Request, orgId?: string): Promise<Brand[]> {
  const all = await listBrands(tenantOf(req), orgId);
  const readable = new Map<string, boolean>();
  const out: Brand[] = [];
  for (const b of all) {
    let ok = readable.get(b.orgId);
    if (ok === undefined) { ok = await hasOrgScope(req, b.orgId, 'workspace:read'); readable.set(b.orgId, ok); }
    if (ok) out.push(b);
  }
  return out;
}

export function registerBrandRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/brand';

  // ── static channel vocabulary (any authenticated member) ──
  app.get(`${BASE}/channels`, (_req, res) => {
    res.json({ channels: BRAND_CHANNELS });
  });

  // ── list brands (optionally narrowed to one org) ──
  app.get(`${BASE}/brands`, async (req, res, next) => {
    try {
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId.length > 0 ? req.query.orgId : undefined;
      res.json({ brands: await readableBrands(req, orgId) });
    } catch (err) { next(err); }
  });

  // ── create a brand (workspace:write in the target org) ──
  app.post(`${BASE}/brands`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const brand = await createBrand(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', body);
      res.status(201).json({ brand });
    } catch (err) { next(err); }
  });

  // ── get one brand ──
  app.get(`${BASE}/brands/:brandId`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:read');
      res.json({ brand });
    } catch (err) { next(err); }
  });

  // ── update a brand (workspace:write + governance authority) ──
  app.patch(`${BASE}/brands/:brandId`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:write');
      await requireGovernanceAuthority(req, brand);
      const updated = await updateBrand(tenantOf(req), brand.id, (req.body ?? {}) as Record<string, unknown>);
      if (!updated) throw new OpenwopError('not_found', 'Brand not found.', 404, { brandId: brand.id });
      res.json({ brand: updated });
    } catch (err) { next(err); }
  });

  // ── delete a brand (workspace:write + governance authority) ──
  app.delete(`${BASE}/brands/:brandId`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:write');
      await requireGovernanceAuthority(req, brand);
      await deleteBrand(tenantOf(req), brand.id);
      res.json({ deleted: true, brandId: brand.id });
    } catch (err) { next(err); }
  });
}
