/**
 * CMS-R2-3 — the "Edit this page" affordance on a PUBLISHED public page.
 *
 * Scope decided by the round-4 research (cited in `UX_UPGRADE-content.md`):
 * true on-published-page editing is rare and RETREATING — only Framer ships
 * it, and Webflow is deprecating its `/?edit` equivalent in favour of editing
 * inside the admin canvas. The field's live pattern is WordPress's toolbar
 * tier: a jump link from the live page into the editor. We already have the
 * two capabilities that make a heavier surface unnecessary — an admin preview
 * of the REAL section tree with preview→editor click-through (CMS-R2-1), and
 * the Framer-tier approval gate (ADR 0066) — so this is the jump link, NOT a
 * contentEditable overlay on live content.
 *
 * Two rules this component exists to honour:
 *
 * 1. **An anonymous visitor costs ZERO requests.** Public pages are the
 *    highest-traffic surface in the app and `middleware/rateLimit.ts` budgets
 *    per IP; a probe on every public view would be a self-inflicted 429 wall.
 *    The signed-in check is client-side and free, and gates the probe.
 * 2. **The probe IS the authorization.** The authorized by-slug read is
 *    org-RBAC'd server-side, so a 200 proves the caller can reach this page in
 *    the CMS and yields its pageId; anything else renders nothing at all.
 *    Absence makes no claim (an enrichment affordance, never an error).
 *
 * Residual, stated: `workspace:read` is what the probe proves, so a
 * read-only member sees the link and the editor refuses their save with the
 * existing 403 toast — the editor has always been the authority on write
 * (see `CmsPage`'s docblock). Narrowing the probe to write authority needs a
 * capability endpoint that does not exist yet; recorded, not pretended.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/useAuth.js';
import { PencilIcon } from '../../ui/icons/index.js';
import { getAuthoredPageBySlug } from '../cms/cmsClient.js';

export function EditThisPageLink({ orgId, slug }: { orgId: string; slug: string }): JSX.Element | null {
  const { t } = useTranslation('site');
  const { user, loading } = useAuth();
  const [pageId, setPageId] = useState<string | null>(null);

  useEffect(() => {
    // Rule 1: no session ⇒ no request, ever.
    if (loading || !user || !orgId || !slug) { setPageId(null); return; }
    let cancelled = false;
    void getAuthoredPageBySlug(orgId, slug).then((p) => {
      if (!cancelled) setPageId(p?.pageId ?? null);
    });
    return () => { cancelled = true; };
  }, [user, loading, orgId, slug]);

  if (!pageId) return null;
  const label = t('editThisPage');
  return (
    <Link
      className="btn-ghost btn-sm cms-edit-this-page"
      to={`/cms/${encodeURIComponent(orgId)}/${encodeURIComponent(pageId)}`}
      aria-label={label}
    >
      <PencilIcon size={13} aria-hidden />
      <span className="cms-edit-this-page__label">{label}</span>
    </Link>
  );
}
