/**
 * ADR 0122 Phase 6 — the PUBLIC, read-only viewer for a share token.
 *
 * Rendered in the bare PublicShell above AppGate (anonymous-reachable), so a
 * recipient of a `/shared/:token` link sees a rendered page, not raw JSON. The
 * unguessable token is the credential; the backend already enforces owner-only
 * mint + a point-in-time snapshot, so this view adds no authz of its own. Content
 * renders through the shared XSS-safe `ui/Markdown` (no raw HTML, no composer).
 *
 * @see docs/adr/0122-shared-public-conversation-links.md
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useBrand } from '../../brand/BrandProvider.js';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { applyUnlistedHead } from '../site/siteSeo.js';
import { Markdown } from '../../ui/Markdown.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { LinkIcon } from '../../ui/icons/index.js';
import { Button } from '../../ui/Button.js';
import { resolveSharedPublic, type SharedResolveFailure, type SharedResource } from './sharingClient.js';
import { SharedQuoteView } from './SharedQuoteView.js';

// ADR 0305 Phase D — the interactive app-design walkthrough. Lazy: the public
// chunk stays lean for the common markdown-shaped resources.
const AppBuilderInteractiveViewer = lazy(() =>
  import('../../chat/artifacts/AppBuilderInteractiveViewer.js').then((m) => ({ default: m.AppBuilderInteractiveViewer })));
// ADR 0328 P7 — the notes-free shared deck pager, same lazy posture.
const SharedDeckViewer = lazy(() => import('../slides/SharedDeckViewer.js').then((m) => ({ default: m.SharedDeckViewer })));

/** Centered reading column shared by the loading skeleton and the resolved view,
 *  so resolving the share doesn't shift the layout. */
const COLUMN_STYLE: React.CSSProperties = { maxWidth: '46rem' };

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** SHUX-4 — types whose real public surface lives elsewhere and takes the same
 *  token. Anything listed here is redirected instead of rendered. */
const DEDICATED_ROUTE: Partial<Record<string, (token: string) => string>> = {
  booking_manage: (tok) => `/book/manage/${encodeURIComponent(tok)}`,
  sign_request: (tok) => `/sign/${encodeURIComponent(tok)}`,
};

/** The markdown body for each resource type the public surface resolves. */
function bodyFor(shared: SharedResource): { title: string; markdown: string } {
  const r = shared.resource;
  switch (shared.resourceType) {
    case 'conversation':
      return { title: asString(r.title), markdown: asString(r.markdown) };
    case 'prompt':
      return { title: asString(r.name), markdown: asString(r.description) ? `${asString(r.description)}\n\n${asString(r.body)}` : asString(r.body) };
    case 'document':
      return { title: asString(r.title), markdown: asString(r.markdown) || asString(r.content) || asString(r.body) };
    default:
      return { title: asString(r.title) || asString(r.name), markdown: asString(r.markdown) || asString(r.body) };
  }
}

/**
 * ONE chrome for every shared resource type. The four render branches below
 * previously each carried their own copy of the header + footer, which is how a
 * new line (like the snapshot notice) gets added to three of four by accident.
 */
