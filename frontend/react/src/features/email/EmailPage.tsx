/**
 * Email Marketing (host-extension product feature — ADR 0019).
 *
 * Gates on useFeatureAccess('email'). An org picker → templates (create/edit/
 * delete) → campaigns (pick template + audience stage → create → send) with
 * per-campaign stats + an inline send log (each recipient sent / skipped /
 * failed). Sends resolve the audience live from CRM and consent-gate marketing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, PlusIcon, SaveIcon, SendIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  createCampaign, createTemplate, deleteCampaign, deleteTemplate, listCampaigns, listOrgs,
  listSends, listTemplates, sendCampaign, updateTemplate, CONTACT_STAGES,
  type Campaign, type ContactStage, type EmailTemplate, type Org, type SendLog,
} from './emailClient.js';

const campChip = (s: Campaign['status']): string => (s === 'sent' ? 'chip chip--success' : s === 'sending' ? 'chip chip--warning' : 'chip chip--muted');
const sendChip = (s: SendLog['status']): string => (s === 'sent' ? 'chip chip--success' : s === 'failed' ? 'chip chip--danger' : 'chip chip--muted');

export function EmailPage(): JSX.Element {
  const { t } = useTranslation('email');
  const access = useFeatureAccess('email');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [nt, setNt] = useState({ name: '', subject: '', body: '' });
  const [sel, setSel] = useState<EmailTemplate | null>(null);
  const [campTpl, setCampTpl] = useState('');
  const [campStage, setCampStage] = useState<'' | ContactStage>('');
  const [logFor, setLogFor] = useState('');
  const [sends, setSends] = useState<SendLog[] | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((c) => c || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const load = useCallback((org: string) => {
    setError(null); setSel(null); setLogFor(''); setSends(null);
    void listTemplates(org).then((tpls) => { setTemplates(tpls); setCampTpl((c) => c || (tpls[0]?.templateId ?? '')); }).catch((e) => setError(e instanceof Error ? e.message : t('loadFailed')));
    void listCampaigns(org).then(setCampaigns).catch(() => setCampaigns([]));
  }, [t]);
  useEffect(() => { if (orgId) { setTemplates(null); setCampaigns(null); load(orgId); } }, [orgId, load]);

  const addTemplate = useCallback(async () => {
    if (!orgId || !nt.name.trim() || !nt.subject.trim() || !nt.body.trim()) return;
    setBusy(true);
    try { await createTemplate(orgId, { name: nt.name.trim(), subject: nt.subject.trim(), body: nt.body.trim() }); setNt({ name: '', subject: '', body: '' }); load(orgId); toast.success(t('templateCreated')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, nt, load, t]);

  const saveTemplate = useCallback(async () => {
    if (!orgId || !sel) return;
    setBusy(true);
    try { await updateTemplate(orgId, sel.templateId, { name: sel.name, subject: sel.subject, body: sel.body }); load(orgId); toast.success(t('templateSaved')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  }, [orgId, sel, load, t]);

  const removeTemplate = useCallback(async (id: string) => {
    try { await deleteTemplate(orgId, id); load(orgId); } catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const addCampaign = useCallback(async () => {
    if (!orgId || !campTpl) return;
    setBusy(true);
    try { await createCampaign(orgId, { templateId: campTpl, ...(campStage ? { stage: campStage } : {}) }); load(orgId); toast.success(t('campaignCreated')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, campTpl, campStage, load, t]);

  const send = useCallback(async (c: Campaign) => {
    const resend = c.status === 'sent';
    if (resend && !(await confirm({ title: t('resendConfirm') }))) return;
    try { const r = await sendCampaign(orgId, c.campaignId, resend); load(orgId); toast.success(t('sendResult', { sent: formatNumber(r.stats?.sent ?? 0), skipped: formatNumber(r.stats?.skipped ?? 0), failed: formatNumber(r.stats?.failed ?? 0) })); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('sendFailed')); }
  }, [orgId, load, t]);

  const removeCampaign = useCallback(async (id: string) => {
    try { await deleteCampaign(orgId, id); if (logFor === id) setLogFor(''); load(orgId); } catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, logFor, load, t]);

  const toggleLog = useCallback((id: string) => {
    if (logFor === id) { setLogFor(''); return; }
    setLogFor(id); setSends(null);
    void listSends(orgId, id).then(setSends).catch(() => setSends([]));
  }, [orgId, logFor]);

  const tplName = (id: string): string => (templates ?? []).find((tpl) => tpl.templateId === id)?.name ?? id;

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
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('templateNameLabel')}</span><input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} placeholder={t('templateNamePlaceholder')} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('subjectLabel')}</span><input value={nt.subject} onChange={(e) => setNt({ ...nt, subject: e.target.value })} placeholder={t('subjectPlaceholder')} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bodyLabel')}</span><input value={nt.body} onChange={(e) => setNt({ ...nt, body: e.target.value })} placeholder={t('bodyPlaceholder')} /></label>
            <button type="button" className="btn-primary" disabled={busy || !nt.name.trim()} onClick={() => void addTemplate()}><PlusIcon /> {t('newTemplate')}</button>
          </div>

          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('templatesHeading')}</h2>
            {!templates ? <Skeleton /> : templates.length === 0 ? <span className="u-label-sm">{t('noTemplates')}</span> : templates.map((tpl) => (
              <div key={tpl.templateId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${sel?.templateId === tpl.templateId ? 'btn-accent' : 'btn-ghost'} u-justify-start u-flex-1`} aria-current={sel?.templateId === tpl.templateId ? 'true' : undefined} onClick={() => setSel({ ...tpl })}>{tpl.name}</button>
                <button type="button" className="btn-ghost" title={t('deleteTemplate')} aria-label={t('deleteTemplate')} onClick={() => void removeTemplate(tpl.templateId)}><TrashIcon /></button>
              </div>
            ))}
            {sel ? (
              <div className="surface-inset u-gap-1 u-flex u-flex-col">
                <label className="u-label-sm">{t('editorNameLabel')}<input value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} /></label>
                <label className="u-label-sm">{t('editorSubjectLabel')}<input value={sel.subject} onChange={(e) => setSel({ ...sel, subject: e.target.value })} /></label>
                <label className="u-label-sm">{t('editorBodyLabel')}<textarea value={sel.body} rows={4} onChange={(e) => setSel({ ...sel, body: e.target.value })} /></label>
                <div className="u-flex u-justify-end"><button type="button" className="btn-primary" disabled={busy} onClick={() => void saveTemplate()}><SaveIcon /> {t('common:save')}</button></div>
              </div>
            ) : null}
          </div>

          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('campaignTemplateLabel')}</span>
              <select value={campTpl} onChange={(e) => setCampTpl(e.target.value)}>{(templates ?? []).map((tpl) => <option key={tpl.templateId} value={tpl.templateId}>{tpl.name}</option>)}</select>
            </label>
            <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">{t('audienceStageLabel')}</span>
              <select value={campStage} onChange={(e) => setCampStage(e.target.value as '' | ContactStage)} aria-label={t('audienceStageLabel')}>
                <option value="">{t('audienceAllContacts')}</option>
                {CONTACT_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <button type="button" className="btn-primary" disabled={busy || !campTpl} onClick={() => void addCampaign()}><PlusIcon /> {t('newCampaign')}</button>
          </div>

          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('campaignsHeading')}</h2>
            {!campaigns ? <Skeleton /> : campaigns.length === 0 ? <span className="u-label-sm">{t('noCampaigns')}</span> : campaigns.map((c) => (
              <div key={c.campaignId} className="surface-inset u-gap-1 u-flex u-flex-col">
                <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <strong className="u-flex-1">{tplName(c.templateId)}{c.audience.stage ? ` · ${c.audience.stage}` : ''}</strong>
                  <span className={campChip(c.status)}>{c.status}</span>
                  {c.stats ? <span className="u-label-sm">{t('campaignStats', { sent: formatNumber(c.stats.sent), skipped: formatNumber(c.stats.skipped), failed: formatNumber(c.stats.failed) })}</span> : null}
                  <div className="action-bar">
                    <button type="button" className="btn-ghost" aria-label={t('sendCampaignAria')} onClick={() => void send(c)}><SendIcon /> {c.status === 'sent' ? t('resend') : t('campaignSend')}</button>
                    <button type="button" className="btn-ghost" onClick={() => toggleLog(c.campaignId)}>{t('log')}</button>
                    <button type="button" className="btn-ghost" title={t('deleteCampaign')} aria-label={t('deleteCampaign')} onClick={() => void removeCampaign(c.campaignId)}><TrashIcon /></button>
                  </div>
                </div>
                {logFor === c.campaignId ? (
                  !sends ? <Skeleton /> : sends.length === 0 ? <span className="u-label-sm">{t('noSends')}</span> : sends.map((s) => (
                    <div key={s.sendId} className="u-flex u-gap-2 u-items-center">
                      <code className="u-flex-1">{s.contactId}</code>
                      <span className={sendChip(s.status)}>{s.status}{s.error ? `: ${s.error}` : ''}</span>
                    </div>
                  ))
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
