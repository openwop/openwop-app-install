/**
 * Comments (host-extension product feature — ADR 0021).
 *
 * Gates on useFeatureAccess('comments'). An org picker → a resource picker
 * (resourceType + the org's CMS pages / KB collections, composed from those
 * clients) → the reusable <CommentsPanel> thread. Deep-linkable via
 * ?orgId=&resourceType=&resourceId= (the notification actionUrl lands here).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, MessageSquareIcon } from '../../ui/icons/index.js';
import { listPages } from '../cms/cmsClient.js';
import { listCollections } from '../kb/kbClient.js';
import { CommentsPanel } from './CommentsPanel.js';
import {
  listOrgs, RESOURCE_TYPES, RESOURCE_LABEL,
  type Org, type ResourceType,
} from './commentsClient.js';

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
    return <StateCard icon={<LockIcon />} title="Comments is not enabled" body="Ask an administrator to enable the Comments feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">{orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow="Workspace" title="Comments" lede="Threaded comments on your CMS pages and KB collections." actions={orgPicker} />

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title="No organizations" body="Create an organization first — comments belong to an org's resources." />
      ) : (
        <>
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">Resource type</span>
              <select value={resourceType} onChange={(e) => setResourceType(e.target.value as ResourceType)} aria-label="Resource type">
                {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">Resource</span>
              {!resources ? <Skeleton /> : (
                <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} aria-label="Resource" disabled={resources.length === 0}>
                  {resources.length === 0 ? <option value="">No {RESOURCE_LABEL[resourceType].toLowerCase()}s in this org</option>
                    : resources.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              )}
            </label>
          </div>

          {resourceId ? (
            <CommentsPanel orgId={orgId} resourceType={resourceType} resourceId={resourceId} />
          ) : (
            <StateCard icon={<MessageSquareIcon />} title="Pick a resource" body="Choose a CMS page or KB collection above to view and add comments." />
          )}
        </>
      )}
    </div>
  );
}
