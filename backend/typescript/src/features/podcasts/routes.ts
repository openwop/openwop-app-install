/**
 * Multi-speaker podcasts routes (ADR 0086) — host-extension, toggle-gated on
 * `podcasts` (backend authority — 404 when off, like every feature package).
 *
 * Org-scoped RBAC (ADR 0006), the priority-matrix precedent: read ops need
 * `workspace:read` in the entity's org, mutate/generate need `workspace:write`
 * there. A caller without read access to an entity's org gets a UNIFORM 404 (no
 * existence leak); a reader attempting a write gets 403. Profiles + episodes never
 * become authenticated principals.
 *
 * Generation is async: `POST /episodes` ENQUEUES an executor run of the
 * `podcasts.generate` workflow and returns the episode (with its runId). The run is
 * the status source of truth — list/get PROJECT status from `storage.getRun`.
 *
 * Surface under /v1/host/openwop-app/podcasts:
 *   POST   /speaker-profiles            {orgId, name, provider?, model?, speakers[1..4]} [write]
 *   GET    /speaker-profiles?orgId=     list                                              [read]
 *   DELETE /speaker-profiles/:id        delete                                            [write]
 *   POST   /episode-profiles            {orgId, name, ...models, segmentCount, speakerProfileId} [write]
 *   GET    /episode-profiles?orgId=     list                                              [read]
 *   DELETE /episode-profiles/:id        delete                                            [write]
 *   POST   /episodes                    {orgId, notebookId, episodeProfileId, title?, briefing?} → enqueue [write]
 *   GET    /episodes?orgId=             list (status projected from the run)              [read]
 *   GET    /episodes/:id                one episode (status projected)                    [read]
 *   POST   /episodes/:id/retry          re-enqueue the generation run                     [write]
 *   DELETE /episodes/:id                delete                                            [write]
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireString, optionalString, tenantOf } from '../featureRoute.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
import { PODCASTS_GENERATE_ID } from './generateWorkflow.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { estimateAudioDurationSeconds } from './audioDuration.js';
import {
  createSpeakerProfile, listSpeakerProfiles, getSpeakerProfile, deleteSpeakerProfile,
  createEpisodeProfile, listEpisodeProfiles, getEpisodeProfile, deleteEpisodeProfile,
  createEpisode, getEpisode, listEpisodes, setEpisodeRun, clearEpisodeError, deleteEpisode, projectStatus,
  createShow, listShows, getShow, updateShow, setShowPublished, deleteShow,
  setEpisodePublish,
  type PodcastEpisode,
} from './podcastsService.js';
import { registerPublicPodcastRoutes } from './publicRoutes.js';

const log = createLogger('features.podcasts.routes');

const TOGGLE = { toggleId: 'podcasts', label: 'Podcasts' };

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Boolean: does the caller hold `scope` IN `orgId`? */
async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}

/** Require `scope` in `orgId` (403 when held read but not write; the caller already
 *  passed the read gate before reaching here). */
