/**
 * CMS workflow surface (ADR 0014 / ADR 0064 Phase 3) — `ctx.features.cms`, the
 * typed surface a workflow node calls to READ localized content. Tenant comes
 * from the run scope; reads are org-scoped + published-only (the §F public-
 * delivery guard), so a workflow can fetch a page resolved for a target locale
 * exactly as the public delivery surface does.
 *
 * Reads are read-only by design (AI translation stays in the `feature.cms.nodes`
 * translate node — provider is run-scoped, the "generate in-run" rule, ADR 0064).
 * The ONE write — `createDraftPage` (ADR 0162) — delegates to `cmsService.createPage`,
 * which hard-codes `status:'draft'`; the surface never publishes, so a generated page
 * always passes a human gate before going live. Tenant comes from the run scope (never
 * args) — the cross-tenant isolation guard; org is node-supplied (the service enforces
 * the tenant+org key, the same posture as every other write surface).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { getContentLanguageSettings, getLocaleGrant, getPage as getStoredPage, getPublishedBySlug, listPages, createPage, localizePage, sanitizeSectionOverlay, transitionPage, updatePage, type SectionType, SECTION_TYPES } from './cmsService.js';
import { queueContentApproval } from './contentApproval.js';

export function buildCmsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;

  return {
    // Create a DRAFT page (ADR 0162) from a Campaign Studio landing-page draft. The
    // service sanitizes every section + enforces slug uniqueness; status is 'draft'
    // (never published here). Idempotent on a deterministic `pageId` so a node
    // replay/fork returns the same page rather than duplicating it.
    createDraftPage: async (args) => {
      // ADR 0205 CMSGAP-1 — a translator grant is overlay-only on every path;
      // page creation authors base content.
      if (scope.actingUserId && (await getLocaleGrant(tenantId, str(args.orgId), scope.actingUserId))) {
        throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only.', 403, {});
      }
      const slug = optStr(args.slug);
      const pageId = optStr(args.pageId);
      const page = await createPage({
        tenantId,
        orgId: str(args.orgId),
        title: str(args.title) || 'Untitled campaign page',
        sections: args.sections,
        createdBy: scope.runId ?? 'workflow',
        ...(slug ? { slug } : {}),
        ...(pageId ? { pageId } : {}),
      });
      return { pageId: page.pageId, slug: page.slug, status: page.status, title: page.title };
    },

    // A DRAFT/in-review page's RAW sections (base data + overlay locales) so a
    // workflow can edit-then-submit (ADR 0204 C6). A tenant-scoped run reads
    // like an org member with `workspace:read` — members already see drafts;
    // the §F guard protects ANONYMOUS delivery, which stays published-only.
    getDraftPage: async (args) => {
      const page = await getStoredPage(tenantId, str(args.orgId), str(args.pageId));
      if (!page) return { page: null };
      return {
        page: {
          pageId: page.pageId,
          slug: page.slug,
          title: page.title,
          status: page.status,
          sections: page.sections.map((s) => ({
            sectionId: s.sectionId,
            sectionType: s.type,
            data: s.data,
            locales: Object.keys(s.localizations ?? {}),
          })),
        },
      };
    },

    // ── Governed write verbs (ADR 0204 C6) ──────────────────────────────────
    // Draft-only + submit-only, per the uniform write-surface policy (commerce
    // createOrder, documents createDraftDocument, email createDraftCampaign):
    // a node can DRAFT and SUBMIT; it can NEVER publish — publish stays a human
    // action (route or ApprovalsInbox). `publish-page` was explicitly REJECTED
    // by the Phase-C architecture review.

    // Overlay a DRAFT page's section with a per-locale translation (or patch
    // its base data). Draft-only — mirrors the route-level "editors edit
    // drafts" gate; sanitized through the SAME overlay cleaner as any save.
    updateSectionDraft: async (args) => {
      const orgId = str(args.orgId);
      const pageId = str(args.pageId);
      const sectionId = str(args.sectionId);
      const locale = optStr(args.locale);
      // ADR 0205 CMSGAP-1 — the run owner's translator grant applies HERE too:
      // a granted member driving this verb through a workflow is narrowed to
      // their locales' overlays, exactly as on the HTTP editor path. System
      // runs (no actingUserId) carry no member identity ⇒ no grant ⇒ unchanged.
      if (scope.actingUserId) {
        const grant = await getLocaleGrant(tenantId, orgId, scope.actingUserId);
        if (grant && (!locale || !grant.locales.includes(locale))) {
          throw new OpenwopError('forbidden_scope', `Your translator grant is limited to [${grant.locales.join(', ')}] locale overlays.`, 403, { grantedLocales: grant.locales });
        }
      }
      // ADR 0592 §1 (CMSL-1) — this verb is a read-modify-write over the FULL
      // sections array, so it is version-PINNED like an editor save: without
      // the pin, an overlay a human wrote inside the read→write window was
      // silently clobbered. On a conflict the whole read+checks+apply runs
      // ONCE more against the fresh page (bounded retry); a second conflict
      // propagates as the typed 409 (fail honest, never fail silent).
      for (let attempt = 0; ; attempt += 1) {
        const page = await getStoredPage(tenantId, orgId, pageId);
        if (!page) return { updated: false, reason: 'not_found' };
        if (page.status !== 'draft') {
          throw new OpenwopError('validation_error', `Only DRAFT pages are node-editable (status: \`${page.status}\`).`, 409, { status: page.status });
        }
        const section = page.sections.find((s) => s.sectionId === sectionId);
        if (!section || !SECTION_TYPES.includes(section.type as SectionType)) return { updated: false, reason: 'section_not_found' };
        const raw = (typeof args.data === 'object' && args.data !== null ? args.data : {}) as Record<string, unknown>;
        const cleaned = sanitizeSectionOverlay(section.type, raw);
        if (Object.keys(cleaned).length === 0) return { updated: false, reason: 'empty' };
        const settings = await getContentLanguageSettings(tenantId, orgId);
        const sections = page.sections.map((s) => {
          if (s.sectionId !== sectionId) return s;
          // ADR 0592 §3 — a run/agent-written locale overlay is MACHINE-drafted
          // (no human typed it): stamp durable provenance at the writer so the
          // reviewer can tell it from a human translation. Base-data patches
          // carry no per-locale stamp (the stamp is overlay provenance).
          if (locale) {
            return {
              ...s,
              localizations: { ...(s.localizations ?? {}), [locale]: cleaned },
              aiDrafted: { ...(s.aiDrafted ?? {}), [locale]: new Date().toISOString() },
            };
          }
          return { ...s, data: { ...s.data, ...cleaned } };
        });
        try {
          // Persist through the validated write path (validateSections enforces
          // locale ≠ base + re-sanitizes) — same as an editor save.
          const saved = await updatePage(tenantId, orgId, pageId, { sections, baseLocale: settings.baseLocale }, scope.runId ?? 'workflow', { expectedVersion: page.version });
          return { updated: !!saved, ...(locale ? { locale } : {}) };
        } catch (err) {
          if (attempt === 0 && err instanceof OpenwopError && err.code === 'conflict') continue;
          throw err;
        }
      }
    },

    // Submit a DRAFT for review — the SAME owner as the submit route
    // (queueContentApproval): the shared `content-publish` approval row is queued
    // UNCONDITIONALLY (chat-first-port C1 — ONE decision path); the node NEVER
    // bypasses the human gate. No auto-translate sweep here (a chain translates
    // explicitly).
    submitPage: async (args) => {
      const orgId = str(args.orgId);
      const pageId = str(args.pageId);
      // ADR 0205 CMSGAP-1 — translators cannot transition status, on any path.
      if (scope.actingUserId && (await getLocaleGrant(tenantId, orgId, scope.actingUserId))) {
        throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only — an editor submits the page.', 403, {});
      }
      const updated = await transitionPage(tenantId, orgId, pageId, 'submit', scope.runId ?? 'workflow');
      if (!updated) return { submitted: false, reason: 'not_found' };
      await queueContentApproval(tenantId, orgId, updated, `Publish CMS page "${updated.title}" (submitted by a workflow)`);
      return { submitted: true, status: updated.status, pageId: updated.pageId };
    },

    // Published pages for an org (titles/slugs/status — not section bodies).
    listPages: async (args) => {
      const pages = await listPages(tenantId, str(args.orgId));
      return {
        pages: pages
          .filter((p) => p.status === 'published')
          .map((p) => ({ pageId: p.pageId, slug: p.slug, title: p.title, status: p.status })),
      };
    },

    // A published page resolved for the requested locale (exact → language-family
    // → base, RFC 0103 §C). `locale` defaults to the org's baseLocale. Published-
    // only; sections carry resolved `data` with NO `localizations` leaked.
    //
    // UX_UPGRADE-content R2 (CMS2-B2) — this used to hand-roll the resolution
    // with a bare `resolveSection`, which broke it in two ways at once. It is
    // the ONE delivery path that skipped `localizePage`; every HTTP lane
    // (`routes.ts`, `contentProtocolRoutes.ts`, `publishingService.ts` ×2) goes
    // through it.
    //
    //  - It bypassed the ADR 0205 D2 locale-WITHHOLDING gate. `setLocalePublish
    //    State(…, 'draft')` tells an admin the locale is held back from
    //    delivery — and it was, from anonymous visitors, while models and
    //    chains were served the unreviewed machine translation as the site's
    //    copy. The AI lane was the only consumer reading withheld content.
    //  - It echoed the REQUESTED locale back as the RESOLVED one.
    //    `resolveSection` is total (no match → base payload), and nothing
    //    checked the tag against `supportedLocales`, so asking for `de` on a
    //    page with no German returned `{ locale: 'de', … }` carrying English.
    //    A model reads that as "this page is already translated."
    //
    // `localizePage` does both correctly and returns the locale actually
    // negotiated. Never reintroduce a second resolution path here.
    getPage: async (args) => {
      const orgId = str(args.orgId);
      const slug = str(args.slug);
      const hit = await getPublishedBySlug(tenantId, orgId, slug);
      if (!hit) return { page: null, locale: null };
      const settings = await getContentLanguageSettings(tenantId, orgId);
      const { page, locale } = localizePage(hit.page, optStr(args.locale) ?? null, settings);
      return {
        locale,
        page: {
          slug: page.slug,
          title: page.title,
          sections: page.sections.map((s) => ({
            sectionId: s.sectionId,
            sectionType: s.type,
            data: s.data,
          })),
        },
      };
    },
  };
}
