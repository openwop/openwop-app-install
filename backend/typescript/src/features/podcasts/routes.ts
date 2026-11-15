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
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireString, optionalString, tenantOf, toggleSubjectOf } from '../featureRoute.js';
import { type Scope } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getProject } from '../projects/projectsService.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { PODCASTS_GENERATE_ID } from './generateWorkflow.js';
import { episodeAccess, filterReadableEpisodes, generateTargetAccess, orgAllows } from './podcastsAccess.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { estimateAudioDurationSeconds } from './audioDuration.js';
import {
  createSpeakerProfile, listSpeakerProfiles, getSpeakerProfile, deleteSpeakerProfile,
  createEpisodeProfile, listEpisodeProfiles, getEpisodeProfile, deleteEpisodeProfile,
  createEpisode, getEpisode, listEpisodes, deleteEpisode, projectStatus,
  claimEpisodeGeneration, releaseEpisodeGeneration, isLiveRunStatus,
  createShow, listShows, getShow, updateShow, setShowPublished, deleteShow,
  setEpisodePublish,
  type PodcastEpisode,
} from './podcastsService.js';
import { registerPublicPodcastRoutes } from './publicRoutes.js';

const log = createLogger('features.podcasts.routes');

const TOGGLE = { toggleId: 'podcasts', label: 'Podcasts' };

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Boolean: does the caller hold `scope` IN `orgId`? (ADR 1115 D1 — `orgAllows`, the
 *  one org predicate every podcasts lane uses.) */
async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  return orgAllows(tenantOf(req), orgId, actingUserOf(req), scope);
}

/** Require `scope` in `orgId` (403 when held read but not write; the caller already
 *  passed the read gate before reaching here). */
