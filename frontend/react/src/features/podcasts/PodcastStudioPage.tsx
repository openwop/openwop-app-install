/**
 * Podcast Studio (ADR 0086 Phase 5) — manage reusable cast (Speaker) + show-format
 * (Episode) profiles, generate a multi-speaker episode from a research notebook, and
 * play back the result. Generation is an async executor run; the episode list polls
 * + projects status from the run. Composes the shared `ui/` cohesion layer.
 *
 * The audio is the ordered per-turn clip list (the v1 mix — ADR 0086 §mix): the
 * EpisodePlayer plays the clips back-to-back. Each clip is a tenant-scoped Media
 * asset URL the RFC 0105 synth produced.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { formatRelativeTime } from '../../i18n/format.js';
import { MicIcon, PlusIcon, TrashIcon, PlayIcon, RotateCwIcon, SparklesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  listOrgs, listNotebooksForPodcasts, assetUrl,
  listSpeakerProfiles, createSpeakerProfile, deleteSpeakerProfile,
  listEpisodeProfiles, createEpisodeProfile, deleteEpisodeProfile,
  listEpisodes, createEpisode, retryEpisode, deleteEpisode,
  type Org, type Speaker, type SpeakerProfile, type EpisodeProfile, type PodcastEpisode, type EpisodeStatus,
} from './podcastsClient.js';

const MAX_SPEAKERS = 4;

/** Status → chip variant (the shared chip semantics). */
function statusChip(status: EpisodeStatus): string {
  switch (status) {
    case 'done': return 'chip chip--success';
    case 'failed': return 'chip chip--danger';
    case 'awaiting-approval': return 'chip chip--warning';
    default: return 'chip chip--muted';
  }
}

/** Plays an episode: the single muxed file when available, else the ordered clips
 *  back-to-back (the playlist fallback when codecs were mixed — ADR 0086 §mix). */
function EpisodePlayer({ episode }: { episode: PodcastEpisode }): JSX.Element {
  const { t } = useTranslation('podcasts');
  const [idx, setIdx] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Single muxed file — one native player, no stitching.
  if (episode.audioMediaRef) {
    return <audio controls src={assetUrl(episode.audioMediaRef)} aria-label={t('episodeAudioLabel', { title: episode.title })} />;
  }

  const clips = episode.clips;
  const current = clips[idx];
  return (
    <div className="u-grid u-gap-1">
      <div className="u-text-sm muted">
        {t('clipProgress', { current: idx + 1, total: clips.length })}{current?.speaker ? ` · ${current.speaker}` : ''}
      </div>
      <audio
        ref={audioRef}
        controls
        src={current ? assetUrl(current.url) : undefined}
        aria-label={t('episodeAudioLabel', { title: episode.title })}
        onEnded={() => { if (idx < clips.length - 1) setIdx(idx + 1); }}
      />
      <div className="action-bar">
        <button type="button" className="btn-ghost" onClick={() => { setIdx(0); window.setTimeout(() => audioRef.current?.play().catch(() => undefined), 0); }}>
          <PlayIcon size={14} /> {t('playFromStart')}
        </button>
      </div>
    </div>
  );
}

function emptySpeaker(): Speaker { return { name: '', voiceId: '' }; }

/** When `fixedOrgId`/`fixedNotebookId` are supplied (the ProjectPodcastPanel embed,
 *  ADR 0084 correction), the org selector + notebook picker are hidden and episodes
 *  are scoped to that project; otherwise it's the full standalone studio. */
