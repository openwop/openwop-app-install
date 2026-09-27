/**
 * Comments (host-extension product feature — ADR 0021).
 *
 * Gates on useFeatureAccess('comments'). An org picker → a resource picker
 * (resourceType + the org's CMS pages / KB collections, composed from those
 * clients) → the reusable <CommentsPanel> thread. Deep-linkable via
 * ?orgId=&resourceType=&resourceId= (the notification actionUrl lands here).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, MessageSquareIcon } from '../../ui/icons/index.js';
import { listPages } from '../cms/cmsClient.js';
import { listCollections } from '../kb/kbClient.js';
import { CommentsPanel } from './CommentsPanel.js';
import {
  listOrgs, RESOURCE_TYPES, isResourceType,
  type Org, type ResourceType,
} from './commentsClient.js';

// Dynamic-key maps (ResourceType → catalog key) so a persisted enum value never
// leaks into the UI; `t(MAP[rt])` resolves the localized label.
//
// CMNT-UX-14(c) correction, in place: the note that used to sit here said these
// maps "stay exhaustive over ResourceType so a future commentable type is a
// compile error here, not a silent gap". That was true over the FRONTEND union
// and decorative against the BACKEND's set — which is exactly how `priority_idea`
// and `creative_brief` reached production with no frontend entry at all. The
// union is now the complete backend set (`commentsClient.ALL_RESOURCE_TYPES`,
// pinned to the backend by `backend/typescript/test/comments-deep-link.test.ts`
// § "CMNT-1 — the frontend ResourceType union matches the backend set"), so the
// compile error is real: a new backend type fails that parity test, and adding it
// to the union fails these two maps.
const RESOURCE_TYPE_KEY: Record<ResourceType, string> = {
  cms_page: 'resourceTypeCmsPage',
  kb_collection: 'resourceTypeKbCollection',
  chat_message: 'resourceTypeChatMessage',
  canvas_document: 'resourceTypeCanvasDocument',
  priority_idea: 'resourceTypePriorityIdea',
  creative_brief: 'resourceTypeCreativeBrief',
};
const NO_RESOURCES_KEY: Record<ResourceType, string> = {
  cms_page: 'noResourcesCmsPage',
  kb_collection: 'noResourcesKbCollection',
  chat_message: 'noResourcesChatMessage',
  canvas_document: 'noResourcesCanvasDocument',
  priority_idea: 'noResourcesPriorityIdea',
  creative_brief: 'noResourcesCreativeBrief',
};
/** Does this type have a resource picker on this page? */
const isPickable = (rt: ResourceType): boolean => (RESOURCE_TYPES as readonly string[]).includes(rt);

interface ResourceOpt { id: string; label: string }
/**
 * The deep-link seed (CMNT-1 / CMNT-UX-1).
 *
 * The `resourceType` is parsed against the COMPLETE backend set. A value that is
 * not a commentable type yields `resourceType: null`, which the page renders as a
 * named "unsupported resource type" state — it is NEVER substituted. The previous
 * shape (`rt === 'kb_collection' ? 'kb_collection' : 'cms_page'`) coerced four of
 * the six types to `cms_page`, and `loadResources` then replaced the deep-linked
 * id with the org's first CMS page, so a notification landed the reader in a
 * stranger's populated thread with a confident picker label and no error.
 */
interface Seed { orgId: string; resourceType: ResourceType | null; rawType: string; resourceId: string }
const seedFrom = (search: string): Seed => {
  const q = new URLSearchParams(search);
  const rt = q.get('resourceType');
  const resourceId = q.get('resourceId') ?? '';
  // No `resourceType` param at all is not an error — it is the bare `/comments`
  // entry point, which defaults to the first pickable type.
  let resourceType: ResourceType | null = rt == null || rt === '' ? 'cms_page' : (isResourceType(rt) ? rt : null);
  // A picker-less type with NO id names no thread and has no list to fall back
  // on, so it would strand the page. Fall back to the picker rather than
  // rendering a linked-thread card with an empty id.
  if (resourceType && !isPickable(resourceType) && !resourceId) resourceType = 'cms_page';
  return { orgId: q.get('orgId') ?? '', resourceType, rawType: rt ?? '', resourceId };
};

