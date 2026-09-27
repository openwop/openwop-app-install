/**
 * Sharing (host-extension product feature — ADR 0013).
 *
 * Always-on since ADR 0434 (org-scoped RBAC is the gate). An org picker → a "create a share link"
 * form (resource type → resource → optional label + expiry) → the org's active
 * links + revoke. ADR 0448 P2: tokens are hashed at rest, so the PUBLIC URL is
 * shown (and auto-copied) exactly ONCE at mint — the list identifies links by
 * fingerprint and cannot re-reveal a URL. The link resolves a
 * read-only view of the resource publicly (incl. a CMS DRAFT — the preview-link
 * use-case the published-only public surface can't serve).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import i18n from '../../i18n/index.js';
import { formatDate, formatDateTime } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { GlobeIcon, LockIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import {
  createLink,
  listLinks,
  listOrgs,
  listResources,
  revokeLink,
  listFrameViews,
  sharedPageUrl,
  linkStatus,
  isLinkLive,
  type LinkStatus,
  type Org,
  type ResourceRef,
  type ResourceType,
  type ShareLink,
} from './sharingClient.js';

/** SHARE-UX-2 — status → chip class + label key (DESIGN.md §5.3). A row carried
 *  NO status of any kind before this; the only signal was "expires {{date}}",
 *  which read as reassuring even when the date was in the past. */
const STATUS_CHIP: Record<LinkStatus, { className: string; key: string }> = {
  live: { className: 'chip chip--success', key: 'statusLive' },
  expiring: { className: 'chip chip--warning', key: 'statusExpiring' },
  expired: { className: 'chip chip--muted', key: 'statusExpired' },
  revoked: { className: 'chip chip--muted', key: 'statusRevoked' },
  orphaned: { className: 'chip chip--warning', key: 'statusOrphaned' },
  'cap-reached': { className: 'chip chip--muted', key: 'statusCapReached' },
  'feature-off': { className: 'chip chip--warning', key: 'statusFeatureOff' },
};

const TYPE_LABEL_KEY: Record<ResourceType, string> = { cms_page: 'typeCmsPage', kb_collection: 'typeKbCollection', document: 'typeDocument', conversation: 'typeConversation', prompt: 'typePrompt', commerce_quote: 'typeCommerceQuote', commerce_order: 'typeCommerceOrder', app_builder_canvas: 'typeAppBuilderCanvas', slides_canvas: 'typeSlidesCanvas', creative_brief: 'typeCreativeBrief', booking_manage: 'typeBookingManage', sign_request: 'typeSignRequest' };

/** R2 SR-5 — links the APP mints in feature flows (booking confirmations, sign
 *  invites, order-status emails), as opposed to links a person minted here.
 *  They land in the same org list; unlabeled they read as mystery rows. */
const SYSTEM_TYPES: ReadonlySet<ResourceType> = new Set(['booking_manage', 'sign_request', 'commerce_order']);

/** R2 SR-5 — simple paging cap so a big org doesn't render hundreds of cards. */
const PAGE_SIZE = 30;

/** R2 SR-4 — mirror of the backend's `expiresInDays` rule (integer 1–3650),
 *  validated HERE so bad input gets a named field error instead of being
 *  silently dropped from the mint (the old behaviour: '7 days' → no expiry,
 *  success toast). Returns the parsed value, or null for empty, or 'invalid'. */
function parseExpiry(raw: string): number | null | 'invalid' {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'invalid';
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 'invalid';
}

