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
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../../ui/Markdown.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { LinkIcon } from '../../ui/icons/index.js';
import { resolveSharedPublic, type SharedResource } from './sharingClient.js';

/** Centered reading column shared by the loading skeleton and the resolved view,
 *  so resolving the share doesn't shift the layout. */
const COLUMN_STYLE: React.CSSProperties = { maxWidth: '46rem' };

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

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

export function SharedSharePage({ token }: { token: string }): JSX.Element {
  const { t } = useTranslation('sharing');
  const [shared, setShared] = useState<SharedResource | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'gone'>('loading');

  useEffect(() => {
    let active = true;
    setStatus('loading');
    void resolveSharedPublic(token)
      .then((s) => { if (active) { setShared(s); setStatus('ready'); } })
      .catch(() => { if (active) setStatus('gone'); });
    return () => { active = false; };
  }, [token]);

  if (status === 'loading') {
    // Designed loading state — mirror the article (chip · title · transcript
    // lines) at the same column width so resolving the share never shifts layout.
    return (
      <div className="u-p-4 u-mx-auto" style={COLUMN_STYLE} aria-busy="true" aria-label={t('publicLoading', { defaultValue: 'Loading the shared view' })}>
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

  if (status === 'gone' || !shared) {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<LinkIcon size={28} />}
          title={t('publicGoneTitle', { defaultValue: 'This link is no longer available' })}
          body={t('publicGoneBody', { defaultValue: 'The share link may have expired or been revoked by its owner.' })}
        />
      </div>
    );
  }

  const { title, markdown } = bodyFor(shared);
  return (
    <article className="u-p-4 u-mx-auto page-enter" style={COLUMN_STYLE}>
      <header className="u-flex u-flex-col u-gap-2 u-mb-4">
        <span className="chip chip--muted u-fs-11 u-self-start">{t('publicReadOnly', { defaultValue: 'Read-only shared view' })}</span>
        <h1 className="page-header__title">{title || shared.label || t('publicUntitled', { defaultValue: 'Shared conversation' })}</h1>
        {shared.label && title && shared.label !== title && <p className="muted u-fs-13 u-m-0">{shared.label}</p>}
      </header>
      {markdown
        ? <Markdown className="chat-md">{markdown}</Markdown>
        : <p className="muted u-fs-13">{t('publicEmpty', { defaultValue: 'Nothing to show here.' })}</p>}
    </article>
  );
}
