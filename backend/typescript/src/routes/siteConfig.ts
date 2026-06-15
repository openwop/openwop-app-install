/**
 * Site-config host-extension routes (ADR 0027) — the on/off switch for the public
 * front page. The CONTENT is always the host-level system home page
 * (`host/systemSite.ts`), edited by the super admin via `/v1/host/openwop-app/site-page`.
 *
 *   GET  /v1/host/openwop-app/public-site-config   public front-page pointer   [PUBLIC]
 *   GET  /v1/host/openwop-app/site-config          { enabled } (admin read)    [superadmin]
 *   PUT  /v1/host/openwop-app/site-config          { enabled } (toggle)        [superadmin]
 *
 * The public read is on PUBLIC_PATH_PREFIXES and exposes only the fixed system
 * site pointer `{ enabled, orgId, slug }` — no tenant data, no secrets. The write
 * reuses the feature-toggle superadmin gate. Fails closed.
 */
import type { Express } from 'express';
import { getSiteConfig, setSiteConfig } from '../host/siteConfig/service.js';
import { ensureSystemSite, SYSTEM_SITE_ORG, SYSTEM_SITE_SLUG } from '../host/systemSite.js';
import { requireSuperadmin } from '../host/superadmin.js';

export function registerSiteConfigRoutes(app: Express): void {
  // ── PUBLIC: the front-page pointer the anonymous SPA reads at '/' ──
  app.get('/v1/host/openwop-app/public-site-config', async (_req, res, next) => {
    try {
      const c = await getSiteConfig();
      if (!c.enabled) { res.json({ enabled: false }); return; }
      // Enabled ⇒ ensure the system home page exists (seeds on first call) and
      // return its fixed pointer; the SPA fetches it via the public Publishing API.
      await ensureSystemSite();
      res.json({ enabled: true, orgId: SYSTEM_SITE_ORG, slug: SYSTEM_SITE_SLUG });
    } catch (err) { next(err); }
  });

  // ── ADMIN (superadmin): read the on/off switch ──
  app.get('/v1/host/openwop-app/site-config', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Site configuration');
      res.json(await getSiteConfig());
    } catch (err) { next(err); }
  });

  // ── ADMIN (superadmin): toggle the front page on/off ──
  app.put('/v1/host/openwop-app/site-config', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Site configuration');
      const body = (req.body ?? {}) as { enabled?: unknown };
      const subject = req.principal?.principalId ?? req.tenantId ?? 'superadmin';
      res.json(await setSiteConfig({ enabled: body.enabled === true }, subject));
    } catch (err) { next(err); }
  });
}
