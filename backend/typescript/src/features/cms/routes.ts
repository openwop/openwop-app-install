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
import { requireFeatureEnabled, requireString, optionalString } from '../featureRoute.js';
import { requireCmsScope } from './cmsScope.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { rejectPendingApprovalForPage, findPendingContentApprovalForPage, findLatestContentApprovalForPage } from '../../host/approvalService.js';
import { claimApproval, rejectApproval } from '../../host/approvalDecision.js';
import { isSuperadmin } from '../../host/superadmin.js';
import { blockingLiveEditPages, isApprovalGateOn, liveEditGateActive, liveEditRefusal, queueContentApproval, refuseLiveEdit } from './contentApproval.js';
import { LOCALE_RE } from '../../host/i18n/index.js';
import { autoTranslateMissingOverlays, translateSectionData } from './translate.js';
import { ManagedProviderError } from '../../providers/managedProvider.js';
import {
  assertLocaleScopedSectionsPatch,
  clearScheduledPublish,
  clearScheduledUnpublish,
  createPage,
  createSharedSection,
  deletePage,
  deliverableSectionsForPage,
  deleteSharedSection,
  getContentLanguageSettings,
  getLocaleGrant,
  getPage,
  getPublishedBySlug,
  getSharedSection,
  listLocaleGrants,
  listPages,
  listPagesUsingSharedSection,
  listSharedSections,
  localizePage,
  listVersions,
  putLocaleGrant,
  restoreVersion,
  setLocalePublishState,
  setScheduledPublish,
  setScheduledUnpublish,
  transitionPage,
  updateContentLanguageSettings,
  updatePage,
  updateSharedSection,
  validateSections,
  PAGE_STATUSES,
  SECTION_TYPES,
  type PageStatus,
  type SectionType,
  type WorkflowAction,
} from './cmsService.js';