async function requireOrgScope(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/** CPU-2 — an episode is bound to a `notebookId` (a project). A `private` notebook is
 *  read-gated to its MEMBERS (`resolveProjectAccess`), so the org-level read scope is
 *  NOT sufficient: an org-reader who is not a notebook member must not read that
 *  notebook's episodes (the same cross-surface leak the projects gate closes).
 *
 *  Two causes of `resolveProjectAccess === 'none'` must be distinguished. A notebook
 *  that EXISTS but is private-and-non-member → DENY (the leak we are closing). A notebook
 *  that is MISSING (deleted — project delete does NOT cascade its episodes, so orphaned
 *  episodes persist) has no visibility/members policy left to enforce → fall through to
 *  the org-read scope the caller already passed. Denying the orphan would 404 + hide it
 *  while DELETE stays org-scoped (retry/delete are deliberately untouched — the
 *  orphan-lockout trap), leaving it unreachable. So orphans stay readable.
 *
 *  Reads only. The optional `memo` dedupes per-`notebookId` resolves across a list (many
 *  episodes share one notebook — no N+1); it caches the in-flight Promise so concurrent
 *  reads of the same notebook resolve once. */
async function notebookReadable(req: Request, notebookId: string, memo?: Map<string, Promise<boolean>>): Promise<boolean> {
  const cached = memo?.get(notebookId);
  if (cached) return cached;
  const p = (async (): Promise<boolean> => {
    const nb = await getProject(tenantOf(req), notebookId);
    if (!nb) return true; // orphan — org-read scope already gated it
    return (await resolveProjectAccess(tenantOf(req), notebookId, actingUserOf(req))) !== 'none';
  })();
  memo?.set(notebookId, p);
  return p;
}

export function registerPodcastsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/podcasts';

  // Resolve the org from a query/body, gate the feature + read scope. For create
  // (no entity yet) the org comes from the body.
  const orgFromQuery = (req: Request): string => requireString(req.query.orgId, 'orgId');

  /** Project an episode + its run-derived status for the wire. */
  async function projectEpisode(episode: PodcastEpisode): Promise<PodcastEpisode & { status: string }> {
    let runStatus: string | undefined;
    if (episode.runId) {
      try { runStatus = (await deps.storage.getRun(episode.runId))?.status; } catch { /* run gone — treat as queued */ }
    }
    return { ...episode, status: projectStatus(runStatus) };
  }

  /** Enqueue the generation run for an episode + stamp its runId. Shared by create + retry. */
  async function enqueueGeneration(req: Request, episode: PodcastEpisode): Promise<string> {
    // PODC-3 (ADR 0603 §3) — the episode's `error` is the LAST run's testimony. A
    // re-run must not carry it forward, or a retry that is merely still running would
    // render the previous failure's message. Explicit, because `recordEpisodeResult`
    // merges and never clears (see `clearEpisodeError`).
    //
    // `L4` (R1) — and it must happen BEFORE the run is created. `startWorkflowRun`
    // dispatches via `setImmediate`, so the new run's nodes can already be executing
    // (and writing their OWN `error` through `failEpisode`) by the time this line is
    // reached. `clearEpisodeError` is an unguarded read-modify-write, so clearing
    // afterwards could erase the new run's freshly-written failure and leave a failed
    // episode reporting nothing at all. Clearing first is strictly ordered against
    // every write the run can make.
    await clearEpisodeError(tenantOf(req), episode.id);
    const runId = await startWorkflowRun(
      { storage: deps.storage, hostSuite: deps.hostSuite },
      {
        tenantId: tenantOf(req),
        workflowId: PODCASTS_GENERATE_ID,
        inputs: { episodeId: episode.id },
        metadata: { podcastEpisode: { episodeId: episode.id, notebookId: episode.notebookId } },
      },
    );
    if (!runId) {
      throw new OpenwopError('internal_error', 'Podcast generation workflow is unavailable.', 500, { workflowId: PODCASTS_GENERATE_ID });
    }
    await setEpisodeRun(tenantOf(req), episode.id, runId);
    return runId;
  }

  // ── SpeakerProfile ──────────────────────────────────────────────────────────

  app.post(`${BASE}/speaker-profiles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:write');
      const profile = await createSpeakerProfile(tenantOf(req), orgId, body);
      log.info('podcast_speaker_profile_created', { tenantId: tenantOf(req), orgId, id: profile.id });
      res.status(201).json({ profile });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/speaker-profiles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = orgFromQuery(req);
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      res.json({ profiles: await listSpeakerProfiles(tenantOf(req), orgId) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/speaker-profiles/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const existing = await getSpeakerProfile(tenantOf(req), req.params.id);
      if (!existing || !(await hasOrgScope(req, existing.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Speaker profile not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, existing.orgId, 'workspace:write');
      res.json(await deleteSpeakerProfile(tenantOf(req), req.params.id));
    } catch (err) { next(err); }
  });

  // ── EpisodeProfile ──────────────────────────────────────────────────────────

  app.post(`${BASE}/episode-profiles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:write');
      const profile = await createEpisodeProfile(tenantOf(req), orgId, body);
      log.info('podcast_episode_profile_created', { tenantId: tenantOf(req), orgId, id: profile.id });
      res.status(201).json({ profile });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episode-profiles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = orgFromQuery(req);
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      res.json({ profiles: await listEpisodeProfiles(tenantOf(req), orgId) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/episode-profiles/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const existing = await getEpisodeProfile(tenantOf(req), req.params.id);
      if (!existing || !(await hasOrgScope(req, existing.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Episode profile not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, existing.orgId, 'workspace:write');
      res.json(await deleteEpisodeProfile(tenantOf(req), req.params.id));
    } catch (err) { next(err); }
  });

  // ── PodcastEpisode (generation) ───────────────────────────────────────────────

  app.post(`${BASE}/episodes`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:write');
      const notebookId = requireString(body.notebookId, 'notebookId');
      const episodeProfileId = requireString(body.episodeProfileId, 'episodeProfileId');
      // The episode profile must resolve in this org (it pins the cast + models).
      const profile = await getEpisodeProfile(tenantOf(req), episodeProfileId);
      if (!profile || profile.orgId !== orgId) {
        throw new OpenwopError('validation_error', 'episodeProfileId does not resolve to a profile in this org.', 400, { episodeProfileId });
      }
      // The notebook (a project Subject) MUST be in THIS org AND readable by the
      // caller (review fix — cross-org IDOR): without this a workspace:write caller
      // in org A could generate a podcast grounded on an org-visible notebook in
      // org B. Uniform 404 on missing / wrong-org / no-access (no existence leak).
      const nbProject = await getProject(tenantOf(req), notebookId);
      const nbAccess = nbProject ? await resolveProjectAccess(tenantOf(req), notebookId, actingUserOf(req)) : 'none';
      if (!nbProject || nbProject.orgId !== orgId || nbAccess === 'none') {
        throw new OpenwopError('not_found', 'Notebook not found.', 404, { notebookId });
      }
      const title = optionalString(body.title) ?? 'Untitled episode';
      const briefing = optionalString(body.briefing);
      const episode = await createEpisode(tenantOf(req), orgId, {
        notebookId, episodeProfileId, title, ...(briefing ? { briefing } : {}),
      });
      const runId = await enqueueGeneration(req, episode);
      log.info('podcast_episode_enqueued', { tenantId: tenantOf(req), orgId, id: episode.id, runId });
      // PODC-3 — `enqueueGeneration` just cleared the stored `error`; the echoed
      // row must agree with it, or the retry response re-asserts the failure it
      // just retried.
      res.status(202).json({ episode: { ...episode, error: undefined, runId, status: 'queued' } });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episodes`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = orgFromQuery(req);
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      const list = await listEpisodes(tenantOf(req), orgId);
      // CPU-2 — an org-reader must not see episodes of a private notebook they are not
      // a member of. Filter the org list by per-notebook read access (memoized — many
      // episodes share a notebook). Orphaned episodes (notebook deleted) stay listed.
      const nbMemo = new Map<string, Promise<boolean>>();
      const visible: typeof list = [];
      for (const e of list) if (await notebookReadable(req, e.notebookId, nbMemo)) visible.push(e);
      // SP-9 — same capability report as /shows: ONE org-level resolve from the
      // predicate every write on this surface enforces.
      res.json({
        episodes: await Promise.all(visible.map((e) => projectEpisode(e))),
        canWrite: await hasOrgScope(req, orgId, 'workspace:write'),
      });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episodes/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await getEpisode(tenantOf(req), req.params.id);
      if (!episode || !(await hasOrgScope(req, episode.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
      }
      // CPU-2 — org read is necessary but not sufficient: a private notebook's episode
      // is readable only by the notebook's members (uniform 404, no existence leak).
      if (!(await notebookReadable(req, episode.notebookId))) {
        throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
      }
      res.json({ episode: await projectEpisode(episode) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/episodes/:id/retry`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await getEpisode(tenantOf(req), req.params.id);
      if (!episode || !(await hasOrgScope(req, episode.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, episode.orgId, 'workspace:write');
      const runId = await enqueueGeneration(req, episode);
      log.info('podcast_episode_retried', { tenantId: tenantOf(req), id: episode.id, runId });
      // PODC-3 — `enqueueGeneration` just cleared the stored `error`; the echoed
      // row must agree with it, or the retry response re-asserts the failure it
      // just retried.
      res.status(202).json({ episode: { ...episode, error: undefined, runId, status: 'queued' } });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/episodes/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await getEpisode(tenantOf(req), req.params.id);
      if (!episode || !(await hasOrgScope(req, episode.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, episode.orgId, 'workspace:write');
      res.json(await deleteEpisode(tenantOf(req), req.params.id));
    } catch (err) { next(err); }
  });

  // ── PodcastShow (channel) CRUD + publish — ADR 0390 ─────────────────────────

  app.post(`${BASE}/shows`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:write');
      const show = await createShow(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', body);
      log.info('podcast_show_created', { tenantId: tenantOf(req), orgId, id: show.id });
      res.status(201).json({ show });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/shows`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = orgFromQuery(req);
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      // SP-9 (round 3) — the read REPORTS capability from the SAME predicate
      // every write route enforces (`hasOrgScope(…,'workspace:write')`), so the
      // UI can stop rendering Publish/Delete/Generate/Edit to read-only members
      // who would only ever collect a 403. One org-level resolve covers the
      // whole list — capability here is org-scoped, not per-row.
      res.json({
        shows: await listShows(tenantOf(req), orgId),
        canWrite: await hasOrgScope(req, orgId, 'workspace:write'),
      });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/shows/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const show = await getShow(tenantOf(req), req.params.id);
      if (!show || !(await hasOrgScope(req, show.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Show not found.', 404, { id: req.params.id });
      }
      res.json({ show });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/shows/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const show = await getShow(tenantOf(req), req.params.id);
      if (!show || !(await hasOrgScope(req, show.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Show not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, show.orgId, 'workspace:write');
      const updated = await updateShow(tenantOf(req), req.params.id, (req.body ?? {}) as Record<string, unknown>);
      res.json({ show: updated });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/shows/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const show = await getShow(tenantOf(req), req.params.id);
      if (!show || !(await hasOrgScope(req, show.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Show not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, show.orgId, 'workspace:write');
      res.json(await deleteShow(tenantOf(req), req.params.id));
    } catch (err) { next(err); }
  });

  // Publish/unpublish a SHOW (the channel-level editorial gate).
  const showPublishRoute = (path: string, published: boolean) =>
    app.post(`${BASE}/shows/:id/${path}`, async (req, res, next) => {
      try {
        await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
        const show = await getShow(tenantOf(req), req.params.id);
        if (!show || !(await hasOrgScope(req, show.orgId, 'workspace:read'))) {
          throw new OpenwopError('not_found', 'Show not found.', 404, { id: req.params.id });
        }
        await requireOrgScope(req, show.orgId, 'workspace:write');
        const updated = await setShowPublished(tenantOf(req), req.params.id, published);
        log.info('podcast_show_publish', { tenantId: tenantOf(req), id: req.params.id, published });
        res.json({ show: updated });
      } catch (err) { next(err); }
    });
  showPublishRoute('publish', true);
  showPublishRoute('unpublish', false);

  // Publish/unpublish an EPISODE (the item-level gate). Publish binds the episode
  // to a show (`showId` in the body or already set) — a submittable channel feed
  // needs the episode on a channel.
  app.post(`${BASE}/episodes/:id/publish`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await getEpisode(tenantOf(req), req.params.id);
      if (!episode || !(await hasOrgScope(req, episode.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, episode.orgId, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const showId = optionalString(body.showId) ?? episode.showId;
      if (!showId) {
        throw new OpenwopError('validation_error', 'showId is required to publish an episode (an episode publishes onto a show).', 400, {});
      }
      // The show must exist in the SAME org (no cross-org binding — uniform 404).
      const show = await getShow(tenantOf(req), showId);
      if (!show || show.orgId !== episode.orgId) {
        throw new OpenwopError('not_found', 'Show not found.', 404, { showId });
      }
      // R2 PR2-1 — measure the episode's duration ONCE at publish (the ingest
      // choke point) so the feed can finally carry `itunes:duration` and the
      // pages can show it. Best-effort: a failed measurement must never block
      // publishing — a missing duration is honest, a blocked publish is not.
      let durationSeconds: number | undefined;
      if (!episode.durationSeconds && episode.audioMediaRef) {
        try {
          const token = episode.audioMediaRef.split('/').pop();
          const asset = token ? await resolveMediaAsset(token) : null;
          // Review F4 — the audioCache exists because this exact decode is the
          // expensive one; its 64MB per-entry cap is the defensible bound. A
          // bigger episode publishes unmeasured (honest) instead of holding an
          // unbounded transient buffer + blocking the event loop.
          const MAX_MEASURE_BYTES = 64 * 1024 * 1024;
          if (asset && asset.tenantId === tenantOf(req) && asset.bytes <= MAX_MEASURE_BYTES) {
            const d = estimateAudioDurationSeconds(Buffer.from(asset.contentBase64, 'base64'), asset.contentType || 'audio/mpeg');
            if (d) durationSeconds = d;
          }
        } catch (e) { log.warn('podcast_duration_measure_failed', { id: req.params.id, err: e instanceof Error ? e.message : String(e) }); }
      }
      const updated = await setEpisodePublish(tenantOf(req), req.params.id, {
        published: true,
        showId,
        ...(durationSeconds ? { durationSeconds } : {}),
        // Review F3 — null is an explicit CLEAR on both override fields.
        ...(body.descriptionOverride === null ? { descriptionOverride: null }
          : optionalString(body.descriptionOverride) !== undefined ? { descriptionOverride: optionalString(body.descriptionOverride)! } : {}),
        ...(body.explicitOverride === null ? { explicitOverride: null }
          : typeof body.explicitOverride === 'boolean' ? { explicitOverride: body.explicitOverride } : {}),
      });
      log.info('podcast_episode_publish', { tenantId: tenantOf(req), id: req.params.id, showId });
      res.json({ episode: updated });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/episodes/:id/unpublish`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await getEpisode(tenantOf(req), req.params.id);
      if (!episode || !(await hasOrgScope(req, episode.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
      }
      await requireOrgScope(req, episode.orgId, 'workspace:write');
      const updated = await setEpisodePublish(tenantOf(req), req.params.id, { published: false });
      log.info('podcast_episode_unpublish', { tenantId: tenantOf(req), id: req.params.id });
      res.json({ episode: updated });
    } catch (err) { next(err); }
  });

  // Public distribution surface (unauthed, org→tenant, published-gated).
  registerPublicPodcastRoutes(deps);

  log.info('podcasts routes registered (/v1/host/openwop-app/podcasts/*)');
}
