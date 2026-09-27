/**
 * RFC 0103 §D content operations — the ONE module that owns `/v1/content/*`
 * (ADR 0748; the delivery GET moved here from `routes/contentDelivery.ts`, ADR
 * 0064 Phase 3). Major 2 reaches the same handlers through the manifest-derived
 * unversioned rewrite (`middleware/protocolVersion.ts`), so there is one
 * implementation per operation.
 *
 * Every operation is a VIEW of the CMS content kernel (`cms.page` rows via
 * `cmsService`), never a second store:
 *
 *   - tenant = the caller's active tenant; org = that tenant's WORKSPACE ROOT
 *     (`orgId === tenantId`, the shape `ensurePersonalWorkspace` / `createWorkspace`
 *     define), so protocol-authored pages show up in the editor for that workspace.
 *   - authority = the editor's own rules, mapped (ADR 0748 D3): `workspace:read`
 *     to list/read settings, `workspace:write` to author a draft, the admin tier
 *     (`host:members:manage`) to publish or to change live content, refused when
 *     the org's approval gate is on. Translator grants narrow exactly as in the
 *     editor. ADR 0755: decided IN the root org the write lands in (the editor's
 *     `assertOrgScope`, not a tenant-wide union), for a signed principal only, and
 *     after an `owk_` key's declared `content:read` / `content:write`.
 *   - delivery: an authenticated caller reads its own tenant; a credential-less
 *     caller (or a host-minted anonymous session) reads the reserved system site,
 *     byte-for-byte the pre-ADR-0748 behaviour (the RFC 0103 G11 carve-out).
 *
 * Content locales are the HOST-advertised set (`hostContentLocales`), the single
 * source both discovery and negotiation read, so `Content-Language` never names
 * a locale `/.well-known/openwop` does not.
 *
 * @see ../../../docs/adr/0748-rfc0206-protocol-content-ops-and-extended-locales.md
 * @see ../../../../openwop/spec/v1/localized-content.md §B–§F
 */