async function requireOrgScope(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/**
 * ADR 1115 D1 — resolve an episode for an `:id` door through THE episode rule
 * (`episodeAccess`): uniform 404 when it is missing, in an org the caller cannot read,
 * or bound to a private notebook they are not a member of (CPU-2); 403 when a write was
 * needed and they lack `workspace:write`.
 *
 * `PODC93-4` — the read doors already checked the notebook; retry, publish, unpublish
 * and delete did not, so an org writer who was not a member of a private notebook could
 * publish its episode to the public web. The old reason for leaving them out (an orphan
 * lockout) no longer applies: an orphan's notebook check answers `true`.
 */
async function requireEpisode(req: Request, need: 'read' | 'write'): Promise<PodcastEpisode> {
  const episode = await getEpisode(tenantOf(req), req.params.id);
  const access = episode ? await episodeAccess(tenantOf(req), episode, actingUserOf(req), need) : 'hidden';
  if (!episode || access === 'hidden') throw new OpenwopError('not_found', 'Episode not found.', 404, { id: req.params.id });
  if (access === 'forbidden') {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write', orgId: episode.orgId });
  }
  return episode;
}

/**
 * ADR 1115 D1/D4 — refuse a generation the run could only fail: the target (org write,
 * a readable project in this org, a provisioned notebook) through `generateTargetAccess`,
 * and the `notebooks` toggle (a podcasts run grounds on a notebook and fails typed
 * without one, D4; `dependsOn` is deliberately NOT declared — it is a disable-lock).
 */
async function requireGenerateTarget(req: Request, orgId: string, notebookId: string, opts: { existingEpisode?: boolean } = {}): Promise<void> {
  const target = await generateTargetAccess(tenantOf(req), orgId, notebookId, actingUserOf(req));
  if ('refused' in target) {
    if (target.refused === 'forbidden') {
      throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write', orgId });
    }
    // On a RETRY the caller already passed `episodeAccess` (they can read the episode,
    // so its notebook is readable or gone), so `hidden` here can only mean the notebook
    // was deleted: say so (409), or the Studio's "it may have been deleted, refresh"
    // loops forever on a button that cannot work (UX regrade `PODUX93R-1`).
    if (target.refused === 'hidden' && opts.existingEpisode) {
      throw new OpenwopError('conflict', "This episode's notebook was deleted, so the episode cannot be generated again.", 409, { reason: 'notebook_unavailable', notebookId });
    }
    if (target.refused === 'hidden') throw new OpenwopError('not_found', 'Notebook not found.', 404, { notebookId });
    throw new OpenwopError('conflict', 'This project has no sources yet. Add a source, then generate the episode.', 409, { reason: 'notebook_has_no_sources', notebookId });
  }
  // The access resolver (toggle AND plan), the predicate the `produce` tool's
  // `resolveFeatureToggle` also answers from (`PODCD93-6`).
  const notebooks = await resolveOne('notebooks', toggleSubjectOf(req));
  if (!notebooks?.enabled) {
    throw new OpenwopError('conflict', 'Podcasts are generated from a research notebook, and notebooks are turned off for this workspace.', 409, { reason: 'notebooks_disabled' });
  }
}

export function registerPodcastsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/podcasts';

  // Resolve the org from a query/body, gate the feature + read scope. For create
  // (no entity yet) the org comes from the body.
  const orgFromQuery = (req: Request): string => requireString(req.query.orgId, 'orgId');

  /** Project an episode + its run-derived status for the wire. ADR 1115 D10
   *  (`PODUX93R-1`) — and `notebookMissing` when its notebook was deleted, so the Studio
   *  does not offer a regeneration the door must refuse. `memo` dedupes a list. */
  async function projectEpisode(episode: PodcastEpisode, memo?: Map<string, Promise<boolean>>): Promise<PodcastEpisode & { status: string; notebookMissing?: true }> {
    let runStatus: string | undefined;
    if (episode.runId) {
      try { runStatus = (await deps.storage.getRun(episode.runId))?.status; } catch { /* run gone — treat as queued */ }
    }
    // Code regrade `PODCD93-13` — a run row purged by retention, with the episode's
    // audio still stored, is a finished episode, not a queued one: otherwise the Studio
    // offers no working action for it (publish/unpublish render only for `done`).
    if (runStatus === undefined && episode.audioMediaRef) runStatus = 'completed';
    let gone = memo?.get(episode.notebookId);
    if (!gone) { gone = getProject(episode.tenantId, episode.notebookId).then((p) => !p); memo?.set(episode.notebookId, gone); }
    return { ...episode, status: projectStatus(runStatus), ...((await gone) ? { notebookMissing: true as const } : {}) };
  }

  /**
   * Start the generation run for an episode, as the caller. Shared by create + retry.
   *
   * ADR 1115 D3 (`PODC93-1`) — the run acts for the person the door just authorized
   * (`metadata.actingUserId`, plus `personalTenant` for the run's BYOK and tenant gates,
   * the notebooks `startAsCaller` shape). This used to start the run with NO actor, so
   * the run read a private notebook as a system run would (nothing), and a paid outline,
   * transcript and per-turn TTS ran on the briefing alone.
   *
   * ADR 1115 D5 (architect finding 2) — the claim is atomic: mint the run id, swap the
   * episode from the row the caller judged (its `runId` not live) to one naming the new
   * id, with the last run's `error`/`errorCode` cleared in the same write, and only then
   * start the run under that id. A lost swap is another retry winning: 409. The clear is
   * strictly before any write the new run can make, because its id is not dispatched
   * until the swap has landed (this replaces the old clear-first ordering comment).
   */
  async function enqueueGeneration(req: Request, episode: PodcastEpisode): Promise<PodcastEpisode> {
    const actingUserId = actingUserOf(req);
    if (!actingUserId) throw new OpenwopError('not_found', 'Episode not found.', 404, { id: episode.id });
    const runId = randomUUID();
    const claimed = await claimEpisodeGeneration(tenantOf(req), episode, runId);
    if (!claimed) {
      throw new OpenwopError('conflict', 'This episode is already being generated.', 409, { reason: 'generation_in_progress', id: episode.id });
    }
    let started: string | null = null;
    try {
      started = await startWorkflowRun(
        { storage: deps.storage, hostSuite: deps.hostSuite },
        {
          tenantId: tenantOf(req),
          workflowId: PODCASTS_GENERATE_ID,
          runId,
          inputs: { episodeId: episode.id },
          metadata: { actingUserId, podcastEpisode: { episodeId: episode.id, notebookId: episode.notebookId } },
          ...(req.personalTenant ? { personalTenant: req.personalTenant } : {}),
        },
      );
    } finally {
      if (!started) await releaseEpisodeGeneration(tenantOf(req), claimed, episode).catch(() => undefined);
    }
    if (!started) {
      throw new OpenwopError('internal_error', 'Podcast generation workflow is unavailable.', 500, { workflowId: PODCASTS_GENERATE_ID });
    }
    return claimed;
  }

  /** ADR 1115 D5 — the episode's run is LIVE (its row exists and is not terminal). An
   *  absent or unreadable row is not live: reading absence as "queued" would lock the
   *  episode forever (architect finding 1). */
  async function liveRunOf(episode: PodcastEpisode): Promise<string | undefined> {
    if (!episode.runId) return undefined;
    let status: string | undefined;
    try { status = (await deps.storage.getRun(episode.runId))?.status; } catch { status = undefined; }
    return isLiveRunStatus(status) ? episode.runId : undefined;
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
      // ADR 1115 D1 — the notebook (a project Subject) MUST be in THIS org, readable by
      // the caller (the cross-org IDOR fix; uniform 404), and a provisioned notebook.
      await requireGenerateTarget(req, orgId, notebookId);
      const title = optionalString(body.title) ?? 'Untitled episode';
      const briefing = optionalString(body.briefing);
      const episode = await createEpisode(tenantOf(req), orgId, {
        notebookId, episodeProfileId, title, ...(briefing ? { briefing } : {}),
      });
      // `PODCD93-5` — a create whose run never starts must not leave an episode that
      // reads "queued" forever (the `produce` tool already deleted it; now the door too).
      const claimed = await enqueueGeneration(req, episode).catch(async (err: unknown) => {
        await deleteEpisode(tenantOf(req), episode.id).catch(() => undefined);
        throw err;
      });
      log.info('podcast_episode_enqueued', { tenantId: tenantOf(req), orgId, id: episode.id, runId: claimed.runId });
      res.status(202).json({ episode: { ...claimed, status: 'queued' } });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episodes`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = orgFromQuery(req);
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      // CPU-2 — an org-reader must not see episodes of a private notebook they are not
      // a member of. ADR 1115 D1: the SAME filter the `list` chat tool and the run lane
      // apply (`filterReadableEpisodes`). Orphaned episodes (notebook deleted) stay listed.
      const visible = await filterReadableEpisodes(tenantOf(req), await listEpisodes(tenantOf(req), orgId), actingUserOf(req));
      const notebookMemo = new Map<string, Promise<boolean>>();
      // SP-9 — same capability report as /shows: ONE org-level resolve from the
      // predicate every write on this surface enforces.
      res.json({
        episodes: await Promise.all(visible.map((e) => projectEpisode(e, notebookMemo))),
        canWrite: await hasOrgScope(req, orgId, 'workspace:write'),
      });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episodes/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await requireEpisode(req, 'read');
      res.json({ episode: await projectEpisode(episode) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/episodes/:id/retry`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await requireEpisode(req, 'write');
      // ADR 1115 D5 (`PODC93-5`) — say no when the state is wrong. A published episode
      // would have its PUBLIC audio replaced by the next mix with no publish step; a
      // live run would race this one on the same row.
      if (episode.published) {
        throw new OpenwopError('conflict', 'This episode is published. Unpublish it first; regenerating would replace the public audio.', 409, { reason: 'episode_published', id: episode.id });
      }
      const live = await liveRunOf(episode);
      if (live) {
        throw new OpenwopError('conflict', 'This episode is already being generated.', 409, { reason: 'generation_in_progress', id: episode.id, runId: live });
      }
      // ADR 1115 D1 — an orphan (notebook deleted) or unprovisioned target is refused
      // here, never enqueued to fail at `select-content`.
      await requireGenerateTarget(req, episode.orgId, episode.notebookId, { existingEpisode: true });
      const claimed = await enqueueGeneration(req, episode);
      log.info('podcast_episode_retried', { tenantId: tenantOf(req), id: episode.id, runId: claimed.runId });
      // PODC-3 — the claim cleared the stored `error`/`errorCode`; the echoed row is the
      // claimed row, so the response never re-asserts the failure it just retried.
      res.status(202).json({ episode: { ...claimed, status: 'queued' } });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/episodes/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await requireEpisode(req, 'write');
      res.json(await deleteEpisode(tenantOf(req), episode.id));
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
      const episode = await requireEpisode(req, 'write');
      // ADR 1115 D5 — publish only what the public can play: the episode has audio, and
      // no run is about to replace it. Readiness is observable state, not "the run said
      // done" (a purged run, or a seeded episode with audio and no run, stays
      // publishable — architect finding 1).
      if (!episode.audioMediaRef || (await liveRunOf(episode))) {
        throw new OpenwopError('conflict', 'This episode has no finished audio to publish yet.', 409, { reason: 'episode_not_ready', id: episode.id });
      }
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
      const episode = await requireEpisode(req, 'write');
      const updated = await setEpisodePublish(tenantOf(req), episode.id, { published: false });
      log.info('podcast_episode_unpublish', { tenantId: tenantOf(req), id: req.params.id });
      res.json({ episode: updated });
    } catch (err) { next(err); }
  });

  // Public distribution surface (unauthed, org→tenant, published-gated).
  registerPublicPodcastRoutes(deps);

  log.info('podcasts routes registered (/host/openwop-app/podcasts/*)');
}
