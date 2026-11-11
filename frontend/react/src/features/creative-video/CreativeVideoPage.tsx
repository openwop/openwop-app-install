/**
 * AI Video creative affordance (ADR 0404 §b) — generate an avatar video from a
 * script/brief; the async job lands a provenance-stamped asset in the media
 * library. Minimal by design (no bespoke chat panel — the same node also composes
 * into workflows + the chat drive). Built on the shared ui/ design system.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField, TextareaField, SelectField, CheckboxField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { announce } from '../../ui/announce.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { WandIcon, PlugIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { reasonKey } from './videoReasons.js';
import { listOrgs, listVideoJobs, listVideoModels, generateVideo, textToVideo, getVideoJob, VideoApiError, type VideoJob, type VideoJobStatus, type VideoModel, type VideoModels, type OrgRef } from './creativeVideoClient.js';

const IN_FLIGHT: readonly VideoJobStatus[] = ['submitting', 'processing', 'downloading'];

type Mode = 'avatar' | 't2v';

/** CV83UX-6 — an unconfirmed submit is not a plain failure: the provider may be
 *  rendering (and charging) it, so it reads as a warning with its own label. */
const isUnconfirmed = (job: Pick<VideoJob, 'status' | 'error'>): boolean => job.status === 'failed' && job.error === 'submit_unconfirmed';
const chipFor = (job: VideoJob): string =>
  job.status === 'completed' ? 'chip chip--success' : isUnconfirmed(job) ? 'chip chip--warning' : job.status === 'failed' ? 'chip chip--danger' : 'chip chip--accent';

/** The whole seconds a model takes, for the duration select. */
function durationsOf(m: VideoModel): number[] {
  if ('oneOf' in m.duration) return [...m.duration.oneOf];
  const out: number[] = [];
  for (let d = m.duration.min; d <= m.duration.max; d += 1) out.push(d);
  return out;
}