import type { Express, Request } from 'express';
import { v1 } from '../../middleware/protocolVersion.js';
import { OpenwopError } from '../../types.js';
import { callerSubject, isPersonalTenantId, personalTenantOf, tenantOf } from '../../host/requestSubject.js';
import { assertOrgScope, type Scope } from '../../host/accessControlService.js';
import { credentialAuthority, requireKeyLaneScope, tenantOwnerScopes } from '../../host/protocolAuthorization.js';
import { SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../../host/systemSite.js';
import { LOCALE_RE, hostContentLocales, hostDefaultLocale } from '../../host/i18n/index.js';
import {
  PROTOCOL_CONTENT_ID_RE,
  createProtocolPage,
  deletePage,
  getContentLanguageSettings,
  getPage,
  getLocaleGrant,
  getPublishedBySlug,
  listPages,
  localizePage,
  toProtocolSectionId,
  transitionPage,
  upsertProtocolSection,
  type ContentLanguageSettings,
  type Page,
  type Section,
} from './cmsService.js';
import { isApprovalGateOn, liveEditGateActive } from './contentApproval.js';

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** The protocol's two publication states. `in_review` and `archived` are not
 *  delivered, so they project as `draft` (the state that "MUST NOT be served"). */
function protocolStatus(page: Page): 'draft' | 'published' {
  return page.status === 'published' ? 'published' : 'draft';
}

/** `localized-content-page.schema.json`. */
function toProtocolPage(page: Page): Record<string, unknown> {
  return {
    pageId: page.pageId,
    slug: page.slug,
    name: page.title,
    status: protocolStatus(page),
    sectionOrder: page.sections.map((s) => toProtocolSectionId(s.sectionId)),
  };
}

/** `localized-content-section.schema.json`. */
function toProtocolSection(page: Page, section: Section): Record<string, unknown> {
  return {
    sectionId: toProtocolSectionId(section.sectionId),
    sectionType: section.type,
    data: section.data,
    localizations: section.localizations ?? {},
    status: protocolStatus(page),
    enabled: true,
    order: page.sections.findIndex((s) => s.sectionId === section.sectionId),
  };
}

/** The caller's content scope: its active tenant and that tenant's workspace-root org. */
function contentScope(req: Request): { tenantId: string; orgId: string; actor: string } {
  const tenantId = tenantOf(req);
  return { tenantId, orgId: tenantId, actor: callerSubject(req) ?? 'protocol' };
}

/** Most unknown field names a 400 echoes back, and the longest each may be. */
const MAX_ECHOED_FIELDS = 8;
const MAX_ECHOED_FIELD_CHARS = 64;

/**
 * ADR 0755 (WIT-CNT-2/3) — the admin ops' authority, one predicate for all four.
 *
 *   1. The wildcard operator principal (env API key / conformance harness) acts
 *      on any tenant — the same escape hatch `requireTenantScope` honoured. A
 *      TENANT-PINNED env key is its tenant's own principal, and an `owk_` key
 *      carries its issuer's authority (ADR 0601 C4; ADR 0748 correction).
 *   2. A credential-less or host-minted ANONYMOUS session is refused 401. It used
 *      to pass: `requireTenantScope` treats an `anon:` tenant as the caller's own
 *      personal workspace, so a header-less POST authored (and published) pages,
 *      where the editor refuses the same caller (`resolveCallerUser`).
 *   3. The scope is checked IN THE ORG THE OPERATION TOUCHES (`orgId === tenantId`,
 *      `contentScope`) with the editor's own predicate. The tenant-wide union let
 *      a sub-org admin who is only a viewer at the root publish root pages.
 */
async function authorizeContent(req: Request, scope: Scope): Promise<void> {
  if (req.principal?.tenants?.includes('*')) return;
  if (!req.principal || req.anonymousPrincipal === true) {
    throw new OpenwopError('unauthenticated', 'Content administration requires a signed-in principal.', 401, { reason: 'anonymous_principal_refused' });
  }
  const tenantId = tenantOf(req);
  // Authority by PROVENANCE, not by the id string — the classification the MCP
  // lane uses (`credentialAuthority`, ADR 0601 C4), which this gate had ignored:
  // it 403'd the production certify binding (ADR 0748 correction). A tenant-
  // pinned env key is its tenant's own principal; an `owk_` key is its ISSUER,
  // re-read now (an issuer removed since mint holds nothing), and was already
  // narrowed to its declared `content:*` by `requireKeyLaneScope`.
  const authority = credentialAuthority(req.principal, callerSubject(req));
  if (authority.source === 'tenant-owner') {
    if ((await tenantOwnerScopes(tenantId)).includes(scope)) return;
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  const subject = authority.subject;
  if (!subject) throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  // The caller's own personal workspace is single-principal by construction —
  // the implicit owner, whether or not its root org row has been provisioned yet
  // (the same short-circuit `assertOrgScope` applies after its existence check).
  if (personalTenantOf(req) === tenantId && isPersonalTenantId(tenantId)) return;
  try {
    await assertOrgScope(tenantId, subject, tenantId, scope);
  } catch (err) {
    // A tenant with no root org grants nobody content authority; the protocol
    // caller addressed no org, so that is a scope refusal, not "org not found".
    if (err instanceof OpenwopError && err.code === 'not_found') {
      throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
    }
    throw err;
  }
}

/**
 * The content base locale IS the advertised `content.baseLocale`. An org whose
 * stored base differs holds its `data` in another language, so writing the
 * protocol's base axis there would file text under the wrong locale — refuse.
 */
async function assertBaseAligned(tenantId: string, orgId: string): Promise<string> {
  const base = hostDefaultLocale();
  const settings = await getContentLanguageSettings(tenantId, orgId);
  if (settings.baseLocale !== base) {
    throw new OpenwopError(
      'conflict',
      `This workspace authors content in \`${settings.baseLocale}\`, but this host's content base locale is \`${base}\`.`,
      409,
      { baseLocale: settings.baseLocale, contentBaseLocale: base },
    );
  }
  return base;
}

export function registerContentProtocolRoutes(app: Express): void {
  // ── Delivery (§D public; published-only, negotiated) ──────────────────────
  app.get(v1('/content/pages/:slug'), async (req, res, next) => {
    try {
      const slug = req.params.slug;
      if (!SLUG_RE.test(slug)) {
        throw new OpenwopError('validation_error', 'Invalid slug format.', 400, { slug });
      }
      // `isCredentialOptionalRead` (middleware/auth.ts) lets a credential-less
      // request through with NO principal; anything else was authenticated.
      const authenticated = req.principal !== undefined && req.anonymousPrincipal !== true;
      const tenantId = authenticated ? tenantOf(req) : SYSTEM_SITE_TENANT;
      const orgId = authenticated ? tenantId : SYSTEM_SITE_ORG;
      // §F: a slug absent for the RESOLVED tenant is the same 404 as one that
      // exists nowhere — the lookup is keyed by tenant, so there is no other branch.
      const hit = await getPublishedBySlug(tenantId, orgId, slug);
      if (!hit) throw new OpenwopError('not_found', 'No published content at that slug.', 404, { slug });

      const baseLocale = hostDefaultLocale();
      const settings: ContentLanguageSettings = {
        tenantId,
        orgId,
        baseLocale,
        supportedLocales: hostContentLocales(),
        autoTranslateOnPublish: false,
        updatedAt: '',
        updatedBy: 'system',
      };
      const { page, locale } = localizePage(hit.page, req.headers['accept-language'], settings);

      res.setHeader('Content-Language', locale);
      // ADR 0755 (WIT-CNT-9) — `res.vary` APPENDS: `setHeader` replaced the CORS
      // middleware's `Vary: Origin`, letting a cache replay one origin's
      // `Access-Control-Allow-Origin` to another. And the SHARED-cacheable public
      // answer varies on the credential too: the same URL answers a signed-in
      // caller from its own tenant, so a cache must not hand it the system site.
      res.vary('Accept-Language');
      res.vary('Accept-Encoding');
      res.vary('Authorization');
      res.vary('Cookie');
      if (authenticated) {
        // A tenant's content is not the public lane (§F tenant scoping).
        res.setHeader('Cache-Control', 'private, no-store');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      }
      // `localized-content-page-response.schema.json` — closed at every level.
      res.json({
        version: '1',
        generatedAt: new Date().toISOString(),
        locale,
        slug: page.slug,
        page: { pageId: page.pageId, slug: page.slug, name: page.title },
        sections: page.sections.map((s) => ({
          sectionId: toProtocolSectionId(s.sectionId),
          sectionType: s.type,
          data: s.data,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Admin (§D; tenant-scoped, authenticated — never on the optional-auth carve-out) ──
  app.get(v1('/content/pages'), async (req, res, next) => {
    try {
      requireKeyLaneScope(req, 'content:read');
      await authorizeContent(req, 'workspace:read');
      const { tenantId, orgId } = contentScope(req);
      res.json((await listPages(tenantId, orgId)).map(toProtocolPage));
    } catch (err) {
      next(err);
    }
  });

  app.post(v1('/content/pages'), async (req, res, next) => {
    try {
      requireKeyLaneScope(req, 'content:write');
      await authorizeContent(req, 'workspace:write');
      const { tenantId, orgId, actor } = contentScope(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const publish = body.status === 'published';
      if (body.status !== undefined && body.status !== 'draft' && !publish) {
        throw new OpenwopError('validation_error', '`status` must be "draft" or "published".', 400, { field: 'status' });
      }
      // ADR 0205 D1 — a translator grant covers locale overlays only.
      if (await getLocaleGrant(tenantId, orgId, actor)) {
        throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only.', 403, {});
      }
      if (publish) {
        // The editor's direct-publish rule, verbatim: admin tier, and never a
        // bypass of an org that gates publishing on review.
        await authorizeContent(req, 'host:members:manage');
        if (await isApprovalGateOn(tenantId)) {
          throw new OpenwopError('conflict', 'Publishing is gated on approval — create the page as a draft and submit it for review.', 409, { gate: 'cms-approval-gate' });
        }
      }
      const baseLocale = await assertBaseAligned(tenantId, orgId);
      let page = await createProtocolPage({
        tenantId, orgId,
        pageId: body.pageId, slug: body.slug, name: body.name, sectionOrder: body.sectionOrder,
        createdBy: actor, baseLocale,
      });
      // Two writes, ordered so a failure between them leaves an UNPUBLISHED page.
      if (publish) page = (await transitionPage(tenantId, orgId, page.pageId, 'publish', actor)) ?? page;
      res.status(201).json(toProtocolPage(page));
    } catch (err) {
      next(err);
    }
  });

  app.put(v1('/content/pages/:pageId/sections/:sectionId'), async (req, res, next) => {
    try {
      requireKeyLaneScope(req, 'content:write');
      await authorizeContent(req, 'workspace:write');
      const { tenantId, orgId, actor } = contentScope(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const extra = Object.keys(body).filter((k) => k !== 'locale' && k !== 'data');
      if (extra.length > 0) {
        // Bounded echo (ADR 0755, WIT-CNT-13): the names are caller-chosen, and a
        // 1 MB body of keys must not come back as a 1 MB error.
        const echoed = extra.slice(0, MAX_ECHOED_FIELDS).map((k) => (k.length > MAX_ECHOED_FIELD_CHARS ? `${k.slice(0, MAX_ECHOED_FIELD_CHARS)}…` : k));
        const more = extra.length - echoed.length;
        throw new OpenwopError('validation_error', `Unexpected field(s): ${echoed.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}.`, 400, { fields: echoed, ...(more > 0 ? { omitted: more } : {}) });
      }
      const locale = typeof body.locale === 'string' ? body.locale : '';
      if (!LOCALE_RE.test(locale)) {
        throw new OpenwopError('validation_error', 'Invalid `locale` (a case-canonical BCP 47 tag, e.g. "es", "pt-BR", "zh-Hant", "es-419").', 400, { field: 'locale' });
      }
      if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
        throw new OpenwopError('validation_error', '`data` must be an object.', 400, { field: 'data' });
      }
      const baseLocale = await assertBaseAligned(tenantId, orgId);
      const grant = await getLocaleGrant(tenantId, orgId, actor);
      if (grant && (locale === baseLocale || !grant.locales.includes(locale))) {
        throw new OpenwopError('forbidden_scope', `Your translator grant is limited to [${grant.locales.join(', ')}] locale overlays.`, 403, { grantedLocales: grant.locales });
      }
      const result = await upsertProtocolSection({
        tenantId, orgId,
        pageId: req.params.pageId,
        sectionId: req.params.sectionId,
        locale,
        data: body.data as Record<string, unknown>,
        baseLocale,
        actor,
        // Decided on the row being written (re-run on the retry): the editor's
        // PATCH rule — drafts are editor-tier, anything else admin-tier, and a
        // published page is refused while the org gates publishing on review.
        authorize: async (page) => {
          if (page.status === 'draft') return;
          await authorizeContent(req, 'host:members:manage');
          if (page.status === 'published' && await liveEditGateActive(tenantId, orgId)) {
            throw new OpenwopError('conflict', 'Publishing is gated on approval — unpublish this page before editing it, then submit it for review.', 409, { gate: 'cms-approval-gate', status: page.status });
          }
        },
      });
      if (!result) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(toProtocolSection(result.page, result.section));
    } catch (err) {
      next(err);
    }
  });

  // `deleteContentPage` (openwop#1634, suite 2.42.2). Shares the `{slug}` path
  // item with delivery, but the segment is the page's `pageId` here — which the
  // route param name says. Only `GET|HEAD` of this shape is credential-optional
  // (`isCredentialOptionalRead`), so a DELETE is authenticated like every admin op.
  //
  // Authority (ADR 0748 correction 2026-09-27, /architect):
  //   - `content:write` on the key lane, then `workspace:write` in the root org —
  //     the create/put pair — and the translator refusal create applies.
  //   - a page that is not a draft is LIVE (or under review / archived): removing
  //     it is at least an unpublish, which is admin tier (`host:members:manage`),
  //     so the same tier applies here.
  //   - NOT the approval gate. The gate stops content going live without review;
  //     taking content down is the fail-safe direction, which is why unpublish,
  //     archive and schedule-unpublish are ungated too.
  // `deletePage` owns the cascades (versions, redirects, share links, comment
  // threads, usage, the lifecycle seam, a pending review closed as superseded)
  // and runs the status-tier decision on the row it deletes.
  app.delete(v1('/content/pages/:pageId'), async (req, res, next) => {
    try {
      requireKeyLaneScope(req, 'content:write');
      await authorizeContent(req, 'workspace:write');
      const { tenantId, orgId, actor } = contentScope(req);
      const pageId = req.params.pageId;
      // §F: a malformed id, one in another tenant, and one in a sibling org are
      // all the same 404 as a page that never existed (`getPage` is tenant+org keyed).
      const page = PROTOCOL_CONTENT_ID_RE.test(pageId) ? await getPage(tenantId, orgId, pageId) : null;
      if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId });
      if (await getLocaleGrant(tenantId, orgId, actor)) {
        throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only.', 403, {});
      }
      // Decided on the row `deletePage` is about to remove (no earlier read).
      const authorize = async (row: Page): Promise<void> => {
        if (row.status !== 'draft') await authorizeContent(req, 'host:members:manage');
      };
      if (!(await deletePage(tenantId, orgId, pageId, { authorize }))) {
        throw new OpenwopError('not_found', 'Page not found.', 404, { pageId });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.get(v1('/content/settings'), async (req, res, next) => {
    try {
      requireKeyLaneScope(req, 'content:read');
      await authorizeContent(req, 'workspace:read');
      const { tenantId, orgId } = contentScope(req);
      const stored = await getContentLanguageSettings(tenantId, orgId);
      // The EFFECTIVE settings — what delivery negotiates over — so the
      // language-settings schema's "the advertisement MUST reflect it" holds by
      // construction. The org's own locale list is editor configuration; the
      // protocol lane serves the host-advertised set.
      res.json({
        baseLocale: hostDefaultLocale(),
        supportedLocales: hostContentLocales(),
        autoTranslateOnPublish: stored.autoTranslateOnPublish,
      });
    } catch (err) {
      next(err);
    }
  });
}
