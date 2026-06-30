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
import {
  createSpeakerProfile, listSpeakerProfiles, getSpeakerProfile, deleteSpeakerProfile,
  createEpisodeProfile, listEpisodeProfiles, getEpisodeProfile, deleteEpisodeProfile,
  createEpisode, getEpisode, listEpisodes, setEpisodeRun, deleteEpisode, projectStatus,
  type PodcastEpisode,
} from './podcastsService.js';

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
      res.status(202).json({ episode: { ...episode, runId, status: 'queued' } });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episodes`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = orgFromQuery(req);
      if (!(await hasOrgScope(req, orgId, 'workspace:read'))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      const list = await listEpisodes(tenantOf(req), orgId);
      res.json({ episodes: await Promise.all(list.map((e) => projectEpisode(e))) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/episodes/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const episode = await getEpisode(tenantOf(req), req.params.id);
      if (!episode || !(await hasOrgScope(req, episode.orgId, 'workspace:read'))) {
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
      res.status(202).json({ episode: { ...episode, runId, status: 'queued' } });
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

  log.info('podcasts routes registered (/v1/host/openwop-app/podcasts/*)');
}
