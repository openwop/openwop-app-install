/**
 * Comments (host-extension product feature — ADR 0021).
 *
 * Gates on useFeatureAccess('comments'). An org picker → a resource picker
 * (resourceType + the org's CMS pages / KB collections, composed from those
 * clients) → the reusable <CommentsPanel> thread. Deep-linkable via
 * ?orgId=&resourceType=&resourceId= (the notification actionUrl lands here).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, MessageSquareIcon } from '../../ui/icons/index.js';
import { listPages } from '../cms/cmsClient.js';
import { listCollections } from '../kb/kbClient.js';
import { CommentsPanel } from './CommentsPanel.js';
import {
  listOrgs, RESOURCE_TYPES,
  type Org, type ResourceType,
} from './commentsClient.js';

// Dynamic-key maps (ResourceType → catalog key) so a persisted enum value never
// leaks into the UI; `t(MAP[rt])` resolves the localized label.
const RESOURCE_TYPE_KEY: Record<ResourceType, string> = {
  cms_page: 'resourceTypeCmsPage',
  kb_collection: 'resourceTypeKbCollection',
};
const NO_RESOURCES_KEY: Record<ResourceType, string> = {
  cms_page: 'noResourcesCmsPage',
  kb_collection: 'noResourcesKbCollection',
};

interface ResourceOpt { id: string; label: string }
const initial = (): { orgId: string; resourceType: ResourceType; resourceId: string } => {
  const q = new URLSearchParams(window.location.search);
  const rt = q.get('resourceType');
  return {
    orgId: q.get('orgId') ?? '',
    resourceType: rt === 'kb_collection' ? 'kb_collection' : 'cms_page',
    resourceId: q.get('resourceId') ?? '',
  };
};

export function CommentsPage(): JSX.Element {
  const { t } = useTranslation('comments');
  const access = useFeatureAccess('comments');
  const seed = useMemo(initial, []);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState(seed.orgId);
  const [resourceType, setResourceType] = useState<ResourceType>(seed.resourceType);
  const [resources, setResources] = useState<ResourceOpt[] | null>(null);
  const [resourceId, setResourceId] = useState(seed.resourceId);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((c) => c || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const loadResources = useCallback((org: string, rt: ResourceType) => {
    setResources(null);
    const p = rt === 'cms_page'
      ? listPages(org).then((ps) => ps.map((x): ResourceOpt => ({ id: x.pageId, label: x.title })))
      : listCollections(org).then((cs) => cs.map((x): ResourceOpt => ({ id: x.collectionId, label: x.name })));
    void p.then((opts) => { setResources(opts); setResourceId((c) => (opts.some((o) => o.id === c) ? c : (opts[0]?.id ?? ''))); })
      .catch(() => { setResources([]); setResourceId(''); });
  }, []);
  useEffect(() => { if (orgId) loadResources(orgId, resourceType); }, [orgId, resourceType, loadResources]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>{orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('resourceTypeLabel')}</span>
              <select value={resourceType} onChange={(e) => setResourceType(e.target.value as ResourceType)} aria-label={t('resourceTypeLabel')}>
                {RESOURCE_TYPES.map((rt) => <option key={rt} value={rt}>{t(RESOURCE_TYPE_KEY[rt])}</option>)}
              </select>
            </label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('resourceLabel')}</span>
              {!resources ? <Skeleton /> : (
                <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} aria-label={t('resourceLabel')} disabled={resources.length === 0}>
                  {resources.length === 0 ? <option value="">{t(NO_RESOURCES_KEY[resourceType])}</option>
                    : resources.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              )}
            </label>
          </div>

          {resourceId ? (
            <CommentsPanel orgId={orgId} resourceType={resourceType} resourceId={resourceId} />
          ) : (
            <StateCard icon={<MessageSquareIcon />} title={t('pickResourceTitle')} body={t('pickResourceBody')} />
          )}
        </>
      )}
    </div>
  );
}