function ShareFrame({ title, snapshotAt, expiresAt, children }: {
  title: string; snapshotAt?: string | undefined; expiresAt?: string | undefined; children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('sharing');
  const brand = useBrand();
  const fmt = useFormat();
  return (
    <article className="u-p-4 u-mx-auto page-enter" style={COLUMN_STYLE}>
      <header className="u-flex u-flex-col u-gap-2 u-mb-4">
        <span className="chip chip--muted u-fs-11 u-self-start">{t('publicReadOnly', { defaultValue: 'Read-only shared view' })}</span>
        {/* SHUX-10 — the quote branch passes `title=""` because `SharedQuoteView`
            renders its own <h1>. Emitting this unconditionally produced an EMPTY
            top-level heading immediately followed by a real one. */}
        {title ? <h1 className="page-header__title">{title}</h1> : null}
        {/* SH-G2, corrected in R2 (SR-3) — only a type the server actually
            snapshots (conversations) may claim a snapshot date. Everything
            else is a LIVE view of the current content, and saying THAT is the
            honest version of the same disclosure. */}
        <p className="muted u-fs-11 u-m-0">
          {snapshotAt
            ? t('publicSnapshotAt', { defaultValue: 'Snapshot from {{when}}', when: fmt.date(snapshotAt) })
            : t('publicLiveView', { defaultValue: 'Live view — the owner can still change this content' })}
          {expiresAt ? ` · ${t('publicExpiresAt', { defaultValue: 'link expires {{when}}', when: fmt.date(expiresAt) })}` : ''}
        </p>
      </header>
      {children}
      {/* CONT-10: a shared link is often someone's first contact with the install —
          close with the brand mark so the page isn't anonymous. */}
      <footer className="u-mt-4 u-pt-3 u-border-t muted u-fs-11">
        {t('publicPoweredBy', { defaultValue: 'Shared from' })} <strong>{brand.productName}</strong>
      </footer>
    </article>
  );
}

export function SharedSharePage({ token }: { token: string }): JSX.Element {
  const { t } = useTranslation('sharing');
  // Hook above the early returns (rules-of-hooks).
  const brand = useBrand();
  const [shared, setShared] = useState<SharedResource | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'gone' | 'resourceGone' | 'expired' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    void resolveSharedPublic(token)
      .then((s) => {
        if (!active) return;
        // SHUX-4 — `booking_manage` and `sign_request` have no markdown body, so
        // they fell through to the generic branch and rendered "Nothing to show
        // here." on a page whose only other reading is "your booking/signature
        // link is broken". Their real surfaces are `/book/manage/:token` and
        // `/sign/:token`, which take THIS SAME token and carry the actions the
        // recipient actually needs (reschedule grid, ICS, the signing flow).
        // Redirect rather than render a degraded read-only copy of either.
        const dedicated = DEDICATED_ROUTE[s.resourceType];
        if (dedicated) { window.location.replace(dedicated(token)); return; }
        setShared(s);
        setStatus('ready');
      })
      .catch((e: Error & { kind?: SharedResolveFailure }) => {
        // R2 SR-2 — the client discriminates; the page must not throw that
        // away: a network blip told a quote recipient the offer was revoked.
        // SHARE-UX-1 adds the fourth case: the link is FINE and the content it
        // pointed at was deleted. Blaming the owner for that was a false claim,
        // and one they could not correct because nothing told them either.
        if (!active) return;
        setStatus(
          e.kind === 'expired' ? 'expired'
            : e.kind === 'resourceGone' ? 'resourceGone'
              : e.kind === 'gone' ? 'gone'
                : 'failed',
        );
      });
    return () => { active = false; };
  }, [token, attempt]);

  // SH-G3 — a capability-token URL must never be indexed if it leaks, and the
  // tab deserves a real name rather than the app's default.
  const headTitle = shared ? (bodyFor(shared).title || shared.label || brand.productName) : brand.productName;
  useEffect(() => applyUnlistedHead(headTitle), [headTitle]);

  if (status === 'loading') {
    // Designed loading state — mirror the article (chip · title · transcript
    // lines) at the same column width so resolving the share never shifts layout.
    return (
      <div role="status" className="u-p-4 u-mx-auto" style={COLUMN_STYLE} aria-busy="true" aria-label={t('publicLoading', { defaultValue: 'Loading the shared view' })}>
        <div className="u-flex u-flex-col u-gap-1 u-mb-3">
          <Skeleton width={120} height={18} radius={999} />
          <Skeleton width="70%" height={26} />
        </div>
        <div className="u-flex u-flex-col u-gap-2">
          {['96%', '88%', '92%', '70%', '84%', '60%'].map((w, i) => <Skeleton key={i} width={w} height={13} />)}
        </div>
      </div>
    );
  }

  // R2 SR-2 — a failed READ is not a dead link: designed retryable state.
  if (status === 'failed') {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<LinkIcon size={28} />}
          announce
          title={t('publicLoadFailedTitle', { defaultValue: 'Couldn’t load this shared view' })}
          body={t('publicLoadFailedBody', { defaultValue: 'Something went wrong on our end — the link most likely still works. Try again.' })}
          action={<Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>{t('publicRetry', { defaultValue: 'Retry' })}</Button>}
        />
      </div>
    );
  }

  // R2 SR-10 — an expired link says SO (the server's 410); revoked and
  // never-existed stay one uniform message by design (token-validity oracle).
  if (status === 'expired') {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<LinkIcon size={28} />}
          announce
          title={t('publicExpiredTitle', { defaultValue: 'This link has expired' })}
          body={t('publicExpiredBody', { defaultValue: 'The owner set an expiry on this link and it has passed. Ask them for a fresh link.' })}
        />
      </div>
    );
  }

  // SHARE-UX-1 — the link is intact; the content it referenced was deleted.
  // Saying so leaks nothing the recipient did not already have (they hold a
  // valid token), and it is the difference between "someone cut you off" and
  // "the thing is gone" — which changes what they do next.
  if (status === 'resourceGone') {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<LinkIcon size={28} />}
          announce
          title={t('publicResourceGoneTitle', { defaultValue: 'This shared content was deleted' })}
          body={t('publicResourceGoneBody', { defaultValue: 'The link still works, but the page, document or design it pointed to no longer exists. Ask whoever shared it for an up-to-date link.' })}
        />
      </div>
    );
  }

  if (status === 'gone' || !shared) {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<LinkIcon size={28} />}
          announce
          title={t('publicGoneTitle', { defaultValue: 'This link is no longer available' })}
          body={t('publicGoneBody')}
        />
      </div>
    );
  }

  // C3 (ecommerce gap plan) — a shared quote is an OFFER, not an article: render
  // the line items + the accept action (token = the capability proof).
  if (shared.resourceType === 'commerce_quote') {
    // A quote carries its own heading + actions, so it takes the frame's chrome
    // WITHOUT the generic title row.
    return (
      <ShareFrame title="" snapshotAt={shared.snapshotAt} expiresAt={shared.expiresAt}>
        <SharedQuoteView token={token} resource={shared.resource} />
      </ShareFrame>
    );
  }

  // ADR 0305 Phase D — a shared app design renders as the interactive viewer
  // (screen tabs + navigateTo tap-through), not markdown.
  if (shared.resourceType === 'app_builder_canvas') {
    const app = (shared.resource.app ?? {}) as Record<string, unknown>;
    return (
      <ShareFrame
        title={asString(shared.resource.title) || shared.label || t('publicUntitled', { defaultValue: 'Shared app design' })}
        snapshotAt={shared.snapshotAt}
        expiresAt={shared.expiresAt}
      >
        <Suspense fallback={<Skeleton />}>
          <AppBuilderInteractiveViewer app={app} />
        </Suspense>
      </ShareFrame>
    );
  }

  // ADR 0328 P7 — a shared slide DECK renders as the notes-free one-frame
  // pager (SlideFrame — the S7 audience posture), with per-frame analytics.
  if (shared.resourceType === 'slides_canvas') {
    const deck = (shared.resource.deck ?? {}) as Record<string, unknown>;
    return (
      <ShareFrame
        title={asString(shared.resource.title) || shared.label || t('publicUntitled', { defaultValue: 'Shared slide deck' })}
        snapshotAt={shared.snapshotAt}
        expiresAt={shared.expiresAt}
      >
        <Suspense fallback={<Skeleton />}>
          <SharedDeckViewer token={token} deck={deck} />
        </Suspense>
      </ShareFrame>
    );
  }

  const { title, markdown } = bodyFor(shared);
  // DOCTPL-2 — public attribution: a model-drafted document published to the
  // open internet must say so. The server exposes the producer KIND only
  // (`producedByKind` on the document projection); no internal ids reach here.
  const producedByKind = shared.resourceType === 'document' ? asString(shared.resource.producedByKind) : '';
  return (
    <ShareFrame
      title={title || shared.label || t('publicUntitled', { defaultValue: 'Shared conversation' })}
      snapshotAt={shared.snapshotAt}
      expiresAt={shared.expiresAt}
    >
      {producedByKind === 'agent' || producedByKind === 'run' ? (
        <p className="u-mt-0 u-mb-3">
          <span className="chip chip--ai u-fs-11">
            {producedByKind === 'agent'
              ? t('publicDraftedByAgent', { defaultValue: 'Drafted by an AI agent' })
              : t('publicGeneratedByWorkflow', { defaultValue: 'Generated by an automated workflow' })}
          </span>
        </p>
      ) : null}
      {shared.label && title && shared.label !== title
        ? <p className="muted u-fs-13 u-mt-0 u-mb-3">{shared.label}</p> : null}
      {markdown
        ? <Markdown className="chat-md">{markdown}</Markdown>
        : <p className="muted u-fs-13">{t('publicEmpty', { defaultValue: 'Nothing to show here.' })}</p>}
    </ShareFrame>
  );
}
