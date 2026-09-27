import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GROUP_LABEL_KEYS, type NavGroup, type NavItem } from '../chrome/features.js';
import { useFeatureBadge, useFeatureLocked } from '../featureToggles/FeatureAccessContext.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Button } from '../ui/Button.js';
import { StateCard } from '../ui/StateCard.js';
import { useResolvedNav } from '../chrome/navConfig/NavConfigProvider.js';
import { readRecentAdminDestinations } from '../chrome/adminRecents.js';
import { setNavSource } from '../chrome/navSource.js';
import { useReviewList, useReviewStatusStore } from '../chat/reviews/reviewStatusStore.js';
import { getHealthSummary, OperationsRequestError } from '../client/operationsClient.js';
import { ActivityIcon, AlertIcon, CheckIcon, ClockIcon, InboxIcon, LockIcon, SearchIcon } from '../ui/icons/index.js';

const FEATURE_STORE = '/marketplace/bundles';

type HealthState = 'idle' | 'loading' | 'ready' | 'degraded' | 'restricted' | 'unavailable';

/** Admin home — decisions first, then a compact searchable projection of the
 * same effective manifest used by the rail and command palette. */
export function AdminOverviewPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const { t: tn } = useTranslation('nav');
  const badgeFor = useFeatureBadge();
  const lockedFor = useFeatureLocked();
  const { admin } = useResolvedNav();
  const reviews = useReviewList();
  const reviewsLoading = useReviewStatusStore((state) => state.loading);
  const reviewsError = useReviewStatusStore((state) => state.error);
  const reviewsInitialized = useReviewStatusStore((state) => state.initialized);
  const [query, setQuery] = useState('');
  const [health, setHealth] = useState<HealthState>('idle');

  const groups = useMemo(() => admin
    .map((group) => ({ ...group, items: group.items.filter((item) => item.to !== '/admin') }))
    .filter((group) => group.items.length > 0), [admin]);
  const allItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const operationsPath = allItems.find((item) => item.to === '/operations')?.to;

  useEffect(() => {
    if (!operationsPath) {
      setHealth('idle');
      return;
    }
    let active = true;
    setHealth('loading');
    void getHealthSummary().then((summary) => {
      if (active) setHealth(summary.status);
    }).catch((error: unknown) => {
      if (!active) return;
      setHealth(error instanceof OperationsRequestError && error.status === 403
        ? 'restricted'
        : 'unavailable');
    });
    return () => { active = false; };
  }, [operationsPath]);

  const translatedGroup = (group: NavGroup): string => group.custom
    ? group.label
    : tn(GROUP_LABEL_KEYS[group.id] ?? '', { defaultValue: group.label });
  const translatedLabel = (item: NavItem): string => item.labelKey
    ? tn(item.labelKey, { defaultValue: item.label })
    : item.label;
  const translatedHint = (item: NavItem): string => item.hintKey
    ? tn(item.hintKey, { defaultValue: item.hint })
    : item.hint;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = groups.map((group) => ({
    ...group,
    items: normalizedQuery
      ? group.items.filter((item) => `${translatedLabel(item)} ${translatedHint(item)} ${translatedGroup(group)}`.toLocaleLowerCase().includes(normalizedQuery))
      : group.items,
  })).filter((group) => group.items.length > 0);
  const filteredCount = filteredGroups.reduce((count, group) => count + group.items.length, 0);

  const itemByPath = new Map(allItems.map((item) => [item.to, item]));
  const recentItems = readRecentAdminDestinations()
    .map((path) => itemByPath.get(path))
    .filter((item): item is NavItem => item !== undefined);

  const healthCopy: Record<HealthState, string> = {
    idle: t('adminHealthRestricted'),
    loading: t('adminHealthLoading'),
    ready: t('adminHealthReady'),
    degraded: t('adminHealthDegraded'),
    restricted: t('adminHealthRestricted'),
    unavailable: t('adminHealthUnavailable'),
  };

  const destination = (item: NavItem, compact = false): JSX.Element => {
    const Icon = item.icon;
    const locked = lockedFor(item.featureId);
    const badge = badgeFor(item.featureId);
    return (
      <Link
        key={item.to}
        to={locked ? FEATURE_STORE : item.to}
        className={compact ? 'admin-home-recent-link' : 'admin-directory-link'}
        title={locked ? t('adminLockedHint') : undefined}
        onClick={() => setNavSource('hub')}
      >
        <span className="admin-directory-icon" aria-hidden><Icon size={18} /></span>
        <span className="admin-directory-meta">
          <span className="admin-directory-label">{translatedLabel(item)}</span>
          {!compact ? <span className="admin-directory-hint">{translatedHint(item)}</span> : null}
        </span>
        {locked ? <span className="chip"><LockIcon size={12} /> {t('adminLocked')}</span>
          : badge ? <span className="nav-badge nav-badge--beta">{badge}</span> : null}
      </Link>
    );
  };

  const attentionText = (!reviewsInitialized || reviewsLoading) && reviews.length === 0
    ? t('adminAttentionLoading')
    : reviewsError && reviews.length === 0
      ? t('adminAttentionUnavailable')
      : reviews.length > 0
        ? t('adminAttentionPending', { count: reviews.length })
        : t('adminAttentionEmpty');

  return (
    <section data-walkthrough="admin.page" className="admin-overview">
      <PageHeader eyebrow={t('adminEyebrow')} title={t('adminTitle')} lede={t('adminLede')} />

      <div className="admin-home-status-grid">
        <article className={`surface-card admin-home-status${reviews.length > 0 ? ' is-attention' : ''}`}>
          <span className="admin-home-status-icon" aria-hidden>{reviews.length > 0 ? <AlertIcon size={20} /> : <InboxIcon size={20} />}</span>
          <div>
            <h2>{t('adminAttentionHeading')}</h2>
            <p>{attentionText}</p>
            <Link className="btn-link" to="/inbox" onClick={() => setNavSource('hub')}>{t('adminOpenInbox')}</Link>
          </div>
        </article>
        <article className={`surface-card admin-home-status${health === 'degraded' || health === 'unavailable' ? ' is-attention' : ''}`}>
          <span className="admin-home-status-icon" aria-hidden>{health === 'ready' ? <CheckIcon size={20} /> : <ActivityIcon size={20} />}</span>
          <div>
            <h2>{t('adminHealthHeading')}</h2>
            <p aria-live="polite">{healthCopy[health]}</p>
            {operationsPath ? <Link className="btn-link" to={operationsPath} onClick={() => setNavSource('hub')}>{t('adminOpenOperations')}</Link> : null}
          </div>
        </article>
      </div>

      <section className="admin-home-recent" aria-labelledby="admin-recent-heading">
        <h2 id="admin-recent-heading"><ClockIcon size={18} aria-hidden /> {t('adminRecentHeading')}</h2>
        {recentItems.length > 0
          ? <div className="admin-home-recent-list">{recentItems.map((item) => destination(item, true))}</div>
          : <p className="muted">{t('adminRecentEmpty')}</p>}
      </section>

      <section className="admin-directory" aria-labelledby="admin-directory-heading">
        <div className="admin-directory-head">
          <div>
            <h2 id="admin-directory-heading">{t('adminAllSettingsHeading')}</h2>
            <p>{t('adminAllSettingsLede')}</p>
          </div>
          <div className="admin-directory-search">
            <label htmlFor="admin-settings-search">{t('adminSearchLabel')}</label>
            <span className="admin-directory-search-control">
              <SearchIcon size={17} aria-hidden />
              <input id="admin-settings-search" type="search" className="ui-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('adminSearchPlaceholder')} />
            </span>
            <span className="admin-directory-result-count" aria-live="polite">{t('adminSearchResultCount', { count: filteredCount })}</span>
          </div>
        </div>
        {filteredGroups.length > 0 ? filteredGroups.map((group) => {
          const headingId = `admin-group-${group.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
          return (
            <section key={group.id} className="admin-directory-group" aria-labelledby={headingId}>
              <h3 id={headingId}>{translatedGroup(group)}</h3>
              <div className="admin-directory-list">{group.items.map((item) => destination(item))}</div>
            </section>
          );
        }) : (
          <StateCard
            icon={<SearchIcon size={20} />}
            title={t('adminSearchNoResultsTitle')}
            body={t('adminSearchNoResultsBody')}
            action={<Button variant="secondary" size="sm" onClick={() => setQuery('')}>{t('adminClearSearch')}</Button>}
          />
        )}
      </section>
    </section>
  );
}
