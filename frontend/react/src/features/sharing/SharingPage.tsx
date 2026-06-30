/**
 * Sharing (host-extension product feature — ADR 0013).
 *
 * Gates on useFeatureAccess('sharing'). An org picker → a "create a share link"
 * form (resource type → resource → optional label + expiry) → the org's active
 * links with copyable PUBLIC /shared/:token URLs + revoke. The link resolves a
 * read-only view of the resource publicly (incl. a CMS DRAFT — the preview-link
 * use-case the published-only public surface can't serve).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import i18n from '../../i18n/index.js';
import { formatDate, formatDateTime } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LinkIcon, LockIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  createLink,
  listLinks,
  listOrgs,
  listResources,
  revokeLink,
  sharedPageUrl,
  type Org,
  type ResourceRef,
  type ResourceType,
  type ShareLink,
} from './sharingClient.js';

const TYPE_LABEL_KEY: Record<ResourceType, string> = { cms_page: 'typeCmsPage', kb_collection: 'typeKbCollection', document: 'typeDocument', conversation: 'typeConversation', prompt: 'typePrompt' };

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast.success(i18n.t('sharing:linkCopied'))).catch(() => { /* clipboard blocked */ });
}

export function SharingPage(): JSX.Element {
  const { t } = useTranslation('sharing');
  const access = useFeatureAccess('sharing');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [linkList, setLinkList] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // mint form
  const [resourceType, setResourceType] = useState<ResourceType>('cms_page');
  const [resources, setResources] = useState<ResourceRef[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const loadLinks = useCallback((org: string) => {
    void listLinks(org).then(setLinkList).catch((e) => setError(e instanceof Error ? e.message : t('loadFailed')));
  }, [t]);

  useEffect(() => { if (orgId) { setLinkList(null); loadLinks(orgId); } }, [orgId, loadLinks]);

  // Load pickable resources whenever org or type changes (guard stale resolves).
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    setResourceId('');
    void listResources(orgId, resourceType).then((r) => { if (active) setResources(r); }).catch(() => { if (active) setResources([]); });
    return () => { active = false; };
  }, [orgId, resourceType]);

  const create = useCallback(async () => {
    if (!orgId || !resourceId) return;
    setBusy(true);
    try {
      const days = expiry.trim() ? Number(expiry) : undefined;
      await createLink(orgId, {
        resourceType,
        resourceId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(days && Number.isFinite(days) ? { expiresInDays: days } : {}),
      });
      setLabel(''); setExpiry(''); setResourceId('');
      loadLinks(orgId);
      toast.success(t('linkCreated'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, resourceType, resourceId, label, expiry, loadLinks, t]);

  const revoke = useCallback(async (token: string) => {
    if (!(await confirm({ title: t('revokeShareConfirm'), danger: true, confirmLabel: t('revokeLinkLabel') }))) return;
    try { await revokeLink(orgId, token); loadLinks(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('revokeFailed')); }
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

  const active = (linkList ?? []).filter((l) => !l.revoked);

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <div className="sharing-layout">
          {/* Mint form — a real <form> so Enter submits (SHARE-2). */}
          <form className="surface-card u-gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <h2 className="u-fs-16 u-m-0">{t('mintTitle')}</h2>
            <SelectField label={t('fieldResourceType')} value={resourceType} onChange={(e) => setResourceType(e.target.value as ResourceType)}>
              <option value="cms_page">{t('typeCmsPage')}</option>
              <option value="kb_collection">{t('typeKbCollection')}</option>
              <option value="document">{t('typeDocument')}</option>
              <option value="conversation">{t('typeConversation')}</option>
              <option value="prompt">{t('typePrompt')}</option>
            </SelectField>
            <SelectField label={t('fieldResource')} value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">{t('resourcePlaceholder')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </SelectField>
            <TextField label={t('fieldLabel')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('labelPlaceholder')} />
            <TextField label={t('fieldExpiry')} value={expiry} onChange={(e) => setExpiry(e.target.value)} inputMode="numeric" placeholder={t('expiryPlaceholder')} />
            <div className="u-flex u-justify-end">
              <button type="submit" className="btn-primary" disabled={busy || !resourceId}><PlusIcon /> {t('createLink')}</button>
            </div>
          </form>

          {/* Active links */}
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('activeTitle')}</h2>
            {!linkList ? <Skeleton /> : active.length === 0 ? <span className="u-label-sm">{t('noActiveLinks')}</span> : active.map((l) => (
              <div key={l.token} className="surface-inset sharing-link">
                <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <span className="chip">{t(TYPE_LABEL_KEY[l.resourceType])}</span>
                  <strong className="sharing-link-title">{l.label ?? l.cardTitle ?? l.resourceId}</strong>
                  <span className="u-flex-1" />
                  {l.expiresAt ? <span className="u-label-sm" title={formatDateTime(l.expiresAt)}>{t('expiresAt', { date: formatDate(l.expiresAt) })}</span> : null}
                  <button type="button" className="btn-ghost" title={t('copyLinkLabel')} aria-label={t('copyLinkLabel')} onClick={() => copy(sharedPageUrl(l.token))}><LinkIcon /></button>
                  <button type="button" className="btn-ghost" title={t('revokeLinkLabel')} aria-label={t('revokeLinkLabel')} onClick={() => void revoke(l.token)}><TrashIcon /></button>
                </div>
                <code className="sharing-link-url">{sharedPageUrl(l.token)}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
