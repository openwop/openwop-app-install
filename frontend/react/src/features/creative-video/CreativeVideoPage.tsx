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
import { TextField, TextareaField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { WandIcon, PlugIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { listOrgs, listVideoJobs, generateVideo, textToVideo, getVideoJob, type VideoJob, type VideoJobStatus, type OrgRef } from './creativeVideoClient.js';

const IN_FLIGHT: readonly VideoJobStatus[] = ['submitting', 'processing', 'downloading'];

type Mode = 'avatar' | 't2v';

const chipFor = (status: VideoJobStatus): string =>
  status === 'completed' ? 'chip chip--success' : status === 'failed' ? 'chip chip--danger' : 'chip chip--accent';

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobsFailed, setJobsFailed] = useState(false);

  const [mode, setMode] = useState<Mode>('avatar');
  const [script, setScript] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [t2vModel, setT2vModel] = useState('');

  const load = useCallback(async () => {
    if (!orgId) return;
    setError('');
    try { setJobs(await listVideoJobs(orgId)); setJobsFailed(false); }
    catch (e) { setJobs([]); setJobsFailed(true); setError(e instanceof Error ? e.message : String(e)); }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  // Poll in-flight jobs so a `pending`/`processing` render advances to `completed`
  // without a manual reload (grade-code CV-2 / grade-ux CV-3). GET-job resolves =
  // read + one server-side poll; stops once nothing is in flight.
  useEffect(() => {
    if (!orgId || !jobs || !jobs.some((j) => IN_FLIGHT.includes(j.status))) return;
    const timer = setInterval(() => {
      void (async () => {
        const settled = await Promise.all(jobs.map(async (j) =>
          IN_FLIGHT.includes(j.status) ? await getVideoJob(orgId, j.jobId).catch(() => j) : j));
        if (settled.some((j, i) => j.status !== jobs[i]?.status)) setJobs(settled);
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [jobs, orgId]);

  const t2vOn = t2vAccess.enabled;
  const canSubmit = mode === 't2v' ? !!prompt.trim() : (!!script.trim() && !!avatarId.trim());

  const generate = async (): Promise<void> => {
    if (!canSubmit || !orgId) return;
    setBusy(true);
    try {
      const out = mode === 't2v'
        ? await textToVideo(orgId, { prompt: prompt.trim(), ...(t2vModel.trim() ? { model: t2vModel.trim() } : {}) })
        : await generateVideo(orgId, { script: script.trim(), avatarId: avatarId.trim(), ...(voiceId.trim() ? { voiceId: voiceId.trim() } : {}) });
      if (out.status === 'completed') toast.success(t('genCompleted'));
      else if (out.status === 'pending') toast.info(t('genPending'));
      else toast.error(t('genFailed', { reason: out.error ?? '' }));
      // CV-G2 — clear ONLY on an outcome that consumed the input. A `failed`
      // result is the over-budget (429) / no-connection (409) / provider-error
      // (502) path: wiping a script the user just wrote makes a recoverable
      // error unrecoverable, and those are exactly the cases worth retrying.
      if (out.status !== 'failed') { if (mode === 't2v') setPrompt(''); else setScript(''); }
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
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
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Notice variant="info">{mode === 't2v' ? t('t2vCostNotice') : t('costNotice')}</Notice>

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
            {/* CV-G5 — the provider's model id is typed by hand; `help` is where
                that finally says so instead of leaving the field to be guessed. */}
            <TextField label={t('fieldModel')} help={t('modelHelp')} value={t2vModel}
              placeholder={t('modelPlaceholder')} onChange={(e) => setT2vModel(e.target.value)} />
          </>
        ) : (
          <>
            <TextareaField label={t('fieldScript')} required value={script} rows={4}
              placeholder={t('scriptPlaceholder')} onChange={(e) => setScript(e.target.value)} />
            <div className="u-flex u-gap-3 u-flex-wrap">
              <TextField label={t('fieldAvatar')} required help={t('avatarHelp')} value={avatarId}
                placeholder={t('avatarPlaceholder')} onChange={(e) => setAvatarId(e.target.value)} />
              <TextField label={t('fieldVoice')} help={t('voiceHelp')} value={voiceId}
                placeholder={t('voicePlaceholder')} onChange={(e) => setVoiceId(e.target.value)} />
            </div>
          </>
        )}
        <div><Button variant="primary" type="submit" disabled={busy || !canSubmit || !orgId}>{busy ? t('generating') : t('generate')}</Button></div>
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
              <span className={chipFor(job.status)}>{t(`status_${job.status}`)}</span>
              <span className="u-fs-12 u-text-muted">{formatDateTime(job.createdAt)}</span>
              {/* CV-G3 — the reason a job FAILED sat in the same muted grey as
                  its timestamp, beside a danger chip. It is the only actionable
                  thing on the row. */}
              {job.error ? <span className={`u-fs-12 ${job.status === 'failed' ? 'u-text-danger' : 'u-text-muted'}`}>{job.error}</span> : null}
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
