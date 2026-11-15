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
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { formatRelativeTime } from '../../i18n/format.js';
import { MicIcon, PlusIcon, TrashIcon, PlayIcon, RotateCwIcon, SparklesIcon, CheckIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  listOrgs, listNotebooksForPodcasts, assetUrl,
  listSpeakerProfiles, createSpeakerProfile, deleteSpeakerProfile,
  listEpisodeProfiles, createEpisodeProfile, deleteEpisodeProfile,
  listEpisodes, createEpisode, retryEpisode, deleteEpisode,
  listShows, listEpisodesWithCapability, setEpisodePublished,
  type Org, type Speaker, type SpeakerProfile, type EpisodeProfile, type PodcastEpisode, type EpisodeStatus, type PodcastShow,
} from './podcastsClient.js';
import { FAILURE_CODES, requestErrorText, type ErrorFallbackKey } from './podcastsErrors.js';
import { Notice } from '../../ui/Notice.js';
import { Link } from 'react-router-dom';
import { announce } from '../../ui/announce.js';
import { ShowsManager } from './ShowsManager.js';
import { PodcastAudio } from './PodcastAudio.js';

const MAX_SPEAKERS = 4;

/** PODU-3 (ADR 0603 §5) — the generation poll's BOUND. A podcast run is an LLM
 *  outline + an LLM transcript + one TTS call per dialogue turn, so it is minutes,
 *  not seconds — hence a longer cap than the notebooks pollers'. The give-up copy
 *  derives its "about N seconds" from these two constants rather than restating a
 *  number that could drift away from the loop. */
const POLL_INTERVAL_MS = 3000;
/** Exported so the `C1` witness asserts the EXACT tick the bound bites on, against
 *  this constant rather than a number copied into a test that could drift from it. */
export const POLL_MAX_ATTEMPTS = 60; // ~180s
const POLL_BUDGET_SECONDS = Math.round((POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS) / 1000);

/** Status → chip variant (the shared chip semantics). */
function statusChip(status: EpisodeStatus): string {
  switch (status) {
    case 'done': return 'chip chip--success';
    case 'failed': return 'chip chip--danger';
    case 'awaiting-approval': return 'chip chip--warning';
    // §5.3: an ACTIVE state reads accent, not muted (CONT-9).
    case 'queued':
    case 'running': return 'chip chip--accent';
    default: return 'chip chip--muted';
  }
}

/** Plays an episode: the single muxed file when available, else the ordered clips
 *  back-to-back (the playlist fallback when codecs were mixed — ADR 0086 §mix). */