export function registerCmsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // chat-first-port C1 — the shared decision core needs the storage/hostSuite pair.
  const decisionDeps = { storage: deps.storage, hostSuite: deps.hostSuite };
  const BASE = '/v1/host/openwop-app/cms/orgs/:orgId';

  // ── Reads ──
  // `?q=&tag=&status=` only NARROW the tenant+org-scoped set (ADR 0206 B3).
  app.get(`${BASE}/pages`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req,'workspace:read');
      const status = optionalString(req.query.status);
      if (status !== undefined && !PAGE_STATUSES.includes(status as PageStatus)) {
        throw new OpenwopError('validation_error', `status must be one of: ${PAGE_STATUSES.join(', ')}`, 400, { status });
      }
      const kind = optionalString(req.query.kind);
      if (kind !== undefined && kind !== 'page' && kind !== 'post') {
        throw new OpenwopError('validation_error', "kind must be 'page' or 'post'.", 400, { kind });
      }
      const collection = optionalString(req.query.collection);
      if (collection !== undefined && collection !== 'docs' && collection !== 'site') {
        throw new OpenwopError('validation_error', "collection must be 'docs' or 'site'", 400, { collection });
      }
      const filter = {
        ...(optionalString(req.query.q) ? { q: String(req.query.q) } : {}),
        ...(optionalString(req.query.tag) ? { tag: String(req.query.tag) } : {}),
        ...(status ? { status: status as PageStatus } : {}),
        ...(kind ? { kind: kind as 'page' | 'post' } : {}),
        ...(optionalString(req.query.category) ? { category: String(req.query.category) } : {}),
        ...(optionalString(req.query.author) ? { authorId: String(req.query.author) } : {}),
        ...(collection ? { collection: collection as 'docs' | 'site' } : {}),
      };
      res.json({ pages: await listPages(tenantId, orgId, filter) });
    } catch (err) {
      next(err);
    }
  });

  // by-slug MUST precede /pages/:pageId (else 'by-slug' is captured as :pageId).
  app.get(`${BASE}/pages/by-slug/:slug`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req,'workspace:read');
      const hit = await getPublishedBySlug(tenantId, orgId, req.params.slug);
      if (!hit) throw new OpenwopError('not_found', 'No published page at that slug.', 404, { slug: req.params.slug });
      // ADR 0064 — resolve sections for the locale negotiated from Accept-Language
      // (published-only is already enforced upstream). When the org has authored
      // no locales this returns base `data` verbatim (byte-identical). The
      // negotiated locale is a RESPONSE concern only — set on Content-Language,
      // never written to any log/event (RFC 0103 §F).
      const settings = await getContentLanguageSettings(tenantId, orgId);
      const { page, locale } = localizePage(hit.page, req.headers['accept-language'], settings);
      res.setHeader('Content-Language', locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      // Cookie-authed, org-scoped, delivery-SHAPED — the one read a shared cache
      // could plausibly mis-cache because it looks public. Freshness matters in
      // the editor; nothing here benefits from caching (Phase-A review A5).
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ...hit, page });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/pages/:pageId/versions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req,'workspace:read');
      res.json({ versions: await listVersions(tenantId, orgId, req.params.pageId) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req,'workspace:read');
      const page = await getPage(tenantId, orgId, req.params.pageId);
      if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  // ── Content edits (workspace:write) ──
  app.post(`${BASE}/pages`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req,'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId); // ADR 0205 D1
      const body = (req.body ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown; tags?: unknown; kind?: unknown; authorId?: unknown; category?: unknown; collection?: unknown; docsNav?: unknown };
      const settings = await getContentLanguageSettings(tenantId, orgId);
      const page = await createPage({
        tenantId,
        orgId,
        title: requireString(body.title, 'title'),
        ...(optionalString(body.slug) ? { slug: String(body.slug) } : {}),
        sections: body.sections,
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.authorId !== undefined ? { authorId: body.authorId } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        // ADR 0392 — a docs page is authored in the docs collection.
        ...(body.collection === 'docs' ? { collection: 'docs' as const } : {}),
        ...(body.collection === 'docs' && optionalString(body.docsNav) ? { docsNav: String(body.docsNav) } : {}),
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
      const { user, orgId, tenantId } = await requireCmsScope(req,'workspace:write');
      // Editorial gate (code-review #1): editors may only edit DRAFTS. Editing a
      // page that is live/under-review/archived changes content outside the
      // review flow, so it requires the admin tier — editors must `unpublish`
      // (→ draft) first. Re-authorize for the admin scope when not a draft.
      const current = await getPage(tenantId, orgId, req.params.pageId);
      if (!current) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      if (current.status !== 'draft') await requireCmsScope(req,'host:members:manage');
      // UX_UPGRADE-content R2 (CMS2-B1) — the THIRD path to live content, and
      // the only one that was not gated. `publish` (:387) and `schedule` (:411)
      // both 409 when `cms-approval-gate` is ON; PATCH did not, and it edits a
      // PUBLISHED page's body in place: `updatePage` re-fires the `published`
      // lifecycle and `snapshotPage` never runs (it fires only on submit and on
      // transitions INTO published). So an admin could rewrite live copy and
      // outbound CTA URLs with the Approvals inbox empty and version history
      // showing no "before" — under a toggle whose whole promise to the org is
      // that publishing is gated on human review.
      //
      // The remedy is `unpublish` → edit → `submit`, which is what "gated"
      // means: the page comes down while it is being changed, rather than
      // changing underneath its readers. `in_review` stays editable at admin
      // tier (that is how a reviewer's requested change gets made) and is made
      // safe instead by the version pin on the approval — see CMS2-M1.
      // …EXCEPT on the reserved system-site org, which has no members, no
      // approvers, and no route to one. Gating it made the public marketing
      // site UNRECOVERABLE: the prescribed remedy takes `/` and every docs page
      // offline, and the resubmit then dead-ends because `decideContentPublish`
      // demands `host:members:manage` IN THE PAGE'S ORG — authority a superadmin
      // does not hold in a reserved org nobody is a member of. Boot cannot heal
      // it either: `systemSite.ts` only re-publishes while `updatedBy` is still
      // the system actor, which the operator's own edit had already replaced.
      // An ORG-review gate is structurally inapplicable where there is no org to
      // review within; host-level authority is the control here.
      // ADR 0672 D7 — this used to hand-write BOTH halves of the owner: the system-site
      // exemption below (`liveEditGateActive`'s body, verbatim) and the gate read. ADR 0593
      // §C1 created that owner precisely because the rule had shipped as three hand-written
      // copies, two of them half-right — and this was the fourth, in the one file the §C9
      // sweep did not visit. Equivalent today; it would drift the moment the owner gains a
      // dimension.
      //
      // The `published`-only STATE arm is deliberately NOT `isGatedLiveEditState` here, and
      // the reasoning is at `:196-199`: this lane bumps `page.version`, so an `in_review`
      // page is caught by the approval's version pin rather than by this refusal.
      if (current.status === 'published' && await liveEditGateActive(tenantId, orgId)) {
        throw new OpenwopError(
          'conflict',
          'Publishing is gated on approval — unpublish this page before editing it, then submit it for review.',
          409,
          { pageId: req.params.pageId, gate: 'cms-approval-gate', status: current.status },
        );
      }
      const body = (req.body ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown; tags?: unknown; kind?: unknown; authorId?: unknown; category?: unknown; expectedVersion?: unknown };
      // ADR 0592 §1 (CMSL-1) — optional optimistic-concurrency pin. When sent
      // it must be a number; the mismatch 409 itself is thrown by `updatePage`
      // (the service read is the authoritative one).
      let expectedVersion: number | undefined;
      if (body.expectedVersion !== undefined) {
        if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
          throw new OpenwopError('validation_error', '`expectedVersion` must be an integer page version.', 400, { expectedVersion: body.expectedVersion });
        }
        expectedVersion = body.expectedVersion;
      }
      const settings = await getContentLanguageSettings(tenantId, orgId);
      // ADR 0205 D1 — a translator grant NARROWS this member's write to the
      // granted locales' overlays: page chrome, structure, base data, and
      // foreign locales are immutable (server-side diff, fail-closed).
      const grant = await getLocaleGrant(tenantId, orgId, user.userId);
      if (grant) {
        if (body.title !== undefined || body.slug !== undefined || body.tags !== undefined || body.kind !== undefined || body.authorId !== undefined || body.category !== undefined || (body as { docsNav?: unknown }).docsNav !== undefined) {
          throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only — title/slug/tags are immutable.', 403, { grantedLocales: grant.locales });
        }
        if (body.sections !== undefined) {
          assertLocaleScopedSectionsPatch(current, validateSections(body.sections, settings.baseLocale), grant.locales);
        }
      }
      const patch: { title?: string; slug?: string; sections?: unknown; tags?: unknown; baseLocale?: string; kind?: unknown; authorId?: unknown; category?: unknown; docsNav?: string } = { baseLocale: settings.baseLocale };
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.slug === 'string') patch.slug = body.slug;
      if (body.sections !== undefined) patch.sections = body.sections;
      if (body.tags !== undefined) patch.tags = body.tags;
      if (body.kind !== undefined) patch.kind = body.kind;
      if (body.authorId !== undefined) patch.authorId = body.authorId;
      if (body.category !== undefined) patch.category = body.category;
      if (typeof (body as { docsNav?: unknown }).docsNav === 'string') patch.docsNav = String((body as { docsNav?: unknown }).docsNav);
      const updated = await updatePage(tenantId, orgId, req.params.pageId, patch, user.userId, expectedVersion !== undefined ? { expectedVersion } : undefined);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req,'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId); // ADR 0205 D1
      // ADR 0748 correction (2026-09-27) — deleting a page that is not a draft
      // takes live (or under-review / archived) content down, which is at least an
      // unpublish: admin tier, exactly as PATCH re-authorizes a non-draft edit and
      // as the protocol `deleteContentPage` does. It used to be `workspace:write`
      // for ANY status — an editor could delete what they could not unpublish.
      // No approval-gate 409: removal is the fail-safe direction (unpublish,
      // archive and schedule-unpublish are ungated too). Decided on the row being
      // deleted (`deletePage`'s own read).
      const ok = await deletePage(tenantId, orgId, req.params.pageId, {
        authorize: async (page) => {
          if (page.status !== 'draft') await requireCmsScope(req, 'host:members:manage');
        },
      });
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
  // chat-first-port C1 — `submit` ALWAYS queues a shared content-publish approval
  // (regardless of the toggle); `approve`/`reject` resolve THAT row through the
  // shared decision core. The `cms-approval-gate` toggle now gates only the direct
  // `publish` bypass (ON ⇒ publish must go through the review).
  // ADR 0593 (CMSA-D1) — ONE gate predicate, shared with the sweep, the
  // experiment promote lane and the shared-section gate below. This used to be a
  // local copy; four independent read sites is how `CMSA-4` drifted.
  const approvalGateOn = isApprovalGateOn;
  // ADR 0205 D1 — the translator narrowing must cover EVERY base-content write
  // a `workspace:write` member can reach, or the grant is decorative: page
  // create/delete and the shared-section writes are 403 for a grant-holder
  // (review finding — PATCH-only narrowing left create/delete/shared as
  // arbitrary-base-content side doors).
  const denyIfTranslator = async (tenantId: string, orgId: string, subject: string): Promise<void> => {
    const grant = await getLocaleGrant(tenantId, orgId, subject);
    if (grant) {
      throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only.', 403, { grantedLocales: grant.locales });
    }
  };

  // `cms-localization` toggle check as a boolean (the submit path must not 404
  // like `requireFeatureEnabled` — auto-translate is a conditional side-effect,
  // not a gated surface).
  const localizationOn = async (tenantId: string): Promise<boolean> => {
    const a = await resolveOne('cms-localization', { tenantId });
    return !!a?.enabled;
  };
  app.post(`${BASE}/pages/:pageId/submit`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      // ADR 0205 D1 — translators cannot transition status (the grant is
      // overlay-only). Reviewed conservatively: submit included.
      if (await getLocaleGrant(tenantId, orgId, user.userId)) {
        throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only — an editor submits the page.', 403, {});
      }
      let updated = await transitionPage(tenantId, orgId, req.params.pageId, 'submit', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      // ADR 0064 amendment — honor `autoTranslateOnPublish` at SUBMIT time (so
      // the approval gate reviews AI output BEFORE publish), missing-only,
      // best-effort (a provider failure never fails the submit), capped. Runs
      // only when the tenant's `cms-localization` toggle is ON — the flag can
      // outlive the toggle; toggle OFF stays byte-identical.
      let autoTranslated: Record<string, number> | undefined;
      let autoTranslateDegraded: { capped?: boolean; errored?: boolean; invalid?: number; conflict?: boolean } | undefined;
      if (await localizationOn(tenantId)) {
        const settings = await getContentLanguageSettings(tenantId, orgId);
        if (settings.autoTranslateOnPublish && settings.supportedLocales.length > 0) {
          // Best-effort END TO END (code-review HIGH-1): the sweep is already
          // failure-tolerant, but the merge-save can throw too (e.g. a page
          // carrying a pre-existing overlay keyed at a since-changed base
          // locale fails validateLocalizations). Translation must NEVER fail a
          // submit that already transitioned — so the whole block degrades to
          // an untranslated submit, and `autoTranslated` is only reported for
          // overlays that actually persisted.
          try {
            const sweep = await autoTranslateMissingOverlays(tenantId, updated.sections, settings.supportedLocales);
            if (sweep.capped || sweep.errored || sweep.invalid > 0) {
              autoTranslateDegraded = {
                ...(sweep.capped ? { capped: true } : {}),
                ...(sweep.errored ? { errored: true } : {}),
                ...(sweep.invalid > 0 ? { invalid: sweep.invalid } : {}),
              };
            }
            if (sweep.overlays.size > 0) {
              // ADR 0592 §1 (CMSL-1) — this merge is the feature's OWN machine
              // writer racing human editors, so it is VERSION-CHECKED like any
              // editor save, with ONE bounded re-read-and-re-merge on conflict.
              // The merge is missing-only against the sections it writes ONTO:
              // an overlay a human wrote inside the window wins over the AI
              // draft (the sweep's own missing-only rule, re-applied at merge
              // time), and a draft for a section that vanished is dropped.
              // Persistence rides the EXISTING validated write path
              // (updatePage → validateSections → validateLocalizations).
              type Sections = NonNullable<typeof updated>['sections'];
              const applyMerge = (sections: Sections): { merged: Sections; applied: Record<string, number> } => {
                const applied: Record<string, number> = {};
                const draftedAt = new Date().toISOString();
                const merged = sections.map((s) => {
                  const drafted = sweep.overlays.get(s.sectionId);
                  if (!drafted) return s;
                  const loc = { ...(s.localizations ?? {}) };
                  const ai = { ...(s.aiDrafted ?? {}) };
                  let changed = false;
                  for (const [locale, overlay] of Object.entries(drafted)) {
                    if (loc[locale]) continue; // human overlay landed in the window — it wins
                    loc[locale] = overlay;
                    // ADR 0592 §3 — durable machine-origin stamp at the writer.
                    ai[locale] = draftedAt;
                    applied[locale] = (applied[locale] ?? 0) + 1;
                    changed = true;
                  }
                  return changed ? { ...s, localizations: loc, aiDrafted: ai } : s;
                });
                return { merged, applied };
              };
              let base = updated;
              for (let attempt = 0; attempt < 2; attempt += 1) {
                const { merged, applied } = applyMerge(base.sections);
                if (Object.keys(applied).length === 0) break; // everything drafted already exists — nothing to persist
                try {
                  const saved = await updatePage(tenantId, orgId, updated.pageId, { sections: merged, baseLocale: settings.baseLocale }, user.userId, { expectedVersion: base.version });
                  if (saved) {
                    updated = saved;
                    autoTranslated = applied;
                  }
                  break;
                } catch (err) {
                  if (err instanceof OpenwopError && err.code === 'conflict') {
                    if (attempt === 0) {
                      const fresh = await getPage(tenantId, orgId, updated.pageId);
                      if (!fresh) break;
                      base = fresh; // re-merge onto the state the winner left
                      continue;
                    }
                    // ADR 0592 §9 correction (review F6) — a SECOND conflict
                    // discards the AI drafts (correct: humans are actively
                    // editing; the sweep must not fight them) but must be
                    // DISCLOSED, not swallowed: without this flag the
                    // response/toast/proposal read as a clean untranslated
                    // submit while up to 20 provider calls' output was dropped.
                    autoTranslateDegraded = { ...(autoTranslateDegraded ?? {}), conflict: true };
                    break;
                  }
                  throw err;
                }
              }
            }
          } catch {
            // Degrade to an untranslated submit — the editor can translate
            // manually; the page is already in_review.
          }
        }
      }
      // chat-first-port C1 — ALWAYS queue the shared approval row on submit
      // (regardless of the toggle), so the in_review decision is the ONE shared
      // path. Shared with the node surface (ADR 0204 C6) — ONE owner.
      const aiNote = autoTranslated
        ? ` — includes ${Object.entries(autoTranslated).map(([l, n]) => `${n} AI-drafted ${l} overlay${n === 1 ? '' : 's'}`).join(', ')} pending review`
        : '';
      // ADR 0592 §9 (CMSL-5/CMSLU-14) — a capped/errored/invalid sweep is no
      // longer indistinguishable from a complete one: the degrade rides the
      // response (FE toast) AND the approval proposal (the reviewer's view).
      const degradeParts: string[] = [];
      if (autoTranslateDegraded?.capped) degradeParts.push('call cap hit — some sections were skipped');
      if (autoTranslateDegraded?.errored) degradeParts.push('provider failed mid-sweep');
      if (autoTranslateDegraded?.invalid) degradeParts.push(`${autoTranslateDegraded.invalid} translation(s) returned unusable output`);
      if (autoTranslateDegraded?.conflict) degradeParts.push('concurrent edits — the AI drafts were discarded');
      const degradeNote = degradeParts.length > 0 ? ` — auto-translate incomplete: ${degradeParts.join('; ')}` : '';
      await queueContentApproval(tenantId, orgId, updated, `Publish CMS page "${updated.title}"${aiNote}${degradeNote}`);
      res.json({
        ...updated,
        ...(autoTranslated ? { autoTranslated } : {}),
        ...(autoTranslateDegraded ? { autoTranslateDegraded } : {}),
      });
    } catch (err) {
      next(err);
    }
  });
  // chat-first-port C1 — `approve`/`reject` are the header buttons' decision. They
  // resolve the page's SHARED `content-publish` approval row through the SHARED
  // decision core (host/approvalDecision → decideContentPublish), so page-decide ≡
  // inbox-decide — NOT a bespoke page transition. The row always exists (submit
  // queues it regardless of the toggle); publishing fires from the decision
  // handler. `host:members:manage` at the route mirrors the prior authority bar
  // (an editor 403s before the lookup); the handler re-enforces org RBAC + IDOR.
  const decidePageReview = (verb: 'approve' | 'reject') =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
        let appr = await findPendingContentApprovalForPage(tenantId, req.params.pageId);
        if (!appr) {
          // Migration edge (Phase-4 review LOW): a page that entered in_review
          // BEFORE the unconditional submit-queues-a-row change has no shared
          // row — lazily backfill one so it stays decidable instead of 409ing.
          const page = await getPage(tenantId, orgId, req.params.pageId);
          if (page && page.status === 'in_review') {
            await queueContentApproval(tenantId, orgId, page, `Review "${page.title ?? page.slug}"`);
            appr = await findPendingContentApprovalForPage(tenantId, req.params.pageId);
          }
        }
        if (!appr) {
          throw new OpenwopError('conflict', 'This page has no pending review to decide.', 409, { pageId: req.params.pageId });
        }
        // ADR 0593 (CMSA-9) — read the reviewer's NOTE. "page-decide ≡
        // inbox-decide" is the C1 contract, and the inbox lane has always
        // persisted a note (`routes/approvals.ts` → `resolveApproval`) while
        // this lane never read the body: a reason typed into the CMS header
        // vanished silently. It is also what makes a rejection actionable
        // (CMSAU-5) — a decision with no reason is a dead end for the submitter.
        const decideBody = (req.body ?? {}) as { note?: unknown };
        const note = typeof decideBody.note === 'string' ? decideBody.note.slice(0, 2000) : undefined;
        const decideCtx = {
          tenantId,
          ...(user.userId ? { decidedBy: user.userId } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(isSuperadmin(req) ? { decidedBySuperadmin: true } : {}),
        };
        if (verb === 'approve') await claimApproval(decisionDeps, decideCtx, appr.approvalId);
        else await rejectApproval(decisionDeps, decideCtx, appr.approvalId);
        // The handler transitioned the page; return its current shape (the prior
        // route's response contract — status/publishedVersion/version).
        const page = await getPage(tenantId, orgId, req.params.pageId);
        if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
        res.json(page);
      } catch (err) {
        next(err);
      }
    };
  // ADR 0593 D4 (CMSAU-5) — the SUBMITTER's half of the loop. A rejection used
  // to notify nobody, collect no reason and render none: the page silently read
  // `draft`, indistinguishable from never-submitted, while `note` / `decidedBy`
  // / `resolvedAt` sat on the resolved row with ZERO readers.
  //
  // Deliberately `workspace:write` (page-authorship tier), NOT the manage bar
  // the inbox LIST uses: the list hides a content-publish row's existence from
  // non-managers, but this is scoped to ONE page the caller can already read and
  // edit, so it leaks nothing new — and withholding it from the one person who
  // must act on it is what made the gate a dead end. Projected narrowly: the
  // outcome, its reason, its author and its time; never the whole row.
  app.get(`${BASE}/pages/:pageId/review`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      const page = await getPage(tenantId, orgId, req.params.pageId);
      if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      const a = await findLatestContentApprovalForPage(tenantId, req.params.pageId);
      res.json({
        review: a && a.orgId === orgId
          ? {
              approvalId: a.approvalId,
              status: a.status,
              // ADR 0672 D3 — a SUPERSEDED review resolved `rejected` (the only terminal
              // non-approved status) but was overtaken, not declined. Without this the
              // submitter surface reads `rejected` for a page that went LIVE, and the
              // chain's honest `superseded` outcome is unreachable from here.
              ...(a.superseded ? { superseded: true } : {}),
              createdAt: a.createdAt,
              ...(a.resolvedAt ? { resolvedAt: a.resolvedAt } : {}),
              ...(a.decidedBy ? { decidedBy: a.decidedBy } : {}),
              ...(a.note !== undefined ? { note: a.note } : {}),
              ...(typeof a.pageVersion === 'number' ? { pageVersion: a.pageVersion } : {}),
              ...(a.aiDraftedLocales ? { aiDraftedLocales: a.aiDraftedLocales } : {}),
            }
          : null,
      });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/pages/:pageId/approve`, decidePageReview('approve'));
  app.post(`${BASE}/pages/:pageId/reject`, decidePageReview('reject'));
  // `unpublish`/`archive` are admin STATE controls (not review decisions). They
  // move a page out of `published`/`in_review` and ALSO resolve any pending
  // content-publish approval so the inbox row doesn't orphan (the page status is
  // the single source of truth). Cleanup is unconditional — the row can exist
  // regardless of the toggle now (chat-first-port C1).
  const transitionWithApprovalCleanup = (action: WorkflowAction) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
        const updated = await transitionPage(tenantId, orgId, req.params.pageId, action, user.userId);
        if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
        await rejectPendingApprovalForPage(tenantId, updated.pageId, `Superseded by direct ${action}.`, true);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    };
  app.post(`${BASE}/pages/:pageId/unpublish`, transitionWithApprovalCleanup('unpublish'));
  app.post(`${BASE}/pages/:pageId/archive`, transitionWithApprovalCleanup('archive'));
  // `publish` is the direct admin-publish path (from draft or in_review). When the
  // gate is ON it is a publish bypass, so it 409s — the review is the only publish
  // path for a gated org. When OFF it proceeds and resolves any pending approval.
  app.post(`${BASE}/pages/:pageId/publish`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      if (await approvalGateOn(tenantId)) {
        throw new OpenwopError(
          'conflict',
          'Publishing is gated on approval — publish this page from the Approvals inbox.',
          409,
          { pageId: req.params.pageId, gate: 'cms-approval-gate' },
        );
      }
      const updated = await transitionPage(tenantId, orgId, req.params.pageId, 'publish', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      await rejectPendingApprovalForPage(tenantId, updated.pageId, 'Superseded by direct publish.', true);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // ── Scheduled publishing (ADR 0204 C2) ──
  // Admin-tier, and 409 when the approval gate is ON — a scheduled publish is
  // a publish bypass exactly like the direct publish route; the inbox stays
  // the only publish path for a gated org. The sweep re-checks at fire time.
  app.post(`${BASE}/pages/:pageId/schedule`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      if (await approvalGateOn(tenantId)) {
        throw new OpenwopError(
          'conflict',
          'Publishing is gated on approval — a scheduled publish would bypass the inbox.',
          409,
          { pageId: req.params.pageId, gate: 'cms-approval-gate' },
        );
      }
      const body = (req.body ?? {}) as { at?: unknown };
      const at = requireString(body.at, 'at');
      const updated = await setScheduledPublish(tenantId, orgId, req.params.pageId, at, user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
  app.delete(`${BASE}/pages/:pageId/schedule`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const updated = await clearScheduledPublish(tenantId, orgId, req.params.pageId, user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // ── Scheduled unpublish (ADR 0204 C2b — embargo end) ──
  // Same admin scope as a manual unpublish. DELIBERATELY NOT gated on
  // cms-approval-gate: the gate protects the publish direction; removing
  // content is the fail-safe direction (Contentful/Sanity leave it ungated
  // too). Do not add the gate here by symmetry with the schedule route above.
  app.post(`${BASE}/pages/:pageId/schedule-unpublish`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { at?: unknown };
      const at = requireString(body.at, 'at');
      const updated = await setScheduledUnpublish(tenantId, orgId, req.params.pageId, at, user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
  app.delete(`${BASE}/pages/:pageId/schedule-unpublish`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const updated = await clearScheduledUnpublish(tenantId, orgId, req.params.pageId, user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Restore a past version into the draft (admin/owner).
  app.post(`${BASE}/pages/:pageId/restore/:versionId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req,'host:members:manage');
      const restored = await restoreVersion(tenantId, orgId, req.params.pageId, req.params.versionId, user.userId);
      if (!restored) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(restored);
    } catch (err) {
      next(err);
    }
  });

  // ── Shared sections (ADR 0204 C4) ──
  // Reusable org-owned sections pages inherit by reference. Reads are
  // workspace:read; writes workspace:write (content edits) — the IMPACT list
  // (`GET /:id/pages`) is how the editor shows "these pages change" before a
  // shared edit (the research-doc acceptance criterion). Delete 409s while
  // referenced (service-enforced).
  // ADR 0593 D1 (CMSA-1) — the FOURTH path to live content.
  //
  // CMS2-B1 gated the published-page PATCH and called it "the THIRD path to live
  // content, and the only one that was not gated". It missed REFERENCE
  // INDIRECTION: a shared-section edit needs only `workspace:write` (a tier BELOW
  // the admin bar that gate enforces) and delivery resolves `section.ref` to this
  // row's CURRENT `data`/`localizations` at READ time (`resolveSharedRefs`,
  // reached from the public page, the share-link lane and the experiment lane).
  // So on a gated org an editor rewrote LIVE published content instantly with the
  // Approvals inbox empty. And because `page.version` never moves when a shared
  // row changes, the approve-what-you-saw pin was BLIND to it: edit the shared
  // section while a page is `in_review` and the `stale_review` 409 cannot fire,
  // so the reviewer's name goes on content they never read.
  //
  // Gating the WRITE closes both halves structurally, and covers the share-link
  // delivery surface too — where there is no approval row to pin against, so a
  // pin-based cure could not have reached it.
  //
  // The refusal NAMES the blocking pages: a gate whose 409 does not say what to
  // unpublish is the gate-with-no-exit shape this same batch closes elsewhere.
  // (`GET /shared-sections/:id/pages` is the same list, read before you try.)
  //
  // …EXCEPT on the reserved system-site org, for the reason recorded at the PATCH
  // gate above: it has no members, no approvers and no route to one, and nav and
  // footer are exactly what a marketing site shares — gating them would reproduce
  // the outage CMS2-B1 had to be corrected for.
  const assertSharedSectionEditable = async (
    tenantId: string,
    orgId: string,
    sharedSectionId: string,
    // ADR 0593 CORRECTION (review F9) — WHICH fields are being written. Delivery
    // resolves a ref to the shared row's `type`/`data`/`localizations` only
    // (`resolveSharedRefs`), so a `name`-only rename reaches no reader and the
    // first version refused it anyway. A gate that refuses writes it does not
    // govern trains people to route around it.
    touchesDeliveredContent: boolean,
  ): Promise<void> => {
    if (!touchesDeliveredContent) return;
    const blocking = await blockingLiveEditPages(
      tenantId, orgId,
      await listPagesUsingSharedSection(tenantId, orgId, sharedSectionId),
    );
    if (blocking.length === 0) return;
    throw liveEditRefusal('this shared section', blocking, {
      sharedSectionId,
      pages: blocking,
    });
  };

  app.get(`${BASE}/shared-sections`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      res.json({ sharedSections: await listSharedSections(tenantId, orgId) });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/shared-sections`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId); // ADR 0205 D1 — shared content is base content
      const body = (req.body ?? {}) as { name?: unknown; type?: unknown; data?: unknown; localizations?: unknown };
      const settings = await getContentLanguageSettings(tenantId, orgId);
      const row = await createSharedSection(
        tenantId,
        orgId,
        { name: requireString(body.name, 'name'), type: body.type, data: body.data, ...(body.localizations !== undefined ? { localizations: body.localizations } : {}) },
        user.userId,
        settings.baseLocale,
      );
      res.status(201).json(row);
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/shared-sections/:sharedSectionId/pages`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      if (!(await getSharedSection(tenantId, orgId, req.params.sharedSectionId))) {
        throw new OpenwopError('not_found', 'Shared section not found.', 404, { sharedSectionId: req.params.sharedSectionId });
      }
      res.json({ pages: await listPagesUsingSharedSection(tenantId, orgId, req.params.sharedSectionId) });
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/shared-sections/:sharedSectionId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId); // ADR 0205 D1 — shared content is base content
      const body = (req.body ?? {}) as { name?: unknown; data?: unknown; localizations?: unknown };
      await assertSharedSectionEditable(
        tenantId, orgId, req.params.sharedSectionId,
        body.data !== undefined || body.localizations !== undefined,
      );
      const settings = await getContentLanguageSettings(tenantId, orgId);
      const patch: { name?: string; data?: unknown; localizations?: unknown } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (body.data !== undefined) patch.data = body.data;
      if (body.localizations !== undefined) patch.localizations = body.localizations;
      const row = await updateSharedSection(tenantId, orgId, req.params.sharedSectionId, patch, user.userId, settings.baseLocale);
      if (!row) throw new OpenwopError('not_found', 'Shared section not found.', 404, { sharedSectionId: req.params.sharedSectionId });
      res.json(row);
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/shared-sections/:sharedSectionId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId); // ADR 0205 D1
      const ok = await deleteSharedSection(tenantId, orgId, req.params.sharedSectionId);
      if (!ok) throw new OpenwopError('not_found', 'Shared section not found.', 404, { sharedSectionId: req.params.sharedSectionId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── Translator locale grants (ADR 0205 D1) ──
  // Admin-managed narrowing filters over members' CMS writes. Toggle-gated on
  // `cms-localization` (grants are meaningless without authored locales).
  app.get(`${BASE}/locale-grants`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      res.json({ grants: await listLocaleGrants(tenantId, orgId) });
    } catch (err) { next(err); }
  });
  // ADR 0592 §2 (CMSLU-1) — the CALLER's own grant. `workspace:read`, self-
  // scoped (no subject param — no enumeration surface; the list stays admin-
  // tier above). Deliberately NOT toggle-gated: enforcement is unconditional
  // (denyIfTranslator + the PATCH narrowing run regardless of the toggle), so
  // a member's view of their own narrowing must be unconditional too — a
  // translator being 403'd under a disabled toggle deserves to see why.
  app.get(`${BASE}/locale-grants/mine`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      res.json({ grant: await getLocaleGrant(tenantId, orgId, user.userId) });
    } catch (err) { next(err); }
  });
  app.put(`${BASE}/locale-grants`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { subject?: unknown; locales?: unknown };
      // ADR 0592 §9 (CMSL-3) — grant REMOVAL (empty `locales`) is EXEMPT from
      // the toggle gate: enforcement is unconditional (denyIfTranslator + the
      // PATCH narrowing run regardless of the toggle), so disabling the toggle
      // with grants outstanding used to strand those members narrowed with NO
      // admin path to free them. Fail-closed enforcement is the right default;
      // the CLOSABLE lane is the removal, which must always be reachable.
      const isRemoval = Array.isArray(body.locales) && body.locales.length === 0;
      if (!isRemoval) await requireFeatureEnabled(req, 'cms-localization', 'Content localization');
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const grant = await putLocaleGrant(tenantId, orgId, requireString(body.subject, 'subject'), body.locales, user.userId);
      res.json({ grant });
    } catch (err) { next(err); }
  });

  // ── Per-locale publish state (ADR 0205 D2) ──
  // Admin flips one translation locale live/withheld; delivery falls through
  // the RFC 0103 chain for withheld locales (no wire-shape change).
  app.post(`${BASE}/pages/:pageId/locales/:locale/publish`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'cms-localization', 'Content localization');
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      // ADR 0593 CORRECTION (review F2) — RELEASING a withheld locale on a live
      // page IS a publish. Delivery reads `localePublishState` at request time
      // (`localizePage`), so flipping `draft`→`published` instantly serves
      // overlays that were being held back — typically machine drafts — with no
      // approval row anywhere. The CMSA-8 version bump addressed only the
      // in-review pin half of this; the live half was ungated.
      //
      // The REVERSE direction stays open: withholding removes content, which is
      // the fail-safe direction the `unpublish` / `schedule-unpublish` routes
      // are deliberately ungated for. Do not add the gate there by symmetry.
      const target = await getPage(tenantId, orgId, req.params.pageId);
      if (target && await refuseLiveEdit(tenantId, orgId, target.status)) {
        throw liveEditRefusal(
          `the ${req.params.locale} translation of this page`,
          [{ pageId: target.pageId, title: target.title, status: target.status }],
          { pageId: target.pageId, locale: req.params.locale, status: target.status },
        );
      }
      const updated = await setLocalePublishState(tenantId, orgId, req.params.pageId, req.params.locale, 'published', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/pages/:pageId/locales/:locale/unpublish`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'cms-localization', 'Content localization');
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const updated = await setLocalePublishState(tenantId, orgId, req.params.pageId, req.params.locale, 'draft', user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) { next(err); }
  });

  // ── Content language settings (ADR 0064) ──
  // Read is workspace:read (the editor needs the locale set). Write is the
  // admin tier AND gated on the `cms-localization` toggle (default OFF) — so an
  // org can't author locales unless localization is enabled for it; with no
  // authored locales, delivery stays byte-identical to the non-localized CMS.
  app.get(`${BASE}/language-settings`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req,'workspace:read');
      res.json(await getContentLanguageSettings(tenantId, orgId));
    } catch (err) {
      next(err);
    }
  });

  app.put(`${BASE}/language-settings`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'cms-localization', 'Content localization');
      const { user, orgId, tenantId } = await requireCmsScope(req,'host:members:manage');
      const body = (req.body ?? {}) as { baseLocale?: unknown; supportedLocales?: unknown; autoTranslateOnPublish?: unknown };
      // ADR 0592 §9 (CMSL-8) — a baseLocale CHANGE is refused while any page or
      // shared section holds an overlay keyed at the NEW base: after the change
      // every full-sections save of such a page 400s (validateLocalizations
      // forbids an overlay keyed at base) until an editor hand-removes the key,
      // and the old base data would be silently reinterpreted as the new base.
      // 409 names the offenders so the operator can migrate deliberately. The
      // guard lives HERE (feature layer): host/contentLocales must not import
      // features (core-purity), and only cms can see the content.
      const cur = await getContentLanguageSettings(tenantId, orgId);
      if (body.baseLocale !== undefined) {
        const nextBase = String(body.baseLocale);
        if (nextBase !== cur.baseLocale) {
          const offenders: Array<{ kind: 'page' | 'sharedSection'; id: string; title: string }> = [];
          for (const p of await listPages(tenantId, orgId)) {
            // ADR 0593 §C9 (review F1) — the DELIVERABLE sections. A bound
            // snapshot can hold an overlay keyed at the new base that the live
            // page no longer has; this scan exists to stop such an overlay
            // being silently reinterpreted as base content.
            const secs = await deliverableSectionsForPage(p);
            if (secs.some((sec) => sec.localizations?.[nextBase])) {
              offenders.push({ kind: 'page', id: p.pageId, title: p.title });
            }
          }
          for (const sh of await listSharedSections(tenantId, orgId)) {
            if (sh.localizations?.[nextBase]) {
              offenders.push({ kind: 'sharedSection', id: sh.sharedSectionId, title: sh.name });
            }
          }
          if (offenders.length > 0) {
            throw new OpenwopError(
              'conflict',
              `Cannot change the base locale to \`${nextBase}\` while ${offenders.length} item(s) hold overlays keyed at it — remove or migrate those overlays first.`,
              409,
              { baseLocale: nextBase, offenders: offenders.slice(0, 20) },
            );
          }
        }
      }
      // ADR 0593 §C2 (CMSA-10) — the FOURTH live-edit lane, and the one the
      // batch's own class table had written off as "NOT a member — negotiation,
      // not page content". That is the SAME reasoning the adversarial review
      // had already demolished for `localePublishState` ("delivery state, not
      // content"), and it is wrong for the same reason: `localizePage` computes
      // the set it will serve as
      //   `settings.supportedLocales.filter((l) => state[l] !== 'draft')`
      // so `supportedLocales` is the STRICT SUPERSET control over the very map
      // this batch gated two branches up — read live at delivery, at the same
      // `host:members:manage` tier, and it was ungated.
      //
      // Reachable, not theoretical: `validateLocalizations` checks an overlay
      // key against BCP-47 and the base locale but NEVER against
      // `supportedLocales`, so overlays for unconfigured locales are storable
      // (the auto-translate sweep and translate-from-base both write them); an
      // ABSENT `localePublishState` entry MEANS published, so a newly added
      // locale is live by DEFAULT with no withheld-by-default arm; and
      // `resolveSharedRefs` splices a shared row's `localizations` into the
      // delivered page, so the overlay need not even live on the page. One
      // settings write therefore put never-reviewed, typically machine-drafted
      // content in front of the public with the Approvals inbox empty and
      // `page.version` unmoved — so the approve-what-you-saw pin was blind.
      //
      // WIDENING ONLY. Removing a locale takes content OFF the public page:
      // that is the fail-safe direction `unpublish`, `schedule-unpublish` and
      // the locale WITHHOLD arm are all deliberately ungated for. Do not add
      // the gate to the narrowing branch by symmetry — it would rebuild the
      // gate-with-no-exit shape this batch closed elsewhere.
      //
      // A baseLocale CHANGE is deliberately NOT in this scan: it relabels which
      // locale the base `data` answers to rather than releasing an overlay, and
      // the only way it could surface an overlay — a page holding one keyed at
      // the NEW base — is already refused by the ADR 0592 §9 guard above.
      if (Array.isArray(body.supportedLocales)) {
        const nextSupported = [...new Set(body.supportedLocales.map((l) => String(l)))];
        const widening = nextSupported.some((l) => !cur.supportedLocales.includes(l));
        if (widening) {
          const shared = new Map(
            (await listSharedSections(tenantId, orgId)).map((s) => [s.sharedSectionId, s] as const),
          );
          /**
           * ADR 0593 §C9 (review F2) — WHICH OVERLAY KEYS CAN REACH A READER,
           * modelled on `localizePage` + `resolveSection` rather than guessed.
           *
           * The §C8 version asked "is an added tag matched by some overlay",
           * and that over-refused in two ways the §C7 note had explicitly
           * rejected Prescription 1 for: a family locale ALREADY supported
           * (delivery is byte-identical before and after — `pt` was reachable
           * via `pt-BR` negotiation all along), and a family locale WITHHELD on
           * the page (`localizePage` strips it before resolution, so the reader
           * still gets base). A gate that refuses a change with no observable
           * effect is a gate with no reason, and it is the exact shape this ADR
           * keeps having to correct.
           *
           * So the predicate is a genuine BEFORE/AFTER diff over the same
           * algorithm delivery runs. Two consequences worth stating: the
           * widening/narrowing split falls out for free (a narrowing's `after`
           * is a subset of its `before`, so the diff is empty by construction,
           * and the fail-safe direction stays open without a special case);
           * and the keys reported are the MATCHED ones, so the refusal never
           * again names a locale that holds no content (F2b).
           *
           * NOTE the withheld set is derived from the SUPPORTED list of the
           * scenario being modelled, exactly as `localizePage` does: withholding
           * a locale that is not in `supportedLocales` has no delivery effect,
           * so it must not be credited with one here.
           */
          const reachableOverlayKeys = (
            supported: readonly string[],
            state: Record<string, string> | undefined,
            held: ReadonlySet<string>,
          ): Set<string> => {
            const st = state ?? {};
            const withheldKeys = new Set(supported.filter((l) => st[l] === 'draft'));
            const out = new Set<string>();
            for (const l of supported) {
              if (st[l] === 'draft') continue; // not in `deliverable` — nothing negotiates to it
              // resolveSection: exact, then language FAMILY, then base — over
              // the overlay map `localizePage` has already stripped.
              if (held.has(l) && !withheldKeys.has(l)) { out.add(l); continue; }
              if (l.includes('-')) {
                const fam = l.split('-')[0]!;
                if (held.has(fam) && !withheldKeys.has(fam)) out.add(fam);
              }
            }
            return out;
          };
          const candidates: Array<{ pageId: string; title: string; status: string; locales: string[] }> = [];
          for (const p of await listPages(tenantId, orgId)) {
            const held = new Set<string>();
            // §C9 F1 — the DELIVERABLE sections, not merely the live ones: a
            // snapshot bound to a running experiment is served verbatim, and a
            // scan over `page.sections` cannot see it.
            for (const sec of await deliverableSectionsForPage(p)) {
              const overlays = sec.ref
                ? shared.get(sec.ref.sharedSectionId)?.localizations
                : sec.localizations;
              // An EMPTY overlay resolves to `{...base, ...{}}` — i.e. base —
              // so it changes nothing for a reader and must not block (§C8 F9:
              // the presence check is a key COUNT, so `{}` is storable).
              for (const [k, v] of Object.entries(overlays ?? {})) {
                if (v && typeof v === 'object' && Object.keys(v).length > 0) held.add(k);
              }
            }
            const before = reachableOverlayKeys(cur.supportedLocales, p.localePublishState, held);
            const after = reachableOverlayKeys(nextSupported, p.localePublishState, held);
            const releasing = [...after].filter((k) => !before.has(k));
            if (releasing.length > 0) {
              candidates.push({ pageId: p.pageId, title: p.title, status: p.status, locales: releasing });
            }
          }
          const blocking = await blockingLiveEditPages(tenantId, orgId, candidates);
          if (blocking.length > 0) {
            const matched = [...new Set(blocking.flatMap((b) => b.locales))];
            const addedNow = nextSupported.filter((l) => !cur.supportedLocales.includes(l));
            // ADR 0593 §C8 (review F3) + §C9 (F2b) — the refusal names the CHEAP
            // exit, and names it over the locale the operator can actually act
            // on. `liveEditRefusal` only knows how to say "unpublish", which for
            // a mature localized site means taking the whole site offline to
            // change one setting. Withholding the ADDED locale is the real
            // remedy and it works for a family match too: a withheld locale
            // leaves `deliverable` entirely, so nothing negotiates to it and the
            // family overlay becomes unreachable.
            const err = liveEditRefusal(
              `the ${matched.map((l) => `\`${l}\``).join(', ')} translation content this change would publish`,
              blocking,
              { addedLocales: addedNow, matchedOverlayLocales: matched, pages: blocking, remedy: 'withhold-then-add' },
            );
            err.message += ` Withhold ${addedNow.length === 1 ? `\`${addedNow[0]}\`` : 'each new locale'} on those pages first (POST …/pages/:pageId/locales/:locale/unpublish), then add the locale and release each page through review.`;
            throw err;
          }
        }
      }
      res.json(await updateContentLanguageSettings(tenantId, orgId, body, user.userId));
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
      const { user, tenantId } = await requireCmsScope(req,'workspace:write');
      const b = (req.body ?? {}) as { sectionType?: unknown; data?: unknown; targetLocale?: unknown };
      const sectionType = String(b.sectionType ?? '');
      if (!SECTION_TYPES.includes(sectionType as SectionType)) {
        throw new OpenwopError('validation_error', `sectionType must be one of: ${SECTION_TYPES.join(', ')}`, 400, { sectionType: b.sectionType });
      }
      const targetLocale = String(b.targetLocale ?? '');
      if (!LOCALE_RE.test(targetLocale)) {
        throw new OpenwopError('validation_error', 'Invalid targetLocale (expected BCP-47, e.g. "es", "pt-BR").', 400, { targetLocale });
      }
      // ADR 0205 D1 — a translator may only AI-draft into granted locales.
      {
        const { orgId } = await requireCmsScope(req, 'workspace:read');
        const grant = await getLocaleGrant(tenantId, orgId, user.userId);
        if (grant && !grant.locales.includes(targetLocale)) {
          throw new OpenwopError('forbidden_scope', `Your translator grant is limited to [${grant.locales.join(', ')}].`, 403, { targetLocale, grantedLocales: grant.locales });
        }
      }
      const data = (typeof b.data === 'object' && b.data !== null ? b.data : {}) as Record<string, unknown>;
      try {
        const overlay = await translateSectionData(tenantId, sectionType as SectionType, data, targetLocale);
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
