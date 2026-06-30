/**
 * App-brand host-extension routes (ADR 0170) — the white-label visual identity for
 * this installation. The CONTENT is the reserved `brand:host-app` record
 * (`host/systemBrand.ts`), edited by a SUPER ADMIN (host-level authority, NOT
 * org-scoped RBAC) — it drives `brandService` on a brand no real tenant owns, so
 * every real tenant's isolation is untouched.
 *
 *   GET /v1/host/openwop-app/public-brand   the app identity (anonymous SPA)   [PUBLIC]
 *   GET /v1/host/openwop-app/app-brand      the full app brand (admin read)    [superadmin]
 *   PUT /v1/host/openwop-app/app-brand      edit name/identity                 [superadmin]
 *
 * `/public-brand` is on PUBLIC_PATH_PREFIXES because the logo/title/theme render on
 * the unauthenticated shell + gate (before login). It is hardwired to the reserved
 * id (no id/slug param), so a tenant marketing brand can never be enumerated or
 * served, and it exposes ONLY the identity subset — never the voice profile,
 * governance editor list, or createdBy. ETag + a short cache keep the per-cold-load
 * read cheap (it is read by every anonymous visitor).
 */
import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { requireSuperadmin } from '../host/superadmin.js';
import { getAppBrand, editAppBrand } from '../host/systemBrand.js';
import type { BrandIdentity } from '../features/brand/types.js';

/** Weak ETag over the public identity payload — busts whenever an edit changes it. */
function identityEtag(identity: BrandIdentity | undefined): string {
  const h = createHash('sha256').update(JSON.stringify(identity ?? {})).digest('base64').slice(0, 16);
  return `W/"brand-${h}"`;
}

export function registerAppBrandRoutes(app: Express): void {
  // ── PUBLIC: the app identity the anonymous SPA applies at load (pre-auth) ──
  // Hardwired to the reserved app brand — NO id param, identity subset only.
  app.get('/v1/host/openwop-app/public-brand', async (_req, res, next) => {
    try {
      const brand = await getAppBrand();
      const identity = brand.identity ?? {};
      const etag = identityEtag(brand.identity);
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
      res.setHeader('ETag', etag);
      if (_req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
      res.json({ identity });
    } catch (err) { next(err); }
  });

  // ── ADMIN (superadmin): read the full app brand (working copy for the editor) ──
  app.get('/v1/host/openwop-app/app-brand', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'App-brand editing');
      res.json({ brand: await getAppBrand() });
    } catch (err) { next(err); }
  });

  // ── ADMIN (superadmin): edit the app brand identity (+ name/description) ──
  app.put('/v1/host/openwop-app/app-brand', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'App-brand editing');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; identity?: unknown };
      // brandService.sanitizeIdentity validates colors/fonts/assets (CSS-injection +
      // dangerous-scheme guards) — the route passes the raw value through untrusted.
      const patch: { name?: unknown; description?: unknown; identity?: unknown } = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.identity !== undefined) patch.identity = body.identity;
      const brand = await editAppBrand(patch, req.principal?.principalId ?? 'superadmin');
      res.json({ brand });
    } catch (err) { next(err); }
  });
}