export function CreativeVideoPage(): JSX.Element {
  const { t } = useTranslation('creative-video');
  const access = useFeatureAccess('creative-video');
  const t2vAccess = useFeatureAccess('creative-video.t2v');
  const navigate = useNavigate();
  // CV-G1 — a failed READ is not an empty RESULT. Both catches here wrote `[]`,
  // so an unreachable server rendered "No workspace yet — create one" and "No
  // videos yet": two confident claims about state we had failed to read, one of
  // them an INSTRUCTION to go and create something that may already exist.
  //
  // HG-4 — the org half of that now rides the shared seam. The hand-rolled version
  // kept the `setOrgs([])` sentinel it was trying to avoid (it set BOTH the empty
  // list and the flag, and the zero-org branch was reached only BECAUSE of it), so
  // this page sat outside the ratchet the other adopters are held to.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<OrgRef>(listOrgs, access.enabled);
  const [jobs, setJobs] = useState<VideoJob[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobsFailed, setJobsFailed] = useState(false);

  const [mode, setMode] = useState<Mode>('avatar');
  const [script, setScript] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [t2vModel, setT2vModel] = useState('');
  const [t2vRatio, setT2vRatio] = useState('');
  const [t2vDuration, setT2vDuration] = useState(0);
  const [consented, setConsented] = useState(false);
  // ADR 1051 D2/D5 — the host's model table and consent-sentence version.
  const [models, setModels] = useState<VideoModels | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);

  // CV83UX-3 — a failed read is the `jobsFailed` card below; the raw transport
  // message ("listVideoJobs returned 500") is never shown.
  const load = useCallback(async () => {
    if (!orgId) return;
    try { setJobs(await listVideoJobs(orgId)); setJobsFailed(false); }
    catch { setJobs([]); setJobsFailed(true); }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const loadModels = useCallback(async () => {
    if (!orgId) return;
    try { setModels(await listVideoModels(orgId)); setModelsFailed(false); }
    catch { setModels(null); setModelsFailed(true); }
  }, [orgId]);
  useEffect(() => { void loadModels(); }, [loadModels]);

  const t2vModels = (models?.models ?? []).filter((m) => m.endpoints.includes('t2v'));
  const activeModel = t2vModels.find((m) => m.id === t2vModel) ?? t2vModels.find((m) => m.id === models?.defaultModel) ?? t2vModels[0];
  const ratios = activeModel?.ratios.t2v ?? [];
  const ratio = ratios.includes(t2vRatio) ? t2vRatio : (ratios[0] ?? '');
  const durations = activeModel ? durationsOf(activeModel) : [];
  const duration = durations.includes(t2vDuration) ? t2vDuration : (activeModel?.defaultDurationSec ?? 0);

  // Poll in-flight jobs so a `pending`/`processing` render advances to `completed`
  // without a manual reload (grade-code CV-2 / grade-ux CV-3). GET-job resolves =
  // read + one server-side poll; stops once nothing is in flight.
  useEffect(() => {
    if (!orgId || !jobs || !jobs.some((j) => IN_FLIGHT.includes(j.status))) return;
    const timer = setInterval(() => {
      void (async () => {
        const settled = await Promise.all(jobs.map(async (j) =>
          IN_FLIGHT.includes(j.status) ? await getVideoJob(orgId, j.jobId).catch(() => j) : j));
        if (settled.some((j, i) => j.status !== jobs[i]?.status)) {
          // CV83UX-8 — a job that finishes while the page polls is spoken, not
          // only re-coloured.
          for (const [i, j] of settled.entries()) {
            if (j.status === jobs[i]?.status) continue;
            if (j.status === 'completed') announce(t('genCompleted'));
            else if (j.status === 'failed') announce(t('genFailed', { reason: t(reasonKey(j.error)) }), { assertive: true });
          }
          setJobs(settled);
        }
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [jobs, orgId, t]);

  const t2vOn = t2vAccess.enabled;
  // CV83UX-2 — say WHY Generate is disabled, first unmet condition first.
  const blockedKey = modelsFailed ? 'blockedOptionsFailed' : !models ? 'blockedOptionsLoading'
    : mode === 't2v'
      ? (!activeModel ? 'blockedNoModels' : !prompt.trim() ? 'blockedPrompt' : '')
      : (!script.trim() ? 'blockedScript' : !avatarId.trim() ? 'blockedAvatar' : !consented ? 'blockedConsent' : '');
  const canSubmit = blockedKey === '';

  const generate = async (): Promise<void> => {
    if (!canSubmit || !orgId) return;
    setBusy(true);
    try {
      const out = mode === 't2v'
        ? await textToVideo(orgId, { prompt: prompt.trim(), ...(activeModel ? { model: activeModel.id, ratio, durationSec: duration } : {}) })
        : await generateVideo(orgId, { script: script.trim(), avatarId: avatarId.trim(), ...(voiceId.trim() ? { voiceId: voiceId.trim() } : {}), consent: { attested: consented, textVersion: models!.likenessConsentTextVersion } });
      if (out.status === 'completed') toast.success(t('genCompleted'));
      else if (out.status === 'pending') toast.info(t('genPending'));
      else if (out.error === 'submit_unconfirmed') toast.warning(t('reason_submit_unconfirmed'));
      else toast.error(t('genFailed', { reason: t(reasonKey(out.error)) }));
      // CV-G2 — clear ONLY on an outcome that consumed the input. A `failed`
      // result is the over-budget (429) / no-connection (409) / provider-error
      // (502) path: wiping a script the user just wrote makes a recoverable
      // error unrecoverable, and those are exactly the cases worth retrying.
      // CV83UX-6 — an unconfirmed submit consumed it too: keeping the text would
      // invite a second paid submit of the same request.
      if (out.status !== 'failed' || out.error === 'submit_unconfirmed') { if (mode === 't2v') setPrompt(''); else setScript(''); }
      await load();
    } catch (e) { toast.error(e instanceof VideoApiError && e.code ? t('genFailed', { reason: t(reasonKey(e.code)) }) : t('actionFailed')); }
    finally { setBusy(false); }
  };

  if (access.loading) return <SkeletonRows rows={3} columns={[90, 150, 110]} />;
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="ai-video.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }
  const orgPicker = orgs && orgs.length > 1 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <section className="u-grid u-gap-4" data-walkthrough="ai-video.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={<span className="action-bar">{orgPicker}<Button variant="secondary" onClick={() => navigate('/connections')}><PlugIcon size={14} /> {t('connectProvider')}</Button></span>}
      />

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s. It wraps the generate form too: `orgId` gates both
          the job read and every submit, so with no org the form is inert, and the
          card it replaces used to instruct the reader to "create a workspace" on a
          read that had merely failed. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<WandIcon />}>
      <Notice variant="info">{mode === 't2v' ? t('t2vCostNotice') : t('costNotice')}</Notice>
      {modelsFailed ? (
        <Notice variant="error" announce={t('modelsFailed')}>
          {t('modelsFailed')}{' '}
          <Button variant="quiet" onClick={() => { void loadModels(); }}>{t('retry')}</Button>
        </Notice>
      ) : null}

      <form className="surface-card u-p-4 surface-form u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void generate(); }}>
        <div className="u-flex u-items-center u-gap-2 u-justify-between u-flex-wrap">
          <span className="u-flex u-items-center u-gap-2"><WandIcon size={16} /><strong>{t('generateTitle')}</strong></span>
          {t2vOn ? (
            <div className="segmented" role="group" aria-label={t('modeLabel')}>
              <Button variant="primary" aria-pressed={mode === 'avatar'} onClick={() => setMode('avatar')}>{t('modeAvatar')}</Button>
              <Button variant="primary" aria-pressed={mode === 't2v'} onClick={() => setMode('t2v')}>{t('modeT2V')}</Button>
            </div>
          ) : null}
        </div>

        {mode === 't2v' ? (
          <>
            <TextareaField label={t('fieldPrompt')} required value={prompt} rows={4}
              placeholder={t('promptPlaceholder')} onChange={(e) => setPrompt(e.target.value)} />
            {/* ADR 1051 D2 — the model, ratio and duration come from the host's
                table (the provider's published API), so a typo can never reach a
                paid submit. */}
            {models && !activeModel ? <Notice variant="warning">{t('noT2vModels')}</Notice> : (
            <div className="u-flex u-gap-3 u-flex-wrap">
              <SelectField label={t('fieldModel')} help={t('modelHelp')} value={activeModel?.id ?? ''}
                disabled={!activeModel} onChange={(e) => setT2vModel(e.target.value)}>
                {t2vModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </SelectField>
              <SelectField label={t('fieldRatio')} value={ratio} disabled={!activeModel} onChange={(e) => setT2vRatio(e.target.value)}>
                {ratios.map((r) => <option key={r} value={r}>{r}</option>)}
              </SelectField>
              <SelectField label={t('fieldDuration')} value={String(duration)} disabled={!activeModel} onChange={(e) => setT2vDuration(Number(e.target.value))}>
                {durations.map((d) => <option key={d} value={d}>{t('durationOption', { count: d })}</option>)}
              </SelectField>
            </div>
            )}
          </>
        ) : (
          <>
            <TextareaField label={t('fieldScript')} required value={script} rows={4}
              placeholder={t('scriptPlaceholder')} onChange={(e) => setScript(e.target.value)} />
            <div className="u-flex u-gap-3 u-flex-wrap">
              {/* CV83UX-1 — consent is recorded for exactly this avatar and voice,
                  so changing either takes the tick back. */}
              <TextField label={t('fieldAvatar')} required help={t('avatarHelp')} value={avatarId}
                placeholder={t('avatarPlaceholder')} onChange={(e) => { setAvatarId(e.target.value); setConsented(false); }} />
              <TextField label={t('fieldVoice')} help={t('voiceHelp')} value={voiceId}
                placeholder={t('voicePlaceholder')} onChange={(e) => { setVoiceId(e.target.value); setConsented(false); }} />
            </div>
            {/* ADR 1051 D5 — a person affirms consent for this avatar and voice.
                It is recorded against them, and their workflows may then use the
                same avatar; nothing is sent without it. */}
            <CheckboxField label={t('consentLabel')} help={t('consentHelp')} required checked={consented}
              onChange={(e) => setConsented(e.target.checked)} />
          </>
        )}
        <div className="u-grid u-gap-1">
          <div><Button variant="primary" type="submit" disabled={busy || !canSubmit || !orgId} aria-describedby={blockedKey ? 'cv-generate-blocked' : undefined}>{busy ? t('generating') : t('generate')}</Button></div>
          {blockedKey ? <span id="cv-generate-blocked" className="field-help">{t(blockedKey)}</span> : null}
        </div>
      </form>

      {jobs === null ? <SkeletonRows rows={3} columns={[90, 150, 110]} /> : jobs.length === 0 ? (
        jobsFailed
          ? <StateCard announce icon={<WandIcon />} title={t('jobsFailedTitle')} body={t('jobsFailedBody')}
              action={<Button variant="secondary" onClick={() => { void load(); }}>{t('retry')}</Button>} />
          : <StateCard icon={<WandIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {jobs.map((job) => (
            <li key={job.jobId} className="surface-card u-p-4 u-flex u-items-center u-gap-2 u-flex-wrap">
              <span className={chipFor(job)}>{isUnconfirmed(job) ? t('status_unconfirmed') : t(`status_${job.status}`)}</span>
              <span className="u-fs-12 u-text-muted">{formatDateTime(job.createdAt)}</span>
              {/* CV-G3 — the reason a job FAILED sat in the same muted grey as
                  its timestamp, beside a danger chip. It is the only actionable
                  thing on the row. */}
              {job.error ? <span className={`u-fs-12 ${job.status === 'failed' && !isUnconfirmed(job) ? 'u-text-danger' : 'u-text-muted'}`}>{t(reasonKey(job.error))}</span> : null}
              {job.status === 'completed' && job.assetId ? (
                <Button variant="quiet" onClick={() => navigate('/media')}>{t('viewInMedia')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      </OrgSelectionState>
    </section>
  );
}