export function CommentsPage(): JSX.Element {
  const { t } = useTranslation('comments');
  const access = useFeatureAccess('comments');
  // CMNT-UX-4 — the seed used to be `useMemo(initial, [])` off
  // `window.location.search`, so a SECOND notification clicked while already on
  // `/comments` changed the URL and nothing else: react-router re-rendered the
  // same element and the reader kept staring at thread A. Tracking `location`
  // makes the page follow the URL it is addressed by.
  const location = useLocation();
  const navigate = useNavigate();
  const seed = useMemo(() => seedFrom(location.search), [location.search]);
  // `.catch(() => setOrgs([]))` rendered "No organizations — create an
  // organization first" over a failed read. `seed.orgId` rides through so a
  // deep-linked resource still lands where the link says.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled, seed.orgId);
  const [resourceType, setResourceType] = useState<ResourceType>(seed.resourceType ?? 'cms_page');
  const [resources, setResources] = useState<ResourceOpt[] | null>(null);
  // UX-CMT-2 — the resources read failed. Distinct from an org that genuinely
  // has none, because the empty branch below makes a FACTUAL CLAIM about the org
  // ("No CMS pages in this org").
  const [resourcesFailed, setResourcesFailed] = useState(false);
  const [resourceId, setResourceId] = useState(seed.resourceId);
  // The id THIS link named, for the type it named. `loadResources` may never
  // silently re-point it (see below); it is also what the mismatch notice keys on.
  const linkedId = useRef(seed.resourceType ? seed.resourceId : '');

  // CMNT-UX-4 — re-seed when the page is re-addressed (a second notification
  // click while already on `/comments`).
  //
  // Keyed on `location.key`, NOT `location.search`. The search string alone
  // misses a re-click of the SAME notification: land on `?resourceId=A`, change
  // the picker to B, click that same notification again — the search is
  // byte-identical, the effect early-returns, and the reader stays on B while the
  // notification claims A. That is the same "URL says A, page shows B" defect
  // this effect exists to close, just reached by a different route.
  //
  // `location.key` is minted fresh by react-router on every push/replace, so it
  // discriminates a genuine re-navigation from a re-render. Ordinary interaction
  // (changing the picker) does not navigate and so does not change the key —
  // which is what keeps this from stomping the user's own selection.
  const appliedKey = useRef(location.key);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; appliedKey.current = location.key; return; }
    if (appliedKey.current === location.key) return;
    appliedKey.current = location.key;
    linkedId.current = seed.resourceType ? seed.resourceId : '';
    if (seed.orgId) setOrgId(seed.orgId);
    if (seed.resourceType) setResourceType(seed.resourceType);
    setResourceId(seed.resourceId);
  }, [location.key, seed, setOrgId]);

  const loadResources = useCallback((org: string, rt: ResourceType) => {
    setResources(null);
    setResourcesFailed(false);
    const p = rt === 'cms_page'
      ? listPages(org).then((ps) => ps.map((x): ResourceOpt => ({ id: x.pageId, label: x.title })))
      : listCollections(org).then((cs) => cs.map((x): ResourceOpt => ({ id: x.collectionId, label: x.name })));
    void p.then((opts) => {
      setResources(opts);
      setResourceId((c) => {
        if (opts.some((o) => o.id === c)) return c;
        // CMNT-1 / CMNT-UX-1 — this used to fall straight through to
        // `opts[0]?.id ?? ''`, which DISCARDED a deep-linked id and substituted
        // the org's first resource. Combined with the type coercion above it
        // opened a stranger's populated thread under a confident picker label.
        // A deep-linked id is now KEPT and the mismatch is NAMED (below), never
        // silently replaced.
        if (c && c === linkedId.current) return c;
        return opts[0]?.id ?? '';
      });
    })
      .catch(() => {
        // UX-CMT-2 — this used to also `setResourceId('')`, which DISCARDED the
        // deep-linked resource. The module docstring says the notification
        // actionUrl lands here with ?resourceId=, and CommentsPanel fetches its
        // thread by that id INDEPENDENTLY of this picker — so clearing it
        // stranded a user who arrived from a notification, on a screen telling
        // them their org was empty. Keep the id; the thread stays reachable.
        setResourcesFailed(true);
        setResources([]);
      });
  }, []);
  // Only PICKABLE types have a resource list to read. The other four are
  // deep-link/inline-anchored, so the panel renders straight off the linked id.
  useEffect(() => { if (orgId && isPickable(resourceType)) loadResources(orgId, resourceType); }, [orgId, resourceType, loadResources]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }
  // CMNT-1 — a `resourceType` the backend does not register is NAMED, not
  // substituted. Substituting is what turned a bad link into a stranger's thread.
  if (seed.resourceType === null) {
    return (
      <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="comments.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        {/* A refusal needs an EXIT. Naming the bad type instead of substituting a
            resource is the correct half (CMNT-1); leaving the reader on a card
            with nothing to press is the missing half — a stale or typo'd link
            (`?resourceType=cms-page`) stranded them, and the query is the very
            thing keeping them there, so "reload" cannot help. Clearing it with a
            REPLACE (not a push) drops the broken address rather than stacking a
            Back button that returns to the dead end. */}
        <StateCard icon={<MessageSquareIcon />} announce
          title={t('unsupportedTypeTitle')} body={t('unsupportedTypeBody', { type: seed.rawType })}
          action={<Button variant="primary" size="sm" onClick={() => navigate('/comments', { replace: true })}>{t('browseAllComments')}</Button>} />
      </div>
    );
  }

  // The deep-linked id survived a SUCCESSFUL list read that does not contain it.
  //
  // CMNT-UX-19 / ADR 0659 D2 — the `isPickable(resourceType)` conjunct is GONE.
  // It was decorative (`resources` is only ever non-null for a pickable type, so
  // it gated nothing) and it was a false statement of the rule: it read as "only
  // a pickable type can name a resource that isn't there", which is exactly the
  // belief that left the four picker-less types — `chat_message`,
  // `canvas_document`, `priority_idea`, `creative_brief`, precisely what the
  // notification emitter deep-links — with no hedge at all.
  //
  // The hedge that actually covers all six types is `CommentsPanel`'s gone-state:
  // the thread read now RESOLVES the target and answers a uniform 404, so every
  // type gets the same honest answer from the same place, with no composer over
  // it. This list-derived notice remains as the narrower, earlier signal for the
  // two types that HAVE a list (it can fire before the thread read answers).
  const linkedMissing = Boolean(
    resourceId && resourceId === linkedId.current
    && resources && !resourcesFailed && !resources.some((r) => r.id === resourceId),
  );

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>{orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="comments.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s now. This page had it inverted (the skeleton was
          checked ABOVE the zero-org branch); taking the picker + panel as the
          CHILD makes the right order unskippable. `loadResources` is gated on
          `orgId`, so with no organization it never starts and `resources` stays
          `null` — the skeletons below key on THAT sentinel, never on `orgs`. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<GlobeIcon />}>
        <>
          {/* CMNT-1 / CMNT-UX-7 — a type-agnostic thread view. The four
              picker-less types (chat message, rich document, priority idea,
              creative brief) have no list to choose from, so a deep-link names
              the thread directly and the page states WHAT it is showing rather
              than offering a selector that cannot address it. Before this, all
              four were coerced to `cms_page`. */}
          {!isPickable(resourceType) ? (
            <div className="surface-card u-p-4 u-gap-1 u-flex u-flex-col">
              <span className="u-label-sm">{t('linkedThreadLabel')}</span>
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <span className="chip chip--muted">{t(RESOURCE_TYPE_KEY[resourceType])}</span>
                <code className="u-min-w-0">{resourceId}</code>
              </div>
              <Button variant="quiet" size="sm" onClick={() => { linkedId.current = ''; setResourceId(''); setResourceType('cms_page'); }}>{t('backToPicker')}</Button>
            </div>
          ) : (
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('resourceTypeLabel')}</span>
              <select value={resourceType} onChange={(e) => { linkedId.current = ''; setResourceType(e.target.value as ResourceType); }} aria-label={t('resourceTypeLabel')}>
                {RESOURCE_TYPES.map((rt) => <option key={rt} value={rt}>{t(RESOURCE_TYPE_KEY[rt])}</option>)}
              </select>
            </label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('resourceLabel')}</span>
              {!resources ? <Skeleton /> : (
                <select
                  value={resourceId}
                  onChange={(e) => { linkedId.current = ''; setResourceId(e.target.value); }}
                  aria-label={t('resourceLabel')}
                  disabled={resources.length === 0 && !(resourcesFailed && resourceId)}
                >
                  {resourcesFailed ? (
                    <option value={resourceId}>{resourceId ? t('resourceFromLink') : t('resourcesFailedOption')}</option>
                  ) : resources.length === 0 ? <option value="">{t(NO_RESOURCES_KEY[resourceType])}</option>
                    : (
                      <>
                        {/* The deep-linked id is kept even when it is not in the
                            list (CMNT-1) — so it needs an option to be selected. */}
                        {linkedMissing ? <option value={resourceId}>{t('resourceFromLink')}</option> : null}
                        {resources.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </>
                    )}
                </select>
              )}
            </label>
            {resourcesFailed ? (
              <Notice variant="warning" announce={t('resourcesFailed')}>
                {t('resourcesFailed')}{' '}
                <Button variant="quiet" size="sm" onClick={() => loadResources(orgId, resourceType)}>{t('common:retry')}</Button>
              </Notice>
            ) : null}
            {linkedMissing ? (
              // CMNT-1 — the link named a resource this org's list does not
              // contain. The thread is still fetched by (type, id), so it stays
              // reachable; what must never happen is a SILENT substitution.
              <Notice variant="warning" announce={t('linkedResourceMissing')}>{t('linkedResourceMissing')}</Notice>
            ) : null}
          </div>
          )}

          {resourceId ? (
            <CommentsPanel orgId={orgId} resourceType={resourceType} resourceId={resourceId} />
          ) : resources === null && isPickable(resourceType) ? (
            // The resources read has not answered yet, so "Pick a resource" would
            // be an instruction about a list nobody has seen. This is the page's
            // OWN read sentinel — the loading affordance the old `!orgs` arm used
            // to supply, now keyed on the read that actually gates this panel.
            // Gated on `isPickable` so a picker-less type (which never starts a
            // read, so `resources` stays `null` forever) does not sit on a
            // permanent skeleton — the trap that a bare `resources === null`
            // sentinel becomes once a lane exists that never fills it.
            <Skeleton />
          ) : (
            <StateCard icon={<MessageSquareIcon />} title={t('pickResourceTitle')} body={t('pickResourceBody')} />
          )}
        </>
      </OrgSelectionState>
    </div>
  );
}
