/**
 * CMS routes (ADR 0009) — host-extension, best-effort. Org-scoped under
 * /v1/host/openwop-app/cms/orgs/:orgId, gated by the shared `requireOrgScope` (ADR
 * 0027: CMS is always-on, so no toggle gate — the org-scoped RBAC remains):
 *   read (list/get/versions/by-slug)        → workspace:read
 *   content edits (create/patch/delete) + submit → workspace:write
 *   editorial approve/reject/publish/archive/restore → host:members:manage
 * Tenant+org IDOR-guarded throughout.
 *
 * @see docs/adr/0009-cms-page-builder.md
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, requireFeatureEnabled, requireString, optionalString } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createContentApproval, hasPendingApprovalForPage, rejectPendingApprovalForPage } from '../../host/approvalService.js';
import { LOCALE_RE } from '../../host/i18n/index.js';
import { translateSectionData } from './translate.js';
import { ManagedProviderError } from '../../providers/managedProvider.js';
import {
  createPage,
  deletePage,
  getContentLanguageSettings,
  getPage,
  getPublishedBySlug,
  listPages,
  localizePage,
  listVersions,
  restoreVersion,
  transitionPage,
  updateContentLanguageSettings,
  updatePage,
  SECTION_TYPES,
  type SectionType,
  type WorkflowAction,
} from './cmsService.js';

export function registerCmsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/cms/orgs/:orgId';

  // ── Reads ──
  app.get(`${BASE}/pages`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      res.json({ pages: await listPages(user.tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  // by-slug MUST precede /pages/:pageId (else 'by-slug' is captured as :pageId).
  app.get(`${BASE}/pages/by-slug/:slug`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      const hit = await getPublishedBySlug(user.tenantId, orgId, req.params.slug);
      if (!hit) throw new OpenwopError('not_found', 'No published page at that slug.', 404, { slug: req.params.slug });
      // ADR 0064 — resolve sections for the locale negotiated from Accept-Language
      // (published-only is already enforced upstream). When the org has authored
      // no locales this returns base `data` verbatim (byte-identical). The
      // negotiated locale is a RESPONSE concern only — set on Content-Language,
      // never written to any log/event (RFC 0103 §F).
      const settings = await getContentLanguageSettings(user.tenantId, orgId);
      const { page, locale } = localizePage(hit.page, req.headers['accept-language'], settings);
      res.setHeader('Content-Language', locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      res.json({ ...hit, page });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/pages/:pageId/versions`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      res.json({ versions: await listVersions(user.tenantId, orgId, req.params.pageId) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      const page = await getPage(user.tenantId, orgId, req.params.pageId);
      if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  // ── Content edits (workspace:write) ──
  app.post(`${BASE}/pages`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:write');
      const body = (req.body ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown };
      const settings = await getContentLanguageSettings(user.tenantId, orgId);
      const page = await createPage({
        tenantId: user.tenantId,
        orgId,
        title: requireString(body.title, 'title'),
        ...(optionalString(body.slug) ? { slug: String(body.slug) } : {}),
        sections: body.sections,
        createdBy: user.userId,
        baseLocale: settings.baseLocale,
      });
      res.status(201).json(page);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:write');
      // Editorial gate (code-review #1): editors may only edit DRAFTS. Editing a
      // page that is live/under-review/archived changes content outside the
      // review flow, so it requires the admin tier — editors must `unpublish`
      // (→ draft) first. Re-authorize for the admin scope when not a draft.
      const current = await getPage(user.tenantId, orgId, req.params.pageId);
      if (!current) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      if (current.status !== 'draft') await requireOrgScope(req,'host:members:manage');
      const body = (req.body ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown };
      const settings = await getContentLanguageSettings(user.tenantId, orgId);
      const patch: { title?: string; slug?: string; sections?: unknown; baseLocale?: string } = { baseLocale: settings.baseLocale };
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.slug === 'string') patch.slug = body.slug;
      if (body.sections !== undefined) patch.sections = body.sections;
      const updated = await updatePage(user.tenantId, orgId, req.params.pageId, patch, user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:write');
      const ok = await deletePage(user.tenantId, orgId, req.params.pageId);
      if (!ok) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Editorial workflow (Phase 2) ──
  // submit is an editor action; approve/reject/publish/archive are the
  // admin/owner tier (host:members:manage). The service validates the legal
  // status transition (409 otherwise).
  const transition = (action: WorkflowAction, scope: 'workspace:write' | 'host:members:manage') =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { user, orgId } = await requireOrgScope(req,scope);
        const updated = await transitionPage(user.tenantId, orgId, req.params.pageId, action, user.userId);
        if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    };
  // ADR 0066 — when `cms-approval-gate` is ON for the tenant, `submit` ALSO
  // queues a content-publish approval in the shared ApprovalsInbox (idempotent:
  // one open approval per page), and the direct `approve` route DEFERS to that
  // queue (publishing goes through the inbox). OFF ⇒ byte-identical to today.
  const approvalGateOn = async (tenantId: string): Promise<boolean> => {
    const a = await resolveOne('cms-approval-gate', { tenantId });
    return !!a?.enabled;
  };
  app.post(`${BASE}/pages/:pageId/submit`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      const updated = await transitionPage(user.tenantId, orgId, req.params.pageId, 'submit', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      if (await approvalGateOn(user.tenantId) && !(await hasPendingApprovalForPage(user.tenantId, updated.pageId))) {
        await createContentApproval({
          tenantId: user.tenantId,
          orgId,
          pageId: updated.pageId,
          pageTitle: updated.title,
          proposal: `Publish CMS page "${updated.title}"`,
        });
      }
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
  app.post(`${BASE}/pages/:pageId/approve`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'host:members:manage');
      if (await approvalGateOn(user.tenantId)) {
        throw new OpenwopError(
          'conflict',
          'Publishing is gated on approval — approve this page from the Approvals inbox.',
          409,
          { pageId: req.params.pageId, gate: 'cms-approval-gate' },
        );
      }
      const updated = await transitionPage(user.tenantId, orgId, req.params.pageId, 'approve', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
  // `reject`/`unpublish` move a page out of `in_review`/`published`. When the gate
  // is ON they ALSO resolve (reject) any pending content-publish approval for the
  // page, so the inbox row doesn't orphan (review MEDIUM-3 — the page status is
  // the single source of truth).
  const transitionWithApprovalCleanup = (action: WorkflowAction) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { user, orgId } = await requireOrgScope(req, 'host:members:manage');
        const updated = await transitionPage(user.tenantId, orgId, req.params.pageId, action, user.userId);
        if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
        if (await approvalGateOn(user.tenantId)) {
          await rejectPendingApprovalForPage(user.tenantId, updated.pageId, `Superseded by direct ${action}.`);
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    };
  app.post(`${BASE}/pages/:pageId/reject`, transitionWithApprovalCleanup('reject'));
  app.post(`${BASE}/pages/:pageId/unpublish`, transitionWithApprovalCleanup('unpublish'));
  app.post(`${BASE}/pages/:pageId/archive`, transition('archive', 'host:members:manage'));
  // `publish` is the direct admin-publish path (from draft or in_review). When the
  // gate is ON it is a publish bypass, so it 409s like `approve` — the inbox is
  // the only publish path for a gated org (review: close the publish bypass).
  app.post(`${BASE}/pages/:pageId/publish`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'host:members:manage');
      if (await approvalGateOn(user.tenantId)) {
        throw new OpenwopError(
          'conflict',
          'Publishing is gated on approval — publish this page from the Approvals inbox.',
          409,
          { pageId: req.params.pageId, gate: 'cms-approval-gate' },
        );
      }
      const updated = await transitionPage(user.tenantId, orgId, req.params.pageId, 'publish', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Restore a past version into the draft (admin/owner).
  app.post(`${BASE}/pages/:pageId/restore/:versionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'host:members:manage');
      const restored = await restoreVersion(user.tenantId, orgId, req.params.pageId, req.params.versionId, user.userId);
      if (!restored) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(restored);
    } catch (err) {
      next(err);
    }
  });

  // ── Content language settings (ADR 0064) ──
  // Read is workspace:read (the editor needs the locale set). Write is the
  // admin tier AND gated on the `cms-localization` toggle (default OFF) — so an
  // org can't author locales unless localization is enabled for it; with no
  // authored locales, delivery stays byte-identical to the non-localized CMS.
  app.get(`${BASE}/language-settings`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      res.json(await getContentLanguageSettings(user.tenantId, orgId));
    } catch (err) {
      next(err);
    }
  });

  app.put(`${BASE}/language-settings`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'cms-localization', 'Content localization');
      const { user, orgId } = await requireOrgScope(req,'host:members:manage');
      const body = (req.body ?? {}) as { baseLocale?: unknown; supportedLocales?: unknown; autoTranslateOnPublish?: unknown };
      res.json(await updateContentLanguageSettings(user.tenantId, orgId, body, user.userId));
    } catch (err) {
      next(err);
    }
  });

  // ── AI translate-from-base (ADR 0064 Phase 3) ──
  // Translate a section's base `data` into a target locale via the managed
  // (free-tier) provider; the output is sanitized like a stored overlay. Toggle-
  // + write-gated. Managed-provider unavailable → 503 (the editor degrades to
  // copy-from-base + manual editing). The returned overlay is a DRAFT the editor
  // reviews before saving.
  app.post(`${BASE}/translate-section`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'cms-localization', 'Content localization');
      const { user } = await requireOrgScope(req,'workspace:write');
      const b = (req.body ?? {}) as { sectionType?: unknown; data?: unknown; targetLocale?: unknown };
      const sectionType = String(b.sectionType ?? '');
      if (!SECTION_TYPES.includes(sectionType as SectionType)) {
        throw new OpenwopError('validation_error', `sectionType must be one of: ${SECTION_TYPES.join(', ')}`, 400, { sectionType: b.sectionType });
      }
      const targetLocale = String(b.targetLocale ?? '');
      if (!LOCALE_RE.test(targetLocale)) {
        throw new OpenwopError('validation_error', 'Invalid targetLocale (expected BCP-47, e.g. "es", "pt-BR").', 400, { targetLocale });
      }
      const data = (typeof b.data === 'object' && b.data !== null ? b.data : {}) as Record<string, unknown>;
      try {
        const overlay = await translateSectionData(user.tenantId, sectionType as SectionType, data, targetLocale);
        res.json({ overlay });
      } catch (err) {
        // ONLY a managed-provider failure (not configured / capped / sign-in) is
        // a graceful 503 the editor degrades from. An unexpected internal error
        // must NOT be masked as "translation unavailable" — let it 500.
        if (err instanceof ManagedProviderError) {
          throw new OpenwopError('host_capability_missing', 'Automatic translation is unavailable right now — edit the translation manually.', 503, { reason: err.message });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });
}