function Studio({ fixedOrgId, fixedNotebookId }: { fixedOrgId?: string; fixedNotebookId?: string } = {}): JSX.Element {
  const { t } = useTranslation('podcasts');
  const embedded = fixedNotebookId !== undefined;
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState(fixedOrgId ?? '');
  const [error, setError] = useState<string | null>(null);

  const [speakerProfiles, setSpeakerProfiles] = useState<SpeakerProfile[] | null>(null);
  const [episodeProfiles, setEpisodeProfiles] = useState<EpisodeProfile[] | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[] | null>(null);
  const [notebooks, setNotebooks] = useState<Array<{ id: string; name: string }>>([]);

  // Speaker-profile create form
  const [spName, setSpName] = useState('');
  const [spProvider, setSpProvider] = useState('minimax');
  const [spSpeakers, setSpSpeakers] = useState<Speaker[]>([emptySpeaker()]);
  const [spBusy, setSpBusy] = useState(false);

  // Episode-profile create form
  const [epName, setEpName] = useState('');
  const [epSpeakerProfileId, setEpSpeakerProfileId] = useState('');
  const [epSegments, setEpSegments] = useState('5');
  const [epBriefing, setEpBriefing] = useState('');
  const [epBusy, setEpBusy] = useState(false);

  // Generate form
  const [genNotebookId, setGenNotebookId] = useState(fixedNotebookId ?? '');
  const [genProfileId, setGenProfileId] = useState('');
  const [genTitle, setGenTitle] = useState('');
  const [genBriefing, setGenBriefing] = useState('');
  const [genBusy, setGenBusy] = useState(false);

  useEffect(() => {
    // Embedded in a project: org + notebook are fixed — skip the org list + notebook picker fetch.
    if (!fixedOrgId) {
      void listOrgs().then((o) => { setOrgs(o); const first = o[0]; if (first) setOrgId((cur) => cur || first.orgId); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
    if (!fixedNotebookId) {
      void listNotebooksForPodcasts().then(setNotebooks).catch(() => setNotebooks([]));
    }
  }, [fixedOrgId, fixedNotebookId]);

  const loadAll = useCallback(() => {
    if (!orgId) return;
    void listSpeakerProfiles(orgId).then(setSpeakerProfiles).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void listEpisodeProfiles(orgId).then(setEpisodeProfiles).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void listEpisodes(orgId).then(setEpisodes).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [orgId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Poll while any episode is mid-generation (status not terminal).
  useEffect(() => {
    if (!episodes || !episodes.some((e) => e.status === 'queued' || e.status === 'running' || e.status === 'awaiting-approval')) return;
    const id = window.setInterval(() => {
      if (orgId) void listEpisodes(orgId).then(setEpisodes).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, [episodes, orgId]);

  const submitSpeakerProfile = useCallback(async () => {
    if (!orgId || !spName.trim()) return;
    setSpBusy(true);
    try {
      await createSpeakerProfile({
        orgId, name: spName.trim(), provider: spProvider.trim() || 'minimax',
        speakers: spSpeakers.map((s) => ({ name: s.name.trim(), voiceId: s.voiceId.trim(), ...(s.personality?.trim() ? { personality: s.personality.trim() } : {}) })),
      });
      setSpName(''); setSpSpeakers([emptySpeaker()]);
      toast.success(t('speakerProfileCreated'));
      loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createFailed'));
    } finally { setSpBusy(false); }
  }, [orgId, spName, spProvider, spSpeakers, loadAll, t]);

  const submitEpisodeProfile = useCallback(async () => {
    if (!orgId || !epName.trim() || !epSpeakerProfileId) return;
    setEpBusy(true);
    try {
      await createEpisodeProfile({
        orgId, name: epName.trim(), speakerProfileId: epSpeakerProfileId,
        // Clamp to the server-validated 3–20 range so an out-of-range value doesn't 400.
        segmentCount: Math.min(20, Math.max(3, Number(epSegments) || 5)),
        ...(epBriefing.trim() ? { defaultBriefing: epBriefing.trim() } : {}),
      });
      setEpName(''); setEpBriefing('');
      toast.success(t('episodeProfileCreated'));
      loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createFailed'));
    } finally { setEpBusy(false); }
  }, [orgId, epName, epSpeakerProfileId, epSegments, epBriefing, loadAll, t]);

  const submitGenerate = useCallback(async () => {
    if (!orgId || !genNotebookId || !genProfileId) return;
    setGenBusy(true);
    try {
      await createEpisode({
        orgId, notebookId: genNotebookId, episodeProfileId: genProfileId,
        ...(genTitle.trim() ? { title: genTitle.trim() } : {}),
        ...(genBriefing.trim() ? { briefing: genBriefing.trim() } : {}),
      });
      setGenTitle(''); setGenBriefing('');
      toast.success(t('episodeEnqueued'));
      loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('generateFailed'));
    } finally { setGenBusy(false); }
  }, [orgId, genNotebookId, genProfileId, genTitle, genBriefing, loadAll, t]);

  const onRetry = useCallback(async (id: string) => {
    try { await retryEpisode(id); toast.success(t('episodeEnqueued')); loadAll(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('generateFailed')); }
  }, [loadAll, t]);

  const onDeleteSpeakerProfile = useCallback(async (id: string) => {
    if (!(await confirm({ title: t('confirmDeleteSpeakerProfile'), danger: true }))) return;
    try { await deleteSpeakerProfile(id); loadAll(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('deleteFailed')); }
  }, [loadAll, t]);

  const onDeleteEpisodeProfile = useCallback(async (id: string) => {
    if (!(await confirm({ title: t('confirmDeleteEpisodeProfile'), danger: true }))) return;
    try { await deleteEpisodeProfile(id); loadAll(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('deleteFailed')); }
  }, [loadAll, t]);

  const onDeleteEpisode = useCallback(async (id: string) => {
    if (!(await confirm({ title: t('confirmDeleteEpisode'), danger: true }))) return;
    try { await deleteEpisode(id); loadAll(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('deleteFailed')); }
  }, [loadAll, t]);

  const setSpeakerField = (i: number, field: keyof Speaker, value: string) =>
    setSpSpeakers((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));

  // Embedded: scope the episode list to this project (notebookId === the project id).
  const visibleEpisodes = embedded && episodes ? episodes.filter((e) => e.notebookId === fixedNotebookId) : episodes;

  return (
    <section className="u-grid u-gap-4">
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      {error ? <StateCard title={t('loadFailed')} body={error} /> : null}

      {embedded ? null : (
        <SelectField label={t('orgLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {!embedded && orgs.length === 0 && !error ? (
        <StateCard icon={<MicIcon size={20} />} title={t('title')} body={t('noOrgs')} />
      ) : null}

      {/* Speaker profiles (the cast) */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><MicIcon size={16} /> {t('speakerProfilesTitle')}</h2>
        {speakerProfiles === null ? <Skeleton height={40} /> : speakerProfiles.length === 0 ? (
          <StateCard icon={<MicIcon size={20} />} title={t('speakerProfilesTitle')} body={t('noSpeakerProfiles')} />
        ) : (
          <ul className="nb-list">
            {speakerProfiles.map((p) => (
              <li key={p.id} className="nb-list__item">
                <span><strong>{p.name}</strong> · {p.speakers.map((s) => s.name).join(', ')} <span className="chip chip--muted">{p.provider}</span></span>
                <button type="button" className="btn-ghost" onClick={() => void onDeleteSpeakerProfile(p.id)} aria-label={t('common:delete')}><TrashIcon size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitSpeakerProfile(); }}>
          <TextField label={t('speakerProfileNameLabel')} value={spName} onChange={(e) => setSpName(e.target.value)} placeholder={t('speakerProfileNamePlaceholder')} />
          <SelectField label={t('providerLabel')} value={spProvider} onChange={(e) => setSpProvider(e.target.value)}>
            <option value="minimax">MiniMax (managed)</option>
            <option value="openai">OpenAI (BYOK)</option>
            <option value="google">Google Gemini (BYOK)</option>
          </SelectField>
          {spSpeakers.map((s, i) => (
            <div key={i} className="u-grid u-gap-1 surface-card u-p-2">
              <div className="u-text-sm muted">{t('speakerN', { n: i + 1 })}</div>
              <TextField label={t('speakerNameLabel')} value={s.name} onChange={(e) => setSpeakerField(i, 'name', e.target.value)} placeholder="Ana" />
              <TextField label={t('voiceIdLabel')} value={s.voiceId} onChange={(e) => setSpeakerField(i, 'voiceId', e.target.value)} placeholder={t('voiceIdPlaceholder')} />
              <TextField label={t('personalityLabel')} value={s.personality ?? ''} onChange={(e) => setSpeakerField(i, 'personality', e.target.value)} placeholder={t('personalityPlaceholder')} />
              {spSpeakers.length > 1 ? (
                <button type="button" className="btn-ghost" onClick={() => setSpSpeakers((prev) => prev.filter((_, idx) => idx !== i))}><TrashIcon size={14} /> {t('removeSpeaker')}</button>
              ) : null}
            </div>
          ))}
          <div className="action-bar">
            {spSpeakers.length < MAX_SPEAKERS ? (
              <button type="button" className="btn-ghost" onClick={() => setSpSpeakers((prev) => [...prev, emptySpeaker()])}><PlusIcon size={14} /> {t('addSpeaker')}</button>
            ) : null}
            <button type="submit" className="btn-primary" disabled={spBusy || !spName.trim() || spSpeakers.some((s) => !s.name.trim() || !s.voiceId.trim())}>
              <PlusIcon size={14} /> {t('createSpeakerProfile')}
            </button>
          </div>
        </form>
      </div>

      {/* Episode (show-format) profiles */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><SparklesIcon size={16} /> {t('episodeProfilesTitle')}</h2>
        {episodeProfiles === null ? <Skeleton height={40} /> : episodeProfiles.length === 0 ? (
          <StateCard icon={<SparklesIcon size={20} />} title={t('episodeProfilesTitle')} body={t('noEpisodeProfiles')} />
        ) : (
          <ul className="nb-list">
            {episodeProfiles.map((p) => (
              <li key={p.id} className="nb-list__item">
                <span><strong>{p.name}</strong> · {t('segmentsN', { n: p.segmentCount })}</span>
                <button type="button" className="btn-ghost" onClick={() => void onDeleteEpisodeProfile(p.id)} aria-label={t('common:delete')}><TrashIcon size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitEpisodeProfile(); }}>
          <TextField label={t('episodeProfileNameLabel')} value={epName} onChange={(e) => setEpName(e.target.value)} placeholder={t('episodeProfileNamePlaceholder')} />
          <SelectField label={t('castLabel')} value={epSpeakerProfileId} onChange={(e) => setEpSpeakerProfileId(e.target.value)}>
            <option value="">{t('selectCast')}</option>
            {(speakerProfiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
          <TextField label={t('segmentCountLabel')} type="number" min={3} max={20} value={epSegments} onChange={(e) => setEpSegments(e.target.value)} />
          <TextareaField label={t('briefingLabel')} value={epBriefing} onChange={(e) => setEpBriefing(e.target.value)} rows={2} placeholder={t('briefingPlaceholder')} />
          <button type="submit" className="btn-primary" disabled={epBusy || !epName.trim() || !epSpeakerProfileId}><PlusIcon size={14} /> {t('createEpisodeProfile')}</button>
        </form>
      </div>

      {/* Generate */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><PlayIcon size={16} /> {t('generateTitle')}</h2>
        {!embedded && notebooks.length === 0 ? <StateCard icon={<PlayIcon size={20} />} title={t('generateTitle')} body={t('noNotebooks')} /> : null}
        <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitGenerate(); }}>
          {embedded ? null : (
            <SelectField label={t('notebookLabel')} value={genNotebookId} onChange={(e) => setGenNotebookId(e.target.value)}>
              <option value="">{t('selectNotebook')}</option>
              {notebooks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </SelectField>
          )}
          <SelectField label={t('episodeProfileLabel')} value={genProfileId} onChange={(e) => setGenProfileId(e.target.value)}>
            <option value="">{t('selectEpisodeProfile')}</option>
            {(episodeProfiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
          <TextField label={t('episodeTitleLabel')} value={genTitle} onChange={(e) => setGenTitle(e.target.value)} placeholder={t('episodeTitlePlaceholder')} />
          <TextareaField label={t('episodeBriefingLabel')} value={genBriefing} onChange={(e) => setGenBriefing(e.target.value)} rows={2} placeholder={t('briefingPlaceholder')} />
          <button type="submit" className="btn-primary" disabled={genBusy || !genNotebookId || !genProfileId}><SparklesIcon size={14} /> {t('generate')}</button>
        </form>
      </div>

      {/* Episodes */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><MicIcon size={16} /> {t('episodesTitle')}</h2>
        {visibleEpisodes === null ? <Skeleton height={60} /> : visibleEpisodes.length === 0 ? (
          <StateCard icon={<MicIcon size={20} />} title={t('noEpisodesTitle')} body={t('noEpisodesBody')} />
        ) : (
          <ul className="nb-list">
            {visibleEpisodes.map((e) => (
              <li key={e.id} className="nb-list__item">
                <div className="action-bar u-justify-between">
                  <span><strong>{e.title}</strong> <span className={statusChip(e.status)}>{t(`status_${e.status}` as 'status_done')}</span></span>
                  <span className="u-text-sm muted">{formatRelativeTime(e.createdAt)}</span>
                </div>
                {e.status === 'done' && (e.audioMediaRef || e.clips.length > 0) ? <EpisodePlayer episode={e} /> : null}
                {e.status === 'failed' ? <p className="u-text-sm u-text-danger">{e.error || t('episodeFailed')}</p> : null}
                <div className="action-bar">
                  {e.status === 'failed' || e.status === 'done' ? (
                    <button type="button" className="btn-ghost" onClick={() => void onRetry(e.id)}><RotateCwIcon size={14} /> {t('retry')}</button>
                  ) : null}
                  <button type="button" className="btn-ghost" onClick={() => void onDeleteEpisode(e.id)}><TrashIcon size={14} /> {t('common:delete')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function PodcastStudioPage(): JSX.Element {
  const { t } = useTranslation('podcasts');
  const podcasts = useFeatureAccess('podcasts');
  if (podcasts.loading) return <Skeleton />;
  if (!podcasts.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }
  return <Studio />;
}

/** Podcast tab embedded in a project (ADR 0084 correction) — the studio scoped to
 *  this project as the content source (no org/notebook pickers; episodes filtered to
 *  it). Toggle-gating is done by the host ProjectDetailPage tab. */
export function ProjectPodcastPanel({ orgId, projectId }: { orgId: string; projectId: string }): JSX.Element {
  return <Studio fixedOrgId={orgId} fixedNotebookId={projectId} />;
}
