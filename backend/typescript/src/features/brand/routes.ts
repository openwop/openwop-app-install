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
import { putBrandFont, listBrandFonts, deleteBrandFont, BRAND_FONT_ROLES, type BrandFontRole } from './brandFonts.js';
import { BRAND_CHANNELS, type Brand } from './types.js';
import {
  listBrands, getBrand, createBrand, updateBrand, deleteBrand, listBrandAudit, sanitizeGovernance,} from './brandService.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/**
 * The org-scope predicate the routes gate on — extracted so the Brand Steward's
 * chat tools (agentTools.ts) share the EXACT same authority as the HTTP routes
 * (CFP-1 hard rule #1: one helper, route + tool both call it). `subject`
 * undefined ⇒ never granted (fail-closed, no anonymous authority).
 */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  return orgScopeGranted(tenantOf(req), actingUserOf(req), orgId, scope);
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

/** R2 BR-SP-4 — GOVERNANCE-FIELD changes carry their own bar, gated on the
 *  POST-image too (the pre-image-only gate let a partial-lock listed editor
 *  demote the lock or rewrite allowedEditors, and let ANY workspace:write
 *  user escalate an unlocked brand to `full`, locking out the org):
 *  touching lockLevel / allowedEditors / requireApproval / compliance
 *  requires ORG-ADMIN, with one exception — the brand's CREATOR may set the
 *  initial lock on a brand whose lock is still `none` (round-1's
 *  self-governance flow stays). Content edits by listed editors untouched. */
export function governanceChanged(existing: Brand, input: { governance?: unknown }): boolean {
  if (input.governance === undefined) return false;
  // Review-caught BYPASS: a raw field-presence diff let absent fields slip
  // the gate while sanitizeGovernance DEFAULTS them (absent lockLevel →
  // 'none', absent allowedEditors → [], absent requireApproval → false,
  // compliance dropped) — so `{governance:{lockLevel:'partial'}}` (the old
  // editor's exact payload) silently stripped every editor and disarmed
  // compliance without tripping the gate, and `{governance:{}}` UNLOCKED the
  // brand outright. Compare what will actually be STORED: the sanitized
  // post-image vs the current row (editors order-normalized; a null/garbage
  // governance sanitizes to the defaults and diffs like any other change —
  // no 500, and the gate decides).
  const next = sanitizeGovernance(input.governance);
  const cur = existing.governance;
  const norm = (g: Brand['governance']): string => JSON.stringify({
    lockLevel: g.lockLevel,
    allowedEditors: [...g.allowedEditors].sort(),
    requireApproval: g.requireApproval,
    compliance: g.compliance ?? null,
  });
  return norm(next) !== norm(cur);
}

async function requireGovernanceChangeAuthority(req: Request, brand: Brand): Promise<void> {
  const isOrgAdmin = await hasOrgScope(req, brand.orgId, 'host:org:manage');
  if (isOrgAdmin) return;
  const actor = actingUserOf(req);
  if (brand.governance.lockLevel === 'none' && actor && brand.createdBy === actor) return; // creator sets the initial lock
  throw new OpenwopError('forbidden_scope', 'Changing a brand\'s governance (lock, editors, approval, compliance) requires an org admin.', 403, { requiredScope: 'host:org:manage' });
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
      const body = (req.body ?? {}) as Record<string, unknown> & { governance?: unknown; expectedUpdatedAt?: unknown };
      // Review F3 — the CAS conflict outranks the governance gate: a STALE
      // editor whose governance echo mismatches the current row deserves the
      // 409 reload story, not a misleading "requires an org admin".
      if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt !== brand.updatedAt) {
        throw new OpenwopError('conflict', 'This brand changed since you opened it — reload and reapply your edits.', 409, { brandId: brand.id, expected: body.expectedUpdatedAt, actual: brand.updatedAt });
      }
      if (governanceChanged(brand, body)) await requireGovernanceChangeAuthority(req, brand);
      // BRAND-CODE-3 — audit the REAL actor, not the 'editor' default.
      const updated = await updateBrand(tenantOf(req), brand.id, body as unknown as Parameters<typeof updateBrand>[2], actingUserOf(req) ?? 'editor');
      if (!updated) throw new OpenwopError('not_found', 'Brand not found.', 404, { brandId: brand.id });
      res.json({ brand: updated });
    } catch (err) { next(err); }
  });

  // ADR 0354 P5 — the guardrail-change audit trail (read-only; same read gate
  // as the brand GET — brandFor 404s cross-tenant uniformly).
  app.get(`${BASE}/brands/:brandId/audit`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:read');
      res.json({ audit: await listBrandAudit(tenantOf(req), brand.id) });
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

  // ── ADR 0399 OQ-1 — brand custom fonts (governance-gated, attested) ────────
  const roleFrom = (raw: string): BrandFontRole => {
    if (!(BRAND_FONT_ROLES as readonly string[]).includes(raw)) {
      throw new OpenwopError('validation_error', `\`role\` must be one of: ${BRAND_FONT_ROLES.join(', ')}.`, 400, { field: 'role' });
    }
    return raw as BrandFontRole;
  };

  app.get(`${BASE}/brands/:brandId/fonts`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:read');
      res.json({ fonts: await listBrandFonts(tenantOf(req), brand.id) });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/brands/:brandId/fonts/:role`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:write');
      await requireGovernanceAuthority(req, brand);
      const role = roleFrom(req.params.role);
      const body = (req.body ?? {}) as { contentBase64?: unknown; licenseAttested?: unknown };
      const font = await putBrandFont({
        tenantId: tenantOf(req), brandId: brand.id, role,
        contentBase64: body.contentBase64, licenseAttested: body.licenseAttested,
        attestedBy: actingUserOf(req) ?? 'editor',
      });
      // The BrandFont row itself IS the durable attestation trail (attestedBy,
      // family, sha, createdAt) — survives until brand delete; no brand:audit
      // shoehorn needed (its rows are Brand-field diffs).
      res.status(201).json({ font });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/brands/:brandId/fonts/:role`, async (req, res, next) => {
    try {
      const brand = await loadBrandScoped(req, 'workspace:write');
      await requireGovernanceAuthority(req, brand);
      const role = roleFrom(req.params.role);
      const ok = await deleteBrandFont(tenantOf(req), brand.id, role);
      if (!ok) throw new OpenwopError('not_found', 'No custom font for that role.', 404, { role });
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