/** ADR 0328 P7 — lazy per-slide view tallies for a shared deck link. */
export function FrameViewsRow({ orgId, token }: { orgId: string; token: string }): JSX.Element {
  const { t } = useTranslation('sharing');
  const [frames, setFrames] = useState<{ frame: number; count: number }[] | 'error' | null>(null);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    setOpen((v) => !v);
    if (frames || inFlight.current) return;
    inFlight.current = true;
    // SH-R2-1 — a failed views read must not render the "no views yet"
    // claim; the 'error' sentinel gets its own label.
    try { setFrames(await listFrameViews(orgId, token)); }
    catch { setFrames('error'); }
    finally { inFlight.current = false; }
  }, [frames, orgId, token]);
  const max = Math.max(1, ...(Array.isArray(frames) ? frames : []).map((f) => f.count));
  return (
    <div className="sharing-frameviews">
      <Button variant="quiet" size="sm" aria-expanded={open} onClick={() => void load()}>
        {t('frameViewsToggle')}
      </Button>
      {open ? (
        frames === null ? <span className="u-label-sm">{t('frameViewsLoading')}</span>
        : frames === 'error' ? <span className="u-label-sm">{t('frameViewsUnavailable')}</span>
        : frames.length === 0 ? <span className="u-label-sm">{t('frameViewsEmpty')}</span>
        : (
          <ul className="sharing-frameviews__list">
            {frames.map((f) => (
              <li key={f.frame} className="sharing-frameviews__row">
                <span className="sharing-frameviews__label">{t('frameViewsSlide', { n: f.frame + 1 })}</span>
                <span className="sharing-frameviews__bar" style={{ inlineSize: `${Math.round((f.count / max) * 100)}%` }} aria-hidden="true" />
                <span className="sharing-frameviews__count">{f.count}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** Re-copy from the minted-URL notice. The helper owns BOTH toasts here (the URL
 *  is already on screen, so a failure needs no extra recovery affordance). */
async function copy(text: string): Promise<void> {
  await copyToClipboard(text, i18n.t('sharing:linkCopied'));
}

export function SharingPage(): JSX.Element {
  const { t } = useTranslation('sharing');
  const access = { enabled: true, loading: false }; // always-on (toggle graduated, ADR 0434)
  // `.catch(() => setOrgs([]))` rendered the "No organizations — create one
  // first" instruction over a failed read, and left `orgId` '' so the page's
  // own read never started. Both facts, one value.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [linkList, setLinkList] = useState<ShareLink[] | null>(null);
  /** R2 SR-6 — the links read failed: distinct from loading (null) and empty. */
  const [linksFailed, setLinksFailed] = useState(false);
  /** The pickable-resource read failed — distinct from "this org has none". */
  const [resourcesFailed, setResourcesFailed] = useState(false);

  // mint form
  const [resourceType, setResourceType] = useState<ResourceType>('cms_page');
  // §4.5 collection search (DESIGN.md rule 13) — matches the link's label /
  // card title / resource id.
  const [query, setQuery] = useState('');
  const [resources, setResources] = useState<ResourceRef[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [expiryError, setExpiryError] = useState('');
  const [busy, setBusy] = useState(false);
  // R2 SR-5 — mine/system split + paging.
  const [showSystem, setShowSystem] = useState(false);
  /** SHARE-UX-2 — expired/revoked links, collapsed but reachable. */
  const [showDead, setShowDead] = useState(false);
  const [page, setPage] = useState(1);
  /** SHARE-UX-3 — did the auto-copy actually happen? The minted URL is
   *  unrepeatable (ADR 0448 P2), so the answer changes what the notice says. */
  const [copyFailed, setCopyFailed] = useState(false);
  // ADR 0448 P2 — the raw URL exists only in the mint response; hold it until
  // dismissed so the owner can copy it (it can never be re-read).
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
  }, [access.enabled]);

  const loadLinks = useCallback((org: string) => {
    // R2 SR-6 — the old catch stored a RAW e.message in a top-of-page notice
    // and left the skeleton up forever. Designed failed state + retry instead.
    setLinksFailed(false);
    void listLinks(org).then(setLinkList).catch(() => setLinksFailed(true));
  }, []);

  useEffect(() => { if (orgId) { setLinkList(null); setMintedUrl(null); setPage(1); setShowSystem(false); loadLinks(orgId); } }, [orgId, loadLinks]); // grade fix #5: a minted URL never lingers across orgs

  // Load pickable resources whenever org or type changes (guard stale resolves).
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    setResourceId('');
    setResourcesFailed(false);
    // `[]` here rendered a picker holding only its placeholder, with Create
    // `disabled={!resourceId}` — a form that LOOKS operable, cannot be
    // submitted, and says nothing about why. The list is a write input, so its
    // failure has to be visible.
    void listResources(orgId, resourceType).then((r) => { if (active) setResources(r); })
      .catch(() => { if (active) { setResources([]); setResourcesFailed(true); } });
    return () => { active = false; };
  }, [orgId, resourceType]);

  const create = useCallback(async () => {
    if (!orgId || !resourceId) return;
    // R2 SR-4 — a bad expiry used to be SILENTLY dropped (the link minted
    // never-expiring, success toast and all). Named field error, no mint.
    const days = parseExpiry(expiry);
    if (days === 'invalid') { setExpiryError(t('expiryInvalid')); return; }
    setExpiryError('');
    setBusy(true);
    try {
      const minted = await createLink(orgId, {
        resourceType,
        resourceId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(days !== null ? { expiresInDays: days } : {}),
      });
      const url = sharedPageUrl(minted.token);
      setMintedUrl(url);
      setLabel(''); setExpiry(''); setResourceId('');
      loadLinks(orgId);
      // SHARE-UX-3 — the claim now depends on the outcome. This used to be a
      // fire-and-forget `copy(url)` followed by an UNCONDITIONAL "URL copied to
      // your clipboard", so in any non-secure context the user got the copy
      // helper's failure toast AND a success toast asserting the copy happened —
      // for a token ADR 0448 P2 guarantees can never be re-read. `null`
      // suppresses the helper's own success toast (this one is more specific);
      // its FAILURE toast is not suppressible by design.
      const res = await copyToClipboard(url, null);
      setCopyFailed(!res.ok);
      // R2 review F6 — the WORDS stopped lying here but the CHANNEL still did:
      // "it could NOT be copied" was shipped through `toast.success`, i.e. a
      // green tick that auto-dismisses in 4s, for the one message the user must
      // act on before the (unrepeatable) token is gone. Variant follows outcome.
      if (res.ok) toast.success(t('linkCreatedCopied'));
      else toast.warning(t('linkCreatedNotCopied'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, resourceType, resourceId, label, expiry, loadLinks, t]);

  const revoke = useCallback(async (token: string) => {
    if (!(await confirm({ title: t('revokeShareConfirm'), danger: true, confirmLabel: t('revokeLinkLabel') }))) return;
    // R2 SR-9 — announce the success: the only feedback used to be a row
    // quietly disappearing, which a screen-reader user never hears.
    try { await revokeLink(orgId, token); loadLinks(orgId); toast.success(t('revokeDone')); }
    catch { toast.error(t('revokeFailed')); }
  }, [orgId, loadLinks, t]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  // R2 SR-7 — the server has always counted views (PUB-7) and honoured a view
  // cap; the owner finally sees both ("did anyone look?" is this page's job).
  const renderRow = (l: ShareLink): JSX.Element => {
    const status = linkStatus(l);
    const chip = STATUS_CHIP[status];
    return (
    <div key={l.tokenHash} className="surface-inset sharing-link">
      <div className="u-flex u-gap-2 u-items-center u-wrap">
        <span className="chip">{t(TYPE_LABEL_KEY[l.resourceType])}</span>
        {/* SHARE-UX-2 — every row states whether it still works. */}
        <span className={chip.className}>{t(chip.key)}</span>
        <strong className="sharing-link-title">{l.label ?? l.cardTitle ?? l.resourceId}</strong>
        <span className="u-flex-1" />
        {/* The date is now a DETAIL under a status, not the only signal — and it
            says "expired" in the past tense rather than promising an expiry that
            already happened. */}
        {l.expiresAt ? (
          <span className="u-label-sm" title={formatDateTime(l.expiresAt)}>
            {status === 'expired'
              ? t('expiredAt', { date: formatDate(l.expiresAt) })
              : t('expiresAt', { date: formatDate(l.expiresAt) })}
          </span>
        ) : null}
        {/* SHARE-UX-1 (owner half) — the orphan is named on the row that used to
            render a raw opaque id and nothing else. */}
        <Button variant="quiet" title={t('revokeLinkLabel')} aria-label={t('revokeLinkLabel')} onClick={() => void revoke(l.tokenHash)} disabled={l.revoked}><TrashIcon /></Button>
      </div>
      {status === 'orphaned' ? (
        <span className="u-label-sm">{t('resourceMissingBody')}</span>
      ) : null}
      {/* SHARE-1 HONESTY — an admin turned this link's owning feature off, so the
          public URL 404s. Named on the row, with what to do about it: this is the
          one dead state that is fully reversible, and the owner cannot guess it
          from anything else the row shows. */}
      {status === 'feature-off' ? (
        <span className="u-label-sm">{t('featureOffBody', { feature: t(TYPE_LABEL_KEY[l.resourceType]) })}</span>
      ) : null}
      {/* SHUX-5 — a spent view budget is terminal and IRREVERSIBLE (the count only
          climbs), so say so plainly rather than leaving the owner to compare
          "Seen 3 times" against "view cap 3" themselves. */}
      {status === 'cap-reached' ? (
        <span className="u-label-sm">{t('capReachedBody', { n: l.maxViews ?? 0 })}</span>
      ) : null}
      <div className="u-flex u-gap-2 u-items-center u-wrap u-label-sm">
        <span>{t('seenCount', { count: l.viewCount ?? 0 })}</span>
        {/* R3-SH1 — the WHEN of "who/when last viewed" (Dropbox viewer-info,
            downmarket per the R2 catalog). Rendered only once a view exists —
            no fabricated "never" state; absence of the stamp IS the answer. */}
        {l.lastViewedAt ? <span title={formatDateTime(l.lastViewedAt)}>{t('lastSeenOn', { date: formatDate(l.lastViewedAt) })}</span> : null}
        {typeof l.maxViews === 'number' ? <span>{t('viewCapLabel', { n: l.maxViews })}</span> : null}
        <span title={formatDateTime(l.createdAt)}>{t('createdOn', { date: formatDate(l.createdAt) })}</span>
      </div>
      {/* ADR 0448 P2 — hashed at rest: the URL was shown once at mint;
          the fingerprint identifies the link for support/revocation. */}
      <code className="sharing-link-url" title={t('fingerprintTitle')}>{t('fingerprintLabel', { fingerprint: l.tokenHash.slice(0, 12) })}</code>
      {/* ADR 0328 P7 — per-frame view analytics for shared decks. */}
      {l.resourceType === 'slides_canvas' ? <FrameViewsRow orgId={orgId} token={l.tokenHash} /> : null}
    </div>
    );
  };

  // SHARE-UX-2 — "Active" now means what it says. The old filter was
  // `!l.revoked`, so an expired link rendered under a heading asserting it was
  // active, with the words "expires <past date>" beneath it. Dead links are not
  // hidden (the owner still needs to find and understand them) — they are moved
  // into their own collapsed section.
  const all = linkList ?? [];
  const active = all.filter((l) => isLinkLive(l));
  const dead = all.filter((l) => !isLinkLive(l));
  // R2 SR-5 — links a person minted here vs links the app minted in feature
  // flows (booking/sign/order). One unlabeled list read as mystery rows.
  const mine = active.filter((l) => !SYSTEM_TYPES.has(l.resourceType));
  const system = active.filter((l) => SYSTEM_TYPES.has(l.resourceType));
  const visibleLinks = mine.filter((l) => {
    const q = query.trim().toLowerCase();
    return !q || (l.label ?? l.cardTitle ?? l.resourceId).toLowerCase().includes(q);
  });
  const pagedLinks = visibleLinks.slice(0, page * PAGE_SIZE);

  return (
    <div data-walkthrough="sharing.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s now. This page had the order inverted (the
          skeleton was checked ABOVE the zero-org branch); taking the whole
          sharing layout as the CHILD is what makes the right order unskippable.
          The links read is gated on `orgId`, so with no organization it never
          starts and `linkList` stays `null` — its own skeleton below is the
          loading affordance, keyed on that sentinel and not on `orgs`. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<GlobeIcon />}>
        <div className="sharing-layout">
          {/* Mint form — a real <form> so Enter submits (SHARE-2). */}
          <form className="surface-card u-gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <h2 className="u-fs-16 u-m-0">{t('mintTitle')}</h2>
            {/* SHARE-UX-3/9 — the ONE moment the raw token exists. It is
                announced (a conditionally-mounted Notice speaks nothing —
                `ui/Notice.tsx`), and when the clipboard write failed it says so
                and leans on the URL being on screen, selectable, instead of
                claiming a copy that did not happen. */}
            {mintedUrl && (
              <Notice
                variant={copyFailed ? 'warning' : 'info'}
                announce={copyFailed ? t('linkMintedCopyFailed') : t('linkMintedOnce')}
              >
                {copyFailed ? t('linkMintedCopyFailed') : t('linkMintedOnce')} <code className="sharing-link-url">{mintedUrl}</code>{' '}
                <Button variant="quiet" size="sm" onClick={() => void copy(mintedUrl)}>{t('copyLinkLabel')}</Button>
                <Button variant="quiet" size="sm" onClick={() => { setMintedUrl(null); setCopyFailed(false); }} aria-label={t('dismissMinted')}>{t('dismissMinted')}</Button>
              </Notice>
            )}
            <SelectField label={t('fieldResourceType')} value={resourceType} onChange={(e) => setResourceType(e.target.value as ResourceType)}>
              <option value="cms_page">{t('typeCmsPage')}</option>
              <option value="kb_collection">{t('typeKbCollection')}</option>
              <option value="document">{t('typeDocument')}</option>
              <option value="conversation">{t('typeConversation')}</option>
              <option value="prompt">{t('typePrompt')}</option>
              <option value="creative_brief">{t('typeCreativeBrief')}</option>
            </SelectField>
            <SelectField label={t('fieldResource')} value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">{resourcesFailed ? t('resourcesFailed') : t('resourcePlaceholder')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </SelectField>
            <TextField label={t('fieldLabel')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('labelPlaceholder')} />
            <TextField label={t('fieldExpiry')} value={expiry} onChange={(e) => { setExpiry(e.target.value); if (expiryError) setExpiryError(''); }} inputMode="numeric" placeholder={t('expiryPlaceholder')} error={expiryError || undefined} />
            <div className="u-flex u-justify-end">
              <Button variant="primary" type="submit" disabled={busy || !resourceId}><PlusIcon /> {t('createLink')}</Button>
            </div>
          </form>

          {/* Active links */}
          <div className="surface-card u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <h2 className="u-fs-16 u-m-0">{t('activeTitle')}</h2>
              {active.length > 3 ? (
                <input
                  type="search"
                  className="ui-input filterbar-search u-ml-auto"
                  placeholder={t('filterPlaceholder')}
                  aria-label={t('filterAria')}
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                />
              ) : null}
            </div>
            {linksFailed ? (
              // R2 SR-6 — the read failed: say so and offer retry, never the
              // eternal skeleton (and never "no links" — links may exist).
              <StateCard
                icon={<GlobeIcon />}
                announce
                title={t('linksFailedTitle')}
                body={t('linksFailedBody')}
                action={<Button variant="secondary" onClick={() => loadLinks(orgId)}>{t('retryLabel')}</Button>}
              />
            ) : !linkList ? <Skeleton /> : active.length === 0 ? <span className="u-label-sm">{t('noActiveLinks')}</span>
              : (
              <>
                {mine.length > 0 && visibleLinks.length === 0 ? (
                  <span className="u-flex u-items-center u-gap-2 u-label-sm">
                    {t('noMatchBody')}
                    <Button variant="quiet" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
                  </span>
                ) : null}
                {/* Review F3 — every active link is app-minted: without this
                    line the main area is an unlabeled void above the toggle. */}
                {mine.length === 0 && system.length > 0 ? (
                  <span className="u-label-sm">{t('noMineLinks')}</span>
                ) : null}
                {pagedLinks.map((l) => renderRow(l))}
                {visibleLinks.length > pagedLinks.length ? (
                  <div className="u-flex u-justify-center">
                    <Button variant="quiet" size="sm" onClick={() => setPage((p) => p + 1)}>
                      {t('showMoreLinks', { n: visibleLinks.length - pagedLinks.length })}
                    </Button>
                  </div>
                ) : null}
                {/* R2 SR-5 — app-minted capability links (booking confirmations,
                    sign invites, order status). Real, revocable, but not links a
                    person minted — labeled + collapsed so they stop reading as
                    mystery rows in the main list. */}
                {system.length > 0 ? (
                  <div className="u-grid u-gap-2 u-pt-3 u-border-t">
                    <Button variant="quiet" size="sm" aria-expanded={showSystem} onClick={() => setShowSystem((v) => !v)}>
                      {t('systemLinksToggle', { n: system.length })}
                    </Button>
                    {showSystem ? system.map((l) => renderRow(l)) : null}
                  </div>
                ) : null}
              </>
            )}
            {/* SHARE-UX-2 — expired + revoked links, out of "Active" but not
                out of sight: the owner needs to see that a link they sent is
                dead, which is exactly what the old list hid by rendering it as
                active. */}
            {dead.length > 0 ? (
              <div className="u-grid u-gap-2 u-pt-3 u-border-t">
                <Button variant="quiet" size="sm" aria-expanded={showDead} onClick={() => setShowDead((v) => !v)}>
                  {t('deadLinksToggle', { n: dead.length })}
                </Button>
                {showDead ? dead.map((l) => renderRow(l)) : null}
              </div>
            ) : null}
          </div>
        </div>
      </OrgSelectionState>
    </div>
  );
}
