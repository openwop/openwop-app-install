/**
 * Paid challenges (ADR 0420, admin link surface) — the operator's view of what is
 * for sale and the ONE write that makes a challenge paid: linking a PUBLISHED
 * challenge version to a Commerce product. The link is the enrol wall; unlinking
 * turns it off; a buyer keeps what they paid for (entitlements are untouched).
 *
 * Composes the EXISTING seams: `kicktodoLinksClient` (links), the Commerce admin
 * client (orgs → products) and the KickTodo catalog read (published versions). No
 * bespoke money path: the price, the checkout and the entitlement grant stay where
 * they are; this page only says WHICH product sells WHICH version.
 *
 * Honesty devices: a product already selling a different version is REFUSED by the
 * server (409) and surfaced as a choice — replace explicitly, or unlink first —
 * never a silent overwrite; an unknown challenge id renders as such rather than
 * as a title the page cannot back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SelectField } from '../../ui/Field.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { confirm } from '../../ui/confirm.js';
import { formatDate } from '../../i18n/format.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { listOrgs, listProducts, type Org, type Product } from '../commerce/commerceClient.js';
import { listChallenges, type ChallengeSummary } from '../../client/kicktodoClient.js';
import { listChallengeLinks, linkChallengeProduct, unlinkChallengeProduct, LinkConflictError, type ChallengeProductLink } from '../../client/kicktodoLinksClient.js';

export function AdminPaidChallengesPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [links, setLinks] = useState<ChallengeProductLink[] | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [challenges, setChallenges] = useState<ChallengeSummary[] | null>(null);
  const [challengesFailed, setChallengesFailed] = useState(false);
  // `ui/useOrgSelection`, not a hand-rolled `listOrgs().catch(() => [])`: `orgs`
  // gates the products read below, and `[]` would collapse "could not read the
  // organizations" into "there are none" — a dead picker in a state that never
  // failed. The hook keeps `orgs` null on failure and hands the page a third state.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productsFailed, setProductsFailed] = useState(false);
  const [productId, setProductId] = useState('');
  const [challengeKey, setChallengeKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'conflict'; message: string } | null>(null);
  const linksRegionRef = useRef<HTMLElement | null>(null);

  const loadLinks = useCallback(async () => {
    setLinks(null); setLinksFailed(false);
    try { setLinks(await listChallengeLinks()); }
    catch { setLinksFailed(true); }
  }, []);
  const loadChallenges = useCallback(async () => {
    setChallenges(null); setChallengesFailed(false); setChallengeKey('');
    try { setChallenges((await listChallenges()).filter((x) => x.status === 'published')); }
    catch { setChallengesFailed(true); }
  }, []);
  const reload = useCallback(async () => { await Promise.all([loadLinks(), loadChallenges()]); }, [loadLinks, loadChallenges]);
  useEffect(() => { void reload(); }, [reload]);

  const loadProducts = useCallback(() => {
    if (!orgId) { setProducts([]); setProductsFailed(false); return; }
    let live = true;
    setProducts(null); setProductsFailed(false); setProductId('');
    void listProducts(orgId)
      .then((p) => { if (live) { setProducts(p); setProductsFailed(false); setProductId(p[0]?.productId ?? ''); } })
      .catch(() => { if (live) setProductsFailed(true); });
    return () => { live = false; };
  }, [orgId]);
  useEffect(() => loadProducts(), [loadProducts]);

  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of challenges ?? []) m.set(`${c.id}::${c.version}`, `${c.title} · v${c.version}`);
    return (id: string, version: number) => challengesFailed
      ? t('paidChallengeTitleUnavailable')
      : challenges === null
        ? t('common:loading')
        : m.get(`${id}::${version}`) ?? t('paidUnknownChallenge');
  }, [challenges, challengesFailed, t]);

  const doLink = async (replace: boolean) => {
    const [challengeId, v] = challengeKey.split('::');
    if (!productId || !challengeId) return;
    setBusy(true); setNotice(null);
    try {
      await linkChallengeProduct({ productId, challengeId, challengeVersion: Number(v), ...(replace ? { replace: true } : {}) });
      setNotice({ kind: 'success', message: t('paidLinked') });
      await loadLinks();
    } catch (err) {
      if (err instanceof LinkConflictError) setNotice({ kind: 'conflict', message: err.message });
      else setNotice({ kind: 'error', message: t('paidLinkError', { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusy(false);
    }
  };

  const onUnlink = async (link: ChallengeProductLink) => {
    const ok = await confirm({ title: t('paidUnlinkConfirmTitle'), body: t('paidUnlinkConfirmBody'), confirmLabel: t('paidUnlinkConfirmCta'), danger: true });
    if (!ok) return;
    setBusy(true); setNotice(null);
    try {
      await unlinkChallengeProduct(link.productId);
      await loadLinks();
      setNotice({ kind: 'success', message: t('paidUnlinked') });
      requestAnimationFrame(() => linksRegionRef.current?.focus());
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const linkColumns: DataColumn<ChallengeProductLink>[] = [
    { key: 'product', header: t('paidColProduct'), render: (l) => <code>{l.productId}</code> },
    { key: 'challenge', header: t('paidColChallenge'), render: (l) => titleOf(l.challengeId, l.challengeVersion) },
    { key: 'version', header: t('paidColVersion'), render: (l) => `v${l.challengeVersion}` },
    { key: 'since', header: t('paidColSince'), render: (l) => formatDate(l.createdAt) },
    { key: 'actions', header: t('paidActions'), render: (l) => <Button variant="quiet" size="sm" disabled={busy} onClick={() => void onUnlink(l)}>{t('paidUnlinkCta')}</Button> },
  ];

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo/commerce">{t('paidBackToCommerce')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('paidTitle')}</h1>
        <p className="page-header__lede">{t('paidLede')}</p>
      </header>

      <section ref={linksRegionRef} tabIndex={-1} aria-label={t('paidLinksRegion')}>
      {linksFailed && <StateCard announce title={t('paidLoadError')} body={t('paidLinksFailedBody')} action={<Button variant="secondary" onClick={() => void loadLinks()}>{t('retry')}</Button>} />}
      {!linksFailed && links === null && <StateCard loading title={t('paidTitle')} />}
      {!linksFailed && links !== null && links.length === 0 && (
        <StateCard title={t('paidEmptyTitle')} body={t('paidEmptyBody')} />
      )}
      {!linksFailed && links !== null && links.length > 0 && (
        <div className="surface-card"><DataTable stack caption={t('paidLinksTableCaption')} rows={links} rowKey={(l) => l.productId} columns={linkColumns} /></div>
      )}
      </section>

      <section className="surface-card" aria-label={t('paidLinkHeading')}>
        <h2 className="kt-eyebrow">{t('paidLinkHeading')}</h2>
        {challengesFailed ? <StateCard announce title={t('paidChallengesFailedTitle')} body={t('paidChallengesFailedBody')} action={<Button variant="secondary" onClick={() => void loadChallenges()}>{t('retry')}</Button>} />
          : challenges !== null && challenges.length === 0 ? <p className="muted u-fs-13">{t('paidNoPublished')}</p> : null}
        <OrgSelectionState variant="inline" orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
          emptyBody={t('paidNoOrgs')} failedBody={t('paidOrgsFailed')}>
        {productsFailed ? <StateCard announce title={t('paidProductsFailedTitle')} body={t('paidProductsFailedBody')} action={<Button variant="secondary" onClick={loadProducts}>{t('retry')}</Button>} /> : null}
        <div className="action-bar">
          <SelectField label={t('paidOrgLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
          <SelectField label={t('paidProductLabel')} value={productId} onChange={(e) => setProductId(e.target.value)} disabled={products === null || productsFailed || products.length === 0}>
            {productsFailed ? <option value="">{t('paidProductsUnavailable')}</option> : products === null ? <option value="">{t('common:loading')}</option> : products.length === 0 ? <option value="">{t('paidNoProducts')}</option> : products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}
          </SelectField>
          <SelectField label={t('paidChallengeLabel')} value={challengeKey} onChange={(e) => setChallengeKey(e.target.value)} disabled={challenges === null || challengesFailed || challenges.length === 0}>
            <option value="">{challengesFailed ? t('paidChallengesUnavailable') : challenges === null ? t('common:loading') : '—'}</option>
            {(challenges ?? []).map((c) => <option key={`${c.id}::${c.version}`} value={`${c.id}::${c.version}`}>{c.title} · v{c.version}</option>)}
          </SelectField>
          <Button variant="accent-solid" size="sm" disabled={busy || products === null || productsFailed || challenges === null || challengesFailed || !productId || !challengeKey} aria-busy={busy} onClick={() => void doLink(false)}>{t('paidLinkCta')}</Button>
        </div>
        </OrgSelectionState>
        {notice?.kind === 'success' && <Notice variant="success" announce={notice.message}>{notice.message}</Notice>}
        {notice?.kind === 'error' && <Notice variant="error" announce={notice.message}>{notice.message}</Notice>}
        {notice?.kind === 'conflict' && (
          <Notice variant="warning" announce={t('paidLinkConflict', { message: notice.message })}>
            {t('paidLinkConflict', { message: notice.message })}
            <div className="action-bar">
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void doLink(true)}>{t('paidReplaceCta')}</Button>
            </div>
          </Notice>
        )}
      </section>
    </div>
  );
}
