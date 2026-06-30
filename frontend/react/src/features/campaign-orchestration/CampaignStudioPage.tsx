/**
 * Campaign Studio page (ADR 0158, Phase 3). Lists marketing campaigns + a detail
 * view (read-only messaging kernel, channels, editable status) on the shared ui/
 * cohesion layer. Running a campaign happens through the one chat scoped to the
 * Campaign Strategist agent (ADR 0058 — deep-link, no second chat). Finalize a
 * confirmed brief into a campaign from the picker. NOT a metrics dashboard
 * (intelligence is ADR 0160) — the "build ON orchestration" rule.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { SelectField } from '../../ui/Field.js';
import { MegaphoneIcon, PlusIcon, TrashIcon, SparklesIcon } from '../../ui/icons/index.js';
import {
  listCampaigns, finalizeBrief, updateCampaign, deleteCampaign, listBriefs, listOrgs,
  FeatureDisabledError, CAMPAIGN_STATUSES, CAMPAIGN_STRATEGIST_AGENT,
  type MarketingCampaign, type CampaignStatus, type BriefRef, type OrgRef,
} from './campaignStudioClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

export function CampaignStudioPage(): JSX.Element {
  const { t } = useTranslation('campaign-orchestration');
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<MarketingCampaign[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<MarketingCampaign | null>(null);

  const refresh = useCallback(async () => {
    try { setCampaigns(await listCampaigns()); }
    catch (e) { if (e instanceof FeatureDisabledError) { setDisabled(true); setCampaigns([]); return; } setError(e instanceof Error ? e.message : 'load failed'); }
  }, []);
  useEffect(() => { void refresh(); void listOrgs().then(setOrgs).catch(() => {}); }, [refresh]);

  const current = useMemo(() => campaigns?.find((c) => c.id === selected) ?? null, [campaigns, selected]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  if (current) {
    return (
      <CampaignDetail t={t} campaign={current} onBack={() => { setSelected(null); void refresh(); }} onChanged={refresh} onError={setError}
        onRun={() => navigate(`/?agent=${encodeURIComponent(CAMPAIGN_STRATEGIST_AGENT)}`)} />
    );
  }

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={(
          <div className="u-flex u-gap-2">
            <button type="button" className="secondary btn-sm" onClick={() => navigate(`/?agent=${encodeURIComponent(CAMPAIGN_STRATEGIST_AGENT)}`)}><SparklesIcon size={13} /> {t('runWithStrategist')}</button>
            {campaigns && campaigns.length > 0 ? <button type="button" className="btn-primary btn-sm" onClick={() => setFinalizeOpen(true)}><PlusIcon size={13} /> {t('finalizeBrief')}</button> : null}
          </div>
        )} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {campaigns === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loading')} loading />
      ) : campaigns.length === 0 ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('emptyTitle')} body={t('emptyBody')}
          action={<button type="button" className="btn-primary btn-sm" onClick={() => setFinalizeOpen(true)}><PlusIcon size={13} /> {t('finalizeBrief')}</button>} />
      ) : (
        <ul className="surface-card list-view u-list-none u-m-0">
          {campaigns.map((c) => (
            <li key={c.id} className="list-row">
              <button type="button" className="list-row-id" onClick={() => setSelected(c.id)}>
                <span className="list-row-name-wrap">
                  <span className="list-row-name-line"><span className="list-row-name u-fw-600">{c.name}</span><StatusChip status={c.status} t={t} /></span>
                  {c.objective ? <span className="u-fs-13 u-text-muted">{c.objective}</span> : null}
                </span>
              </button>
              <div className="list-row-name-line">
                {c.kernel ? <span className="chip chip--success">{t('hasKernel')}</span> : null}
                <span className="chip chip--muted">{t('channelsCount', { count: c.channels.length })}</span>
              </div>
              <button type="button" className="ghost btn-sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(c)}><TrashIcon size={15} /></button>
            </li>
          ))}
        </ul>
      )}

      {finalizeOpen ? <FinalizeModal t={t} orgs={orgs} onClose={() => setFinalizeOpen(false)} onDone={async (c) => { setFinalizeOpen(false); await refresh(); setSelected(c.id); }} onError={setError} /> : null}
      {confirmDelete ? (
        <ConfirmDialog title={t('deleteTitle')} body={t('deleteBody')} confirmLabel={t('common:delete')} danger
          onConfirm={async () => { try { await deleteCampaign(confirmDelete.id); setConfirmDelete(null); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'delete failed'); } }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </div>
  );
}

function StatusChip({ status, t }: { status: CampaignStatus; t: TFn }): JSX.Element {
  const cls = status === 'active' ? 'chip--success' : status === 'completed' ? 'chip--accent' : status === 'paused' ? 'chip--warning' : 'chip--muted';
  return <span className={`chip ${cls}`}>{t(`status_${status}`)}</span>;
}

function FinalizeModal({ t, orgs, onClose, onDone, onError }: { t: TFn; orgs: OrgRef[]; onClose: () => void; onDone: (c: MarketingCampaign) => void; onError: (m: string) => void }): JSX.Element {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? '');
  const [briefs, setBriefs] = useState<BriefRef[]>([]);
  const [briefId, setBriefId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void listBriefs(orgId || undefined).then((b) => { setBriefs(b); setBriefId((cur) => cur || b[0]?.id || ''); }).catch(() => {}); }, [orgId]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try { onDone(await finalizeBrief(briefId)); }
    catch (e) { onError(e instanceof Error ? e.message : 'finalize failed'); setBusy(false); }
  };
  return (
    <Modal label={t('finalizeBrief')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{t('finalizeBrief')}</h2>
      <p className="u-text-muted">{t('finalizeHint')}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (briefId && !busy) void submit(); }}>
        {orgs.length > 1 ? (
          <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">{t('allOrgs')}</option>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
        ) : null}
        <SelectField label={t('fieldBrief')} value={briefId} onChange={(e) => setBriefId(e.target.value)} required>
          {briefs.length === 0 ? <option value="">{t('noBriefs')}</option> : briefs.map((b) => <option key={b.id} value={b.id}>{b.name}{b.kernel ? ` ✓` : ''}</option>)}
        </SelectField>
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!briefId || busy}>{t('finalize')}</button>
        </div>
      </form>
    </Modal>
  );
}

function CampaignDetail({ t, campaign, onBack, onChanged, onError, onRun }: { t: TFn; campaign: MarketingCampaign; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onRun: () => void }): JSX.Element {
  const setStatus = async (status: CampaignStatus): Promise<void> => {
    try { await updateCampaign(campaign.id, { status }); await onChanged(); } catch (e) { onError(e instanceof Error ? e.message : 'update failed'); }
  };
  return (
    <div>
      <div className="action-bar u-flex u-items-center u-gap-2 u-mb-4">
        <button type="button" className="ghost btn-sm" onClick={onBack}>← {t('backToCampaigns')}</button>
        <h2 className="u-m-0 u-flex-1">{campaign.name}</h2>
        <SelectField label={t('statusLabel')} value={campaign.status} onChange={(e) => void setStatus(e.target.value as CampaignStatus)} containerStyle={{ marginBottom: 0 }}>
          {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </SelectField>
        <button type="button" className="btn-primary btn-sm" onClick={onRun}><SparklesIcon size={13} /> {t('runWithStrategist')}</button>
      </div>

      {campaign.kernel ? (
        <section className="surface-card u-mb-4">
          <div className="u-flex u-items-center u-gap-2 u-mb-2"><SparklesIcon size={16} /> <h3 className="u-m-0">{t('kernelTitle')}</h3></div>
          <p className="u-fw-600 u-mb-1">{campaign.kernel.headline}</p>
          <p className="u-text-muted u-mt-0">{campaign.kernel.supportingStatement}</p>
          {campaign.kernel.proofPoints.length ? <ul>{campaign.kernel.proofPoints.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
          <p className="u-fs-13"><strong>{t('kernelCta')}:</strong> {campaign.kernel.primaryCta} · <strong>{t('kernelTone')}:</strong> {campaign.kernel.tone}</p>
        </section>
      ) : (
        <Notice variant="info">{t('noKernel')} <button type="button" className="btn-link" onClick={onRun}>{t('runWithStrategist')}</button></Notice>
      )}

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('channelsTitle')}</h3>
        {campaign.channels.length === 0 ? <p className="u-text-muted">{t('noChannels')}</p> : (
          <div className="list-row-name-line">{campaign.channels.map((c) => <span key={c} className="chip chip--muted">{t(`channel_${c}`, { defaultValue: c })}</span>)}</div>
        )}
      </section>
    </div>
  );
}
