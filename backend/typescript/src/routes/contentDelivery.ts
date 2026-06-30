/**
 * RFC 0103 normative public content delivery (ADR 0064 Phase 3) —
 * `GET /v1/content/pages/{slug}`.
 *
 * The reference host projects its reserved SYSTEM-SITE published content into
 * the normative `localized-content-page-response` shape, locale-negotiated from
 * `Accept-Language`. This is the **G11 anonymous-tenant carve-out**: the public
 * `/v1/content/*` path carries no org, so the host resolves the tenant to the
 * system site (`host/systemSite.ts`) — host-defined, never from the request.
 *
 * Published-only (the §F draft-leak guard holds via `getPublishedBySlug`);
 * `Content-Language` reflects the locale used (response-only, not logged);
 * cacheable + `Vary: Accept-Language`. `capabilities.content` is advertised in
 * discovery only when host i18n is configured (advertise-only-when-honored).
 *
 * @see ../../docs/adr/0064-cms-content-localization.md
 * @see ../../../openwop/spec/v1/localized-content.md
 */
import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { getPublishedBySlug, localizePage, type ContentLanguageSettings } from '../features/cms/cmsService.js';
import { SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../host/systemSite.js';
import { hostDefaultLocale, hostSupportedLocales } from '../host/i18n/index.js';

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export function registerContentDeliveryRoutes(app: Express): void {
  app.get('/v1/content/pages/:slug', async (req, res, next) => {
    try {
      const slug = req.params.slug;
      if (!SLUG_RE.test(slug)) {
        throw new OpenwopError('validation_error', 'Invalid slug format.', 400, { slug });
      }
      const hit = await getPublishedBySlug(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, slug);
      if (!hit) throw new OpenwopError('not_found', 'No published content at that slug.', 404, { slug });

      // Negotiate over the HOST-advertised content locales (capabilities.content),
      // NOT the system-site's per-org settings. Discovery is core + anonymous and
      // can't read per-org settings, so the host env (OPENWOP_I18N_LOCALES) is the
      // single source both the advertisement and this delivery honor — keeping the
      // negotiated Content-Language consistent with what /.well-known advertises.
      // Per-section sparse overlays still fall back to base when a locale is absent.
      const baseLocale = hostDefaultLocale();
      const settings: ContentLanguageSettings = {
        tenantId: SYSTEM_SITE_TENANT,
        orgId: SYSTEM_SITE_ORG,
        baseLocale,
        supportedLocales: hostSupportedLocales().filter((l) => l !== baseLocale),
        autoTranslateOnPublish: false,
        updatedAt: '',
        updatedBy: 'system',
      };
      const { page, locale } = localizePage(hit.page, req.headers['accept-language'], settings);

      res.setHeader('Content-Language', locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.json({
        version: '1',
        generatedAt: new Date().toISOString(),
        locale,
        slug: page.slug,
        page: { name: page.title, description: '', seo: {} },
        sections: page.sections.map((s, i) => ({
          sectionId: s.sectionId,
          sectionType: s.type,
          data: s.data,
          order: i,
        })),
      });
    } catch (err) {
      next(err);
    }
  });
}
