/**
 * Email Marketing (host-extension product feature — ADR 0019).
 *
 * Gates on useFeatureAccess('email'). An org picker → templates (create/edit/
 * delete) → campaigns (pick template + audience stage → create → send) with
 * per-campaign stats + an inline send log (each recipient sent / skipped /
 * failed). Sends resolve the audience live from CRM and consent-gate marketing.
 */
import { useCallback, useEffect, useState } from 'react';
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
    void listTemplates(org).then((t) => { setTemplates(t); setCampTpl((c) => c || (t[0]?.templateId ?? '')); }).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'));
    void listCampaigns(org).then(setCampaigns).catch(() => setCampaigns([]));
  }, []);
  useEffect(() => { if (orgId) { setTemplates(null); setCampaigns(null); load(orgId); } }, [orgId, load]);

  const addTemplate = useCallback(async () => {
    if (!orgId || !nt.name.trim() || !nt.subject.trim() || !nt.body.trim()) return;
    setBusy(true);
    try { await createTemplate(orgId, { name: nt.name.trim(), subject: nt.subject.trim(), body: nt.body.trim() }); setNt({ name: '', subject: '', body: '' }); load(orgId); toast.success('Template created'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed.'); }
    finally { setBusy(false); }
  }, [orgId, nt, load]);

  const saveTemplate = useCallback(async () => {
    if (!orgId || !sel) return;
    setBusy(true);
    try { await updateTemplate(orgId, sel.templateId, { name: sel.name, subject: sel.subject, body: sel.body }); load(orgId); toast.success('Saved'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed.'); }
    finally { setBusy(false); }
  }, [orgId, sel, load]);

  const removeTemplate = useCallback(async (id: string) => {
    try { await deleteTemplate(orgId, id); load(orgId); } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, load]);

  const addCampaign = useCallback(async () => {
    if (!orgId || !campTpl) return;
    setBusy(true);
    try { await createCampaign(orgId, { templateId: campTpl, ...(campStage ? { stage: campStage } : {}) }); load(orgId); toast.success('Campaign created'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed.'); }
    finally { setBusy(false); }
  }, [orgId, campTpl, campStage, load]);

  const send = useCallback(async (c: Campaign) => {
    const resend = c.status === 'sent';
    if (resend && !window.confirm('This campaign was already sent — re-send to the whole audience? Every recipient is contacted again.')) return;
    try { const r = await sendCampaign(orgId, c.campaignId, resend); load(orgId); toast.success(`Sent ${r.stats?.sent ?? 0} · skipped ${r.stats?.skipped ?? 0} · failed ${r.stats?.failed ?? 0}`); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Send failed.'); }
  }, [orgId, load]);

  const removeCampaign = useCallback(async (id: string) => {
    try { await deleteCampaign(orgId, id); if (logFor === id) setLogFor(''); load(orgId); } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, logFor, load]);

  const toggleLog = useCallback((id: string) => {
    if (logFor === id) { setLogFor(''); return; }
    setLogFor(id); setSends(null);
    void listSends(orgId, id).then(setSends).catch(() => setSends([]));
  }, [orgId, logFor]);

  const tplName = (id: string): string => (templates ?? []).find((t) => t.templateId === id)?.name ?? id;

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Email is not enabled" body="Ask an administrator to enable the Email feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">{orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow="Workspace" title="Email" lede="Templated campaigns over your CRM contacts — consent-gated." actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title="No organizations" body="Create an organization first — campaigns belong to an org." />
      ) : (
        <>
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">Template name</span><input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} placeholder="Welcome" /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">Subject</span><input value={nt.subject} onChange={(e) => setNt({ ...nt, subject: e.target.value })} placeholder="Hi {{contact.name}}" /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">Body</span><input value={nt.body} onChange={(e) => setNt({ ...nt, body: e.target.value })} placeholder="Hello {{contact.name}} …" /></label>
            <button type="button" className="btn-primary" disabled={busy || !nt.name.trim()} onClick={() => void addTemplate()}><PlusIcon /> New template</button>
          </div>

          <div className="surface-card u-gap-2">
            <strong>Templates</strong>
            {!templates ? <Skeleton /> : templates.length === 0 ? <span className="u-label-sm">No templates yet.</span> : templates.map((t) => (
              <div key={t.templateId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${sel?.templateId === t.templateId ? 'btn-primary' : 'btn-ghost'} u-justify-start u-flex-1`} onClick={() => setSel({ ...t })}>{t.name}</button>
                <button type="button" className="btn-ghost" title="Delete template" aria-label="Delete template" onClick={() => void removeTemplate(t.templateId)}><TrashIcon /></button>
              </div>
            ))}
            {sel ? (
              <div className="surface-inset u-gap-1 u-flex u-flex-col">
                <label className="u-label-sm">Name<input value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} /></label>
                <label className="u-label-sm">Subject<input value={sel.subject} onChange={(e) => setSel({ ...sel, subject: e.target.value })} /></label>
                <label className="u-label-sm">Body<input value={sel.body} onChange={(e) => setSel({ ...sel, body: e.target.value })} /></label>
                <div className="u-flex u-justify-end"><button type="button" className="btn-primary" disabled={busy} onClick={() => void saveTemplate()}><SaveIcon /> Save</button></div>
              </div>
            ) : null}
          </div>

          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">Template</span>
              <select value={campTpl} onChange={(e) => setCampTpl(e.target.value)}>{(templates ?? []).map((t) => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}</select>
            </label>
            <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">Audience stage</span>
              <select value={campStage} onChange={(e) => setCampStage(e.target.value as '' | ContactStage)}>
                <option value="">all contacts</option>
                {CONTACT_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <button type="button" className="btn-primary" disabled={busy || !campTpl} onClick={() => void addCampaign()}><PlusIcon /> New campaign</button>
          </div>

          <div className="surface-card u-gap-2">
            <strong>Campaigns</strong>
            {!campaigns ? <Skeleton /> : campaigns.length === 0 ? <span className="u-label-sm">No campaigns yet.</span> : campaigns.map((c) => (
              <div key={c.campaignId} className="surface-inset u-gap-1 u-flex u-flex-col">
                <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <strong className="u-flex-1">{tplName(c.templateId)}{c.audience.stage ? ` · ${c.audience.stage}` : ''}</strong>
                  <span className={campChip(c.status)}>{c.status}</span>
                  {c.stats ? <span className="u-label-sm">{c.stats.sent} sent · {c.stats.skipped} skipped · {c.stats.failed} failed</span> : null}
                  <div className="action-bar">
                    <button type="button" className="btn-ghost" onClick={() => void send(c)}><SendIcon /> {c.status === 'sent' ? 'Re-send' : 'Send'}</button>
                    <button type="button" className="btn-ghost" onClick={() => toggleLog(c.campaignId)}>Log</button>
                    <button type="button" className="btn-ghost" title="Delete campaign" aria-label="Delete campaign" onClick={() => void removeCampaign(c.campaignId)}><TrashIcon /></button>
                  </div>
                </div>
                {logFor === c.campaignId ? (
                  !sends ? <Skeleton /> : sends.length === 0 ? <span className="u-label-sm">No sends yet.</span> : sends.map((s) => (
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