function EpisodePlayer({ episode }: { episode: PodcastEpisode }): JSX.Element {
  const { t } = useTranslation('podcasts');
  const [idx, setIdx] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // ADR 1115 D10 (`PODUX93-3`) — "back-to-back" was not true: advancing changed `src`
  // and nothing called `play()`, so the listener pressed play after every turn. Once
  // the listener has started playback, each advance continues it. A new clip list (a
  // regeneration) starts over at turn 1, so `idx` can never point past the end.
  const playing = useRef(false);
  const clipsKey = episode.clips.map((c) => c.url).join('|');
  useEffect(() => { setIdx(0); playing.current = false; }, [episode.id, clipsKey]);
  useEffect(() => {
    if (playing.current) audioRef.current?.play().catch(() => undefined);
  }, [idx]);

  // Single muxed file — one native player, no stitching.
  if (episode.audioMediaRef) {
    return <PodcastAudio controls src={assetUrl(episode.audioMediaRef)} aria-label={t('episodeAudioLabel', { title: episode.title })} />;
  }

  const clips = episode.clips;
  const current = clips[idx];
  return (
    <div className="u-grid u-gap-1">
      <div className="u-text-sm muted">
        {t('clipProgress', { current: idx + 1, total: clips.length })}{current?.speaker ? ` · ${current.speaker}` : ''}
      </div>
      <PodcastAudio
        audioRef={audioRef}
        controls
        src={current ? assetUrl(current.url) : undefined}
        aria-label={t('episodeAudioLabel', { title: episode.title })}
        onPlay={() => { playing.current = true; }}
        onEnded={() => { if (idx < clips.length - 1) setIdx(idx + 1); else playing.current = false; }}
      />
      <div className="action-bar">
        <Button variant="quiet" onClick={() => { playing.current = true; setIdx(0); window.setTimeout(() => audioRef.current?.play().catch(() => undefined), 0); }}>
          <PlayIcon size={14} /> {t('playFromStart')}
        </Button>
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
  // HG-4 — this page hand-rolled the org read with `orgs` NON-nullable (`[]` from
  // the first paint), so its zero-org card fired while the read was still in
  // flight and its copy answered a question nobody had asked yet: "No workspace
  // yet — create one to manage podcasts." That was also the wrong COLLECTION
  // (`listOrgs`, not `listMyWorkspaces`) and the picker beside it was labelled
  // "Workspace". The hook keeps `orgs` null until the server answers and gives
  // the failure its own flag; `OrgSelectionState` owns the noun and the order.
  //
  // The read is DISABLED when embedded in a project: `fixedOrgId` is the scope,
  // so `orgs` stays null there and the guard falls straight through to the
  // panels — the same shape the old `if (!fixedOrgId)` effect had.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, fixedOrgId === undefined, fixedOrgId ?? '');
  // R2 SP-5 — per-read failure flags. The old shape was ONE last-write-wins
  // raw `e.message` StateCard while every list's skeleton spun forever under
  // it; a failed read now names its own section and offers retry.
  // SP-9 — the server stays the authority. ADR 1115 D10 (`PODUX93-6`): capability
  // starts UNKNOWN (`null`) and write controls stay hidden until a read answers; it
  // used to default `true`, so a failed episodes read offered every write to a
  // read-only member, each one a 403.
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  const writable = canWrite === true;
  /** ADR 1115 D10 (`PODUX93-10`) — a refusal in the reader's language; only an
   *  unmapped failure (a validation message) keeps the server's own text. */
  const errorText = useCallback((err: unknown, fallback: ErrorFallbackKey): string =>
    requestErrorText((k) => t(k as 'createFailed'), err, fallback), [t]);
  const [speakerProfilesFailed, setSpeakerProfilesFailed] = useState(false);
  const [episodeProfilesFailed, setEpisodeProfilesFailed] = useState(false);
  const [episodesFailed, setEpisodesFailed] = useState(false);
  const [notebooksFailed, setNotebooksFailed] = useState(false);
  // `PODU-8` (ADR 0603 §7) — "notebooks is switched OFF" is a THIRD state, distinct
  // from "the read failed" and from "you have none yet". Telling a user whose
  // administrator disabled notebooks to go and create one is an instruction they
  // cannot perform: there is no surface to perform it on.
  const [notebooksUnavailable, setNotebooksUnavailable] = useState(false);
  // ADR 1115 D4 — a podcasts run grounds on a notebook. The standalone Studio learns
  // "notebooks is off" from its notebooks read; the project-embedded panel never makes
  // that read, so it asks the feature resolver.
  const notebooksAccess = useFeatureAccess('notebooks');
  const notebooksOff = embedded ? (!notebooksAccess.loading && !notebooksAccess.enabled) : notebooksUnavailable;

  const [speakerProfiles, setSpeakerProfiles] = useState<SpeakerProfile[] | null>(null);
  const [episodeProfiles, setEpisodeProfiles] = useState<EpisodeProfile[] | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[] | null>(null);
  const [shows, setShows] = useState<PodcastShow[]>([]);
  // The empty branch INSTRUCTS ("Create a show above…"). Telling someone to
  // create what they may already own — because we could not read it — is the
  // worst shape in this family, so failure gets its own flag.
  const [showsFailed, setShowsFailed] = useState(false);
  const [notebooks, setNotebooks] = useState<Array<{ id: string; name: string }>>([]);
  // Per-episode publish: the show the operator will publish an unpublished episode onto.
  const [publishShowByEpisode, setPublishShowByEpisode] = useState<Record<string, string>>({});
  // R2 SP-1 — the publish metadata the route always accepted and no UI sent:
  // the PUBLIC description, and the explicit override ('' = inherit the show).
  const [publishDescByEpisode, setPublishDescByEpisode] = useState<Record<string, string>>({});
  const [publishExplicitByEpisode, setPublishExplicitByEpisode] = useState<Record<string, '' | 'yes' | 'no'>>({});

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
    // Embedded in a project: the notebook is fixed — skip its picker fetch. (The
    // org read is the hook's, gated the same way.)
    if (!fixedNotebookId) {
      // R2 SP-3 — a failed notebooks read is NOT "no notebooks": the empty
      // state instructs creating a notebook that may already exist.
      setNotebooksFailed(false);
      setNotebooksUnavailable(false);
      void listNotebooksForPodcasts()
        .then((r) => { setNotebooks(r.notebooks); setNotebooksUnavailable(r.featureUnavailable); })
        .catch(() => setNotebooksFailed(true));
    }
  }, [fixedNotebookId]);

  const loadAll = useCallback(() => {
    if (!orgId) return;
    setSpeakerProfilesFailed(false);
    setEpisodeProfilesFailed(false);
    setEpisodesFailed(false);
    void listSpeakerProfiles(orgId).then(setSpeakerProfiles).catch(() => setSpeakerProfilesFailed(true));
    void listEpisodeProfiles(orgId).then(setEpisodeProfiles).catch(() => setEpisodeProfilesFailed(true));
    // SP-9 — capability rides the episodes read (same predicate as the writes).
    void listEpisodesWithCapability(orgId)
      .then((r) => { setEpisodes(r.episodes); setCanWrite(r.canWrite); })
      .catch(() => setEpisodesFailed(true));
    setShowsFailed(false);
    void listShows(orgId).then(setShows).catch(() => { setShowsFailed(true); setShows([]); });
  }, [orgId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  /**
   * PODU-3 / PODU-4 (ADR 0603 §5) — the generation poll, ported from the ADR 0602
   * notebooks poller. The original was `NBU-6`'s exact shape and then some:
   * `.catch(() => undefined)` swallowed EVERY failure, there was no bound at all
   * (it ran until the tab closed), the `runId` sat on the type and was rendered
   * NOWHERE, and an `awaiting-approval` episode polled forever with Delete as its
   * only action.
   *
   * The corrected posture (ADR 0602 R4 — its FIRST cut re-committed the inversion
   * it existed to remove, so this ports the second):
   *   - the poll is BOUNDED and the bound STATES ITSELF in seconds;
   *   - the give-up is not a failure claim: "we stopped checking after about N
   *     seconds … this is not a report that it failed";
   *   - it clears ONLY ON EVIDENCE — evidence being that the exact episode IDS it
   *     was waiting on reached a terminal status. A COUNT would let an unrelated
   *     new episode clear a card waiting on a different one (`M2`);
   *   - a recheck that ERRORS is never rendered as "still nothing new" (`M1`) —
   *     that is a claim about the server made from a request that never reached
   *     it, in the one card whose purpose is not to make that claim;
   *   - the card SUPPRESSES nothing here (the episode list is non-empty by
   *     construction when a poll is running) but it does carry the one artifact
   *     that can say WHY: a `/runs/:id` link per pending episode (`H4`);
   *   - feedback rides the RENDERED CARD and never a toast — `DS-NB-1` is open:
   *     a repeated identical error toast coalesces without inserting a DOM node
   *     and errors are excluded from `announce()`, so a second identical failure
   *     would be silent to a screen reader. `StateCard announce` is POLITE and
   *     delegates to the app-shell `GlobalLiveRegion`, mounted long before any
   *     message — dodging "a live region mounted WITH content announces nothing".
   */
  const [pollGaveUp, setPollGaveUp] = useState<{ episodeIds: readonly string[]; rechecks: number; lastRecheckFailed: boolean } | null>(null);
  const [recheckBusy, setRecheckBusy] = useState(false);

  const pendingIdsOf = useCallback((list: readonly PodcastEpisode[] | null): readonly string[] =>
    (list ?? []).filter((e) => e.status === 'queued' || e.status === 'running' || e.status === 'awaiting-approval').map((e) => e.id),
  []);

  // `M3a` — the give-up clears the moment its subject SETTLES, by any route (a
  // retry, a manual reload, another poll). The predicate is pure, so it is simply
  // re-evaluated against whatever is currently in hand.
  useEffect(() => {
    if (!pollGaveUp || !episodes) return;
    const stillPending = new Set(pendingIdsOf(episodes));
    if (pollGaveUp.episodeIds.some((id) => stillPending.has(id))) return;
    setPollGaveUp(null);
  }, [episodes, pollGaveUp, pendingIdsOf]);

  /**
   * `C1` (ADR 0603 §5, R1) — the COHORT KEY, and why the poll depends on it rather
   * than on `episodes`.
   *
   * The first cut of this effect listed `episodes` in its dependency array while
   * holding `attempts` as an effect-LOCAL. Every SUCCESSFUL tick calls
   * `setEpisodes` with a freshly-parsed array — a new reference — so the deps
   * changed, cleanup cleared the interval, and the effect re-ran with
   * `attempts = 0`. **The counter could never exceed 1 while the server answered**,
   * so the give-up card was reachable only after ~60 CONSECUTIVE READ FAILURES —
   * never for the stalled / `awaiting-approval` generation the bound exists for.
   *
   * The witness could not see it: `mockResolvedValue([EPISODE()])` hands back the
   * SAME array instance every call, so `Object.is` held, React bailed out of the
   * re-render, the interval survived and the counter accumulated. A test can be
   * entirely non-vacuous and still measure a condition production never has — the
   * mocks now build a fresh object per call (`mockImplementation`), which is what
   * a real `fetch`+`json()` does.
   *
   * The dependency is therefore the *identity of the cohort*, not the identity of
   * the array: a sorted join of the pending ids. A tick that changes only the
   * `updatedAt` of an episode we are already waiting on does not restart the
   * budget; a genuinely NEW pending cohort does, deliberately (it has not been
   * waited on yet). Nothing inside the tick reads `episodes` — it calls a setter —
   * so dropping it from the deps closes over nothing stale.
   */
  const pendingKey = pendingIdsOf(episodes).slice().sort().join('|');

  // ADR 1115 D10 (`PODUX93-7`) — a generation that finishes while the person waits is
  // SAID, not only re-coloured: compare each episode's status with the last one seen,
  // and announce a pending → done / failed transition. The first read seeds the map
  // (nothing is announced for episodes that were already settled on arrival).
  const lastStatus = useRef<Map<string, EpisodeStatus> | null>(null);
  useEffect(() => {
    if (!episodes) return;
    // The embedded panel speaks only for its own project's episodes (`PODUX93R-9`).
    const mine = embedded ? episodes.filter((e) => e.notebookId === fixedNotebookId) : episodes;
    const prev = lastStatus.current;
    const next = new Map(mine.map((e) => [e.id, e.status] as const));
    lastStatus.current = next;
    if (!prev) return;
    for (const e of mine) {
      const was = prev.get(e.id);
      if (!was || was === e.status || (was !== 'queued' && was !== 'running' && was !== 'awaiting-approval')) continue;
      if (e.status === 'done') announce(t('episodeReadyAnnounce', { title: e.title }));
      else if (e.status === 'failed') announce(t('episodeFailedAnnounce', { title: e.title }));
    }
  }, [episodes, embedded, fixedNotebookId, t]);

  useEffect(() => {
    if (!pendingKey || !orgId) return;
    if (pollGaveUp) return; // already given up on this cohort; "Check again" is the way back
    const pending = pendingKey.split('|');
    let attempts = 0;
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      attempts += 1;
      void listEpisodes(orgId)
        .then(setEpisodes)
        // A transient read failure is NOT a stall — keep polling to the cap. It is
        // also not nothing: the cap is what turns repeated failure into a stated
        // give-up instead of a spinner that never resolves.
        .catch(() => undefined);
      if (attempts >= POLL_MAX_ATTEMPTS) {
        window.clearInterval(id);
        setPollGaveUp({ episodeIds: pending, rechecks: 0, lastRecheckFailed: false });
      }
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [pendingKey, orgId, pollGaveUp]);

  /** "Check again" — the SAME read, on demand. Three outcomes, three branches. */
  const recheckPoll = useCallback(async (): Promise<void> => {
    if (!orgId || !pollGaveUp) return;
    setRecheckBusy(true);
    try {
      const fresh = await listEpisodes(orgId);
      setEpisodes(fresh);
      const stillPending = new Set(pendingIdsOf(fresh));
      if (!pollGaveUp.episodeIds.some((eid) => stillPending.has(eid))) {
        setPollGaveUp(null);
        // An episode that LANDED is announced by name by the transition effect; saying
        // "finished" as well would queue two messages for one event (`PODUX93R-3`).
        // Only a cohort that settled by vanishing (deleted) gets the generic line.
        // Over the same episodes the transition effect speaks for (`PODUX93R-14`).
        const spoken = embedded ? fresh.filter((e) => e.notebookId === fixedNotebookId) : fresh;
        const landedByName = spoken.some((e) => pollGaveUp.episodeIds.includes(e.id) && (e.status === 'done' || e.status === 'failed'));
        if (!landedByName) announce(t('pollRecheckLanded'));
        return;
      }
      // Still working. Keep the card — but CHANGE it, so the click is observable.
      const nextCount = pollGaveUp.rechecks + 1;
      setPollGaveUp({ ...pollGaveUp, rechecks: nextCount, lastRecheckFailed: false });
      announce(t('pollRecheckedNothing', { count: nextCount }));
    } catch {
      // We could not look. The count does NOT advance — it counts OBSERVATIONS,
      // and this was not one.
      setPollGaveUp({ ...pollGaveUp, lastRecheckFailed: true });
      announce(t('pollRecheckFailed'));
    } finally {
      setRecheckBusy(false);
    }
  }, [orgId, pollGaveUp, pendingIdsOf, embedded, fixedNotebookId, t]);

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
      toast.error(errorText(err, 'createFailed'));
    } finally { setSpBusy(false); }
  }, [orgId, spName, spProvider, spSpeakers, loadAll, t, errorText]);

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
      toast.error(errorText(err, 'createFailed'));
    } finally { setEpBusy(false); }
  }, [orgId, epName, epSpeakerProfileId, epSegments, epBriefing, loadAll, t, errorText]);

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
      toast.error(errorText(err, 'generateFailed'));
    } finally { setGenBusy(false); }
  }, [orgId, genNotebookId, genProfileId, genTitle, genBriefing, loadAll, t, errorText]);

  /** Retry a FAILED episode, or regenerate a DONE one. ADR 1115 D10 (`PODUX93-4`) — a
   *  regeneration replaces the episode's audio and transcript, so it asks first; it
   *  used to be an unconfirmed "Retry" on every Ready episode. */
  const onRetry = useCallback(async (episode: PodcastEpisode) => {
    if (episode.status === 'done' && !(await confirm({ title: t('confirmRegenerateTitle', { title: episode.title }), body: t('confirmRegenerateBody'), confirmLabel: t('regenerate'), danger: true }))) return;
    try { await retryEpisode(episode.id); toast.success(t('episodeEnqueued')); loadAll(); }
    catch (err) { toast.error(errorText(err, 'generateFailed')); }
  }, [loadAll, t, errorText]);

  const onDeleteSpeakerProfile = useCallback(async (id: string) => {
    if (!(await confirm({ title: t('confirmDeleteSpeakerProfile'), danger: true }))) return;
    try { await deleteSpeakerProfile(id); loadAll(); }
    catch (err) { toast.error(errorText(err, 'deleteFailed')); }
  }, [loadAll, t, errorText]);

  const onDeleteEpisodeProfile = useCallback(async (id: string) => {
    if (!(await confirm({ title: t('confirmDeleteEpisodeProfile'), danger: true }))) return;
    try { await deleteEpisodeProfile(id); loadAll(); }
    catch (err) { toast.error(errorText(err, 'deleteFailed')); }
  }, [loadAll, t, errorText]);

  const onDeleteEpisode = useCallback(async (id: string) => {
    if (!(await confirm({ title: t('confirmDeleteEpisode'), danger: true }))) return;
    try { await deleteEpisode(id); loadAll(); }
    catch (err) { toast.error(errorText(err, 'deleteFailed')); }
  }, [loadAll, t, errorText]);

  const onPublishEpisode = useCallback(async (episode: PodcastEpisode, showId: string) => {
    if (!showId) { toast.error(t('selectShowFirst')); return; }
    // Review F3 — the controls PRE-FILL from the stored overrides (below), so
    // the form always tells the truth; here, emptying a field on an episode
    // that HAS a stored override sends an explicit null CLEAR — without it, an
    // unpublish→republish silently kept the old override under an "Inherit" label.
    const desc = (publishDescByEpisode[episode.id] ?? episode.descriptionOverride ?? '').trim();
    const explicit = publishExplicitByEpisode[episode.id]
      ?? (episode.explicitOverride === undefined ? '' : episode.explicitOverride ? 'yes' : 'no');
    try {
      await setEpisodePublished(episode.id, true, showId, {
        ...(desc ? { descriptionOverride: desc } : episode.descriptionOverride !== undefined ? { descriptionOverride: null } : {}),
        ...(explicit ? { explicitOverride: explicit === 'yes' } : episode.explicitOverride !== undefined ? { explicitOverride: null } : {}),
      });
      toast.success(t('episodePublished'));
      loadAll();
    } catch (err) { toast.error(errorText(err, 'publishFailed')); }
  }, [loadAll, t, errorText, publishDescByEpisode, publishExplicitByEpisode]);

  /** ADR 1115 D10 (`PODUX93-5`) — taking an episode out of the public feed asks first. */
  const onUnpublishEpisode = useCallback(async (episode: PodcastEpisode) => {
    if (!(await confirm({ title: t('confirmUnpublishEpisodeTitle', { title: episode.title }), body: t('confirmUnpublishEpisodeBody'), confirmLabel: t('unpublish'), danger: true }))) return;
    try { await setEpisodePublished(episode.id, false); toast.success(t('episodeUnpublished')); loadAll(); }
    catch (err) { toast.error(errorText(err, 'publishFailed')); }
  }, [loadAll, t, errorText]);

  const setSpeakerField = (i: number, field: keyof Speaker, value: string) =>
    setSpSpeakers((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));

  // Embedded: scope the episode list to this project (notebookId === the project id).
  const scopedEpisodes = embedded && episodes ? episodes.filter((e) => e.notebookId === fixedNotebookId) : episodes;
  // §4.5 collection search (DESIGN.md rule 13) — title match over the scoped list.
  const [episodeQuery, setEpisodeQuery] = useState('');
  const visibleEpisodes = scopedEpisodes === null ? null
    : scopedEpisodes.filter((e) => !episodeQuery.trim() || e.title.toLowerCase().includes(episodeQuery.trim().toLowerCase()));

  return (
    <section className="u-grid u-gap-4">
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s. The picker sits INSIDE because it was half the
          defect: labelled "Workspace" three lines from a card claiming "No
          workspace yet", over `listOrgs`. Every panel below is org-scoped
          (`loadAll` returns early without an `orgId`), so with no organization
          they would all render their own "nothing yet" instructions over reads
          that never started. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<MicIcon size={20} />}>
      {embedded ? null : (
        <SelectField label={t('ui:orgPickerLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
          {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}

      {/* SP-9 — one disclosure for the whole studio; every action below hides
          on the capability the episodes read reported (same predicate the
          server's writes enforce; the 403 stays the authority). */}
      {canWrite === false ? <Notice variant="info">{t('readOnlyMember')}</Notice> : null}

      {/* Speaker profiles (the cast) */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><MicIcon size={16} /> {t('speakerProfilesTitle')}</h2>
        {speakerProfilesFailed ? (
          <StateCard
            announce
            icon={<MicIcon size={20} />}
            title={t('profilesReadFailedTitle')}
            body={t('readFailedBody')}
            action={<Button variant="secondary" onClick={loadAll}>{t('common:retry')}</Button>}
          />
        ) : speakerProfiles === null ? <Skeleton height={40} /> : speakerProfiles.length === 0 ? (
          <StateCard icon={<MicIcon size={20} />} title={t('speakerProfilesTitle')} body={writable ? t('noSpeakerProfiles') : t('noSpeakerProfilesReadOnly')} />
        ) : (
          <ul className="nb-list">
            {speakerProfiles.map((p) => (
              <li key={p.id} className="nb-list__item">
                <span><strong>{p.name}</strong> · {p.speakers.map((s) => s.name).join(', ')} <span className="chip chip--muted">{p.provider}</span></span>
                {writable ? <Button variant="quiet" onClick={() => void onDeleteSpeakerProfile(p.id)} aria-label={t('common:delete')}><TrashIcon size={14} /></Button> : null}
              </li>
            ))}
          </ul>
        )}
        {writable ? <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitSpeakerProfile(); }}>
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
                <Button variant="quiet" onClick={() => setSpSpeakers((prev) => prev.filter((_, idx) => idx !== i))}><TrashIcon size={14} /> {t('removeSpeaker')}</Button>
              ) : null}
            </div>
          ))}
          <div className="action-bar">
            {spSpeakers.length < MAX_SPEAKERS ? (
              <Button variant="quiet" onClick={() => setSpSpeakers((prev) => [...prev, emptySpeaker()])}><PlusIcon size={14} /> {t('addSpeaker')}</Button>
            ) : null}
            <Button variant="primary" type="submit" disabled={spBusy || !spName.trim() || spSpeakers.some((s) => !s.name.trim() || !s.voiceId.trim())}>
              <PlusIcon size={14} /> {t('createSpeakerProfile')}
            </Button>
          </div>
        </form> : null}
      </div>

      {/* Episode (show-format) profiles */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><SparklesIcon size={16} /> {t('episodeProfilesTitle')}</h2>
        {episodeProfilesFailed ? (
          <StateCard
            announce
            icon={<SparklesIcon size={20} />}
            title={t('profilesReadFailedTitle')}
            body={t('readFailedBody')}
            action={<Button variant="secondary" onClick={loadAll}>{t('common:retry')}</Button>}
          />
        ) : episodeProfiles === null ? <Skeleton height={40} /> : episodeProfiles.length === 0 ? (
          <StateCard icon={<SparklesIcon size={20} />} title={t('episodeProfilesTitle')} body={writable ? t('noEpisodeProfiles') : t('noEpisodeProfilesReadOnly')} />
        ) : (
          <ul className="nb-list">
            {episodeProfiles.map((p) => (
              <li key={p.id} className="nb-list__item">
                <span><strong>{p.name}</strong> · {t('segmentsN', { count: p.segmentCount })}</span>
                {writable ? <Button variant="quiet" onClick={() => void onDeleteEpisodeProfile(p.id)} aria-label={t('common:delete')}><TrashIcon size={14} /></Button> : null}
              </li>
            ))}
          </ul>
        )}
        {writable ? <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitEpisodeProfile(); }}>
          <TextField label={t('episodeProfileNameLabel')} value={epName} onChange={(e) => setEpName(e.target.value)} placeholder={t('episodeProfileNamePlaceholder')} />
          <SelectField label={t('castLabel')} value={epSpeakerProfileId} onChange={(e) => setEpSpeakerProfileId(e.target.value)}>
            <option value="">{t('selectCast')}</option>
            {(speakerProfiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
          <TextField label={t('segmentCountLabel')} type="number" min={3} max={20} value={epSegments} onChange={(e) => setEpSegments(e.target.value)} />
          <TextareaField label={t('briefingLabel')} value={epBriefing} onChange={(e) => setEpBriefing(e.target.value)} rows={2} placeholder={t('briefingPlaceholder')} />
          <Button variant="primary" type="submit" disabled={epBusy || !epName.trim() || !epSpeakerProfileId}><PlusIcon size={14} /> {t('createEpisodeProfile')}</Button>
        </form> : null}
      </div>

      {/* Generate */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <h2 className="nb-panel__title"><PlayIcon size={16} /> {t('generateTitle')}</h2>
        {/* R2 SP-3 — "create a research notebook first" is an INSTRUCTION; it
            must never render over a failed read (the notebook may exist). */}
        {!embedded && notebooksFailed ? (
          <StateCard
            announce
            icon={<PlayIcon size={20} />}
            title={t('notebooksReadFailedTitle')}
            body={t('readFailedBody')}
            action={<Button variant="secondary" onClick={() => { setNotebooksFailed(false); setNotebooksUnavailable(false); void listNotebooksForPodcasts().then((r) => { setNotebooks(r.notebooks); setNotebooksUnavailable(r.featureUnavailable); }).catch(() => setNotebooksFailed(true)); }}>{t('common:retry')}</Button>}
          />
        ) : null}
        {/* `PODU-8` — three states, three cards. The middle one used to wear the
            bottom one's copy. */}
        {/* ADR 1115 D4 — the embedded panel too: with notebooks off the door refuses
            every generation (409 `notebooks_disabled`), so the form is not offered. */}
        {!notebooksFailed && notebooksOff ? (
          <StateCard icon={<PlayIcon size={20} />} title={t('notebooksOffTitle')} body={t('notebooksOffBody')} />
        ) : null}
        {!embedded && !notebooksFailed && !notebooksOff && notebooks.length === 0 ? (
          <StateCard icon={<PlayIcon size={20} />} title={t('generateTitle')} body={t('noNotebooks')} />
        ) : null}
        {writable && !notebooksOff ? <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitGenerate(); }}>
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
          <Button variant="primary" type="submit" disabled={genBusy || !genNotebookId || !genProfileId}><SparklesIcon size={14} /> {t('generate')}</Button>
        </form> : null}
      </div>

      {/* Shows & distribution (ADR 0390) */}
      {orgId ? <ShowsManager orgId={orgId} /> : null}

      {/* Episodes */}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
          <h2 className="nb-panel__title"><MicIcon size={16} /> {t('episodesTitle')}</h2>
          {(scopedEpisodes?.length ?? 0) > 3 ? (
            <input
              type="search"
              className="ui-input filterbar-search u-ml-auto"
              placeholder={t('episodeFilterPlaceholder')}
              aria-label={t('episodeFilterAria')}
              value={episodeQuery}
              onChange={(e) => setEpisodeQuery(e.target.value)}
            />
          ) : null}
        </div>
        {/* PODU-3 — the poll's give-up, stated in the panel that owns the episodes,
            as a `StateCard announce` matching the failed-read sibling directly
            above rather than replacing it. It is NOT a failure claim. */}
        {pollGaveUp ? (
          <StateCard
            announce
            icon={<MicIcon size={20} />}
            title={t('pollGaveUpTitle')}
            body={(
              <>
                {t('pollGaveUpBody', { seconds: POLL_BUDGET_SECONDS, count: pollGaveUp.episodeIds.length })}
                {/* `M1` — two different things a recheck can report, said
                    differently. "still working" is a claim about the server;
                    "we couldn't check" is a claim about the request. The count
                    belongs only to the first, because it counts OBSERVATIONS. */}
                {pollGaveUp.rechecks > 0 ? <> {t('pollRecheckedNothing', { count: pollGaveUp.rechecks })}</> : null}
                {pollGaveUp.lastRecheckFailed ? <> {t('pollRecheckFailed')}</> : null}
              </>
            )}
            action={<Button variant="secondary" loading={recheckBusy} onClick={() => void recheckPoll()}>{t('checkAgain')}</Button>}
          />
        ) : null}
        {episodesFailed ? (
          <StateCard
            announce
            icon={<MicIcon size={20} />}
            title={t('episodesReadFailedTitle')}
            body={t('readFailedBody')}
            action={<Button variant="secondary" onClick={loadAll}>{t('common:retry')}</Button>}
          />
        ) : visibleEpisodes === null ? <Skeleton height={60} /> : visibleEpisodes.length === 0 ? (
          episodeQuery ? (
            <StateCard
              icon={<MicIcon size={20} />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => setEpisodeQuery('')}>{t('clearSearch')}</Button>}
            />
          ) : (
            <StateCard icon={<MicIcon size={20} />} title={t('noEpisodesTitle')} body={writable ? t('noEpisodesBody') : t('noEpisodesBodyReadOnly')} />
          )
        ) : (
          <ul className="nb-list">
            {visibleEpisodes.map((e) => (
              <li key={e.id} className="nb-list__item">
                <div className="action-bar u-justify-between">
                  <span><strong>{e.title}</strong> <span className={statusChip(e.status)}>{t(`status_${e.status}` as 'status_done')}</span></span>
                  <span className="u-text-sm muted">{formatRelativeTime(e.createdAt)}</span>
                </div>
                {e.status === 'done' && (e.audioMediaRef || e.clips.length > 0) ? <EpisodePlayer episode={e} /> : null}
                {/* ADR 1115 D10 (`PODUX93-2`) — what failed, in the reader's language, from
                    the run's typed code; the run's own English stays one click away. */}
                {/* Plain text, deliberately NOT a live region: a page with N failed rows
                    must not mount N alerts, and the running → failed transition is
                    already announced once (UX regrade `PODUX93R-2`). */}
                {e.status === 'failed' ? (
                  <div className="u-grid u-gap-1">
                    <p className="u-text-sm u-text-danger">{e.errorCode && FAILURE_CODES.has(e.errorCode) ? t(`failure_${e.errorCode}` as 'failure_podcast_content_empty') : t('episodeFailed')}</p>
                    {e.error ? (
                      <details className="u-text-sm">
                        <summary>{t('failureDetails')}</summary>
                        <p className="muted">{e.error}</p>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {/* PODU-4 (ADR 0603 §5) — `runId` was on the type and rendered
                    NOWHERE, so the one artifact that can say what a run is doing
                    (or why it stopped) was unreachable from the surface that owns
                    it. Shown for every non-`done` episode: an `awaiting-approval`
                    episode in particular had Delete as its ONLY action, and the
                    approval lives on the run page. */}
                {e.runId && e.status !== 'done' ? (
                  <Link to={`/runs/${encodeURIComponent(e.runId)}`} className="u-text-sm">{t('viewRun')}</Link>
                ) : null}
                {/* Distribution (ADR 0390): publish a finished episode onto a show. */}
                {/* ADR 1115 D5/D10 (`PODUX93-5`) — a published chip on a DRAFT show is a
                    warning (nobody can hear it yet), and only an episode with audio can
                    be published (the door answers 409 `episode_not_ready` otherwise). */}
                {e.status === 'done' ? (
                  e.published ? (
                    <div className="action-bar">
                      {(() => {
                        // With the shows read failed, the show's state is unknown: no
                        // colour claim either way (UX regrade `PODUX93R-8`).
                        if (showsFailed) return <span className="chip chip--muted">{t('episodePublishedChip')}</span>;
                        const bound = shows.find((sh) => sh.id === e.showId);
                        return bound && !bound.published
                          ? <span className="chip chip--warning">{t('episodePublishedDraftShowChip')}</span>
                          : <span className="chip chip--success">{t('episodePublishedChip')}</span>;
                      })()}
                      {writable ? <Button variant="quiet" size="sm" onClick={() => void onUnpublishEpisode(e)}>{t('unpublish')}</Button> : null}
                    </div>
                  ) : !writable ? null : !e.audioMediaRef ? (
                    <p className="u-text-sm muted">{t('publishNeedsAudio')}</p>
                  ) : showsFailed ? (
                    <p className="u-text-sm muted">{t('showsFailed')}</p>
                  ) : shows.length === 0 ? (
                    <p className="u-text-sm muted">{t('createShowToPublish')}</p>
                  ) : (
                    <div className="u-grid u-gap-2">
                      <div className="action-bar u-flex-wrap">
                        <SelectField
                          label={t('publishToShowLabel')}
                          value={publishShowByEpisode[e.id] ?? e.showId ?? ''}
                          onChange={(ev) => setPublishShowByEpisode((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                        >
                          <option value="">{t('selectShow')}</option>
                          {shows.map((s) => <option key={s.id} value={s.id}>{s.title}{s.published ? '' : ` (${t('showDraft')})`}</option>)}
                        </SelectField>
                        {/* R2 SP-1 — the explicit override the route always accepted;
                            '' inherits the show's own flag (the RSS semantics). */}
                        <SelectField
                          label={t('publishExplicitLabel')}
                          value={publishExplicitByEpisode[e.id] ?? (e.explicitOverride === undefined ? '' : e.explicitOverride ? 'yes' : 'no')}
                          onChange={(ev) => setPublishExplicitByEpisode((prev) => ({ ...prev, [e.id]: ev.target.value as '' | 'yes' | 'no' }))}
                        >
                          <option value="">{t('publishExplicitInherit')}</option>
                          <option value="yes">{t('explicitYes')}</option>
                          <option value="no">{t('explicitNo')}</option>
                        </SelectField>
                        <Button
                          variant="quiet" size="sm"
                          disabled={!(publishShowByEpisode[e.id] ?? e.showId)}
                          onClick={() => void onPublishEpisode(e, publishShowByEpisode[e.id] ?? e.showId ?? '')}
                        >
                          <CheckIcon size={14} /> {t('publish')}
                        </Button>
                      </div>
                      <TextareaField
                        label={t('publishDescriptionLabel')}
                        help={t('publishDescriptionHelp')}
                        rows={2}
                        value={publishDescByEpisode[e.id] ?? e.descriptionOverride ?? ''}
                        onChange={(ev) => setPublishDescByEpisode((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                      />
                    </div>
                  )
                ) : null}
                {/* ADR 1115 D5/D10 (`PODUX93-4`) — Retry for a failure; Regenerate (asks
                    first) for a done episode; neither for a published one, whose public
                    audio a regeneration would replace (the door answers 409). */}
                {writable ? <div className="action-bar">
                  {(e.status === 'failed' || e.status === 'done') && e.notebookMissing ? (
                    <span className="u-text-sm muted">{t('notebookGoneNoRegenerate')}</span>
                  ) : e.status === 'failed' ? (
                    <Button variant="quiet" onClick={() => void onRetry(e)}><RotateCwIcon size={14} /> {t('retry')}</Button>
                  ) : e.status === 'done' && !e.published ? (
                    <Button variant="quiet" onClick={() => void onRetry(e)}><RotateCwIcon size={14} /> {t('regenerate')}</Button>
                  ) : e.status === 'done' ? (
                    <span className="u-text-sm muted">{t('unpublishToRegenerate')}</span>
                  ) : null}
                  <Button variant="quiet" onClick={() => void onDeleteEpisode(e.id)}><TrashIcon size={14} /> {t('common:delete')}</Button>
                </div> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      </OrgSelectionState>
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
