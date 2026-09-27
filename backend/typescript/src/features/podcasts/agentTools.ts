/**
 * Podcast Producer chat tools (CFP-1 remediation; ADR 0086 / ADR 0308 D2 seam) —
 * the two tools that let the named Producer GROUND on what a workspace has and
 * IGNITE a real episode-generation run from the ONE chat.
 *
 * The Producer used to allowlist two NOTEBOOK node typeIds
 * (`openwop:feature.notebooks.nodes.{ask,search}`) — ids no conversational-tool
 * provider resolved, so they were silently dropped and the persona could do
 * nothing, while being advertised as the feature's chat-drivability story
 * (CHAT-FIRST-PORT-AUDIT #1, blocker B1: a Producer that cannot produce). These
 * replace them with the feature's OWN tools:
 *
 *  - `openwop:podcasts.list` — READ the org's cast/show-format profiles, shows,
 *    and recent episodes (with run-projected status) to ground a plan.
 *  - `openwop:podcasts.produce` — IGNITE the real `podcasts.generate` run for a
 *    notebook + episode profile, exactly like `POST /episodes` and sharing its
 *    access predicate (`resolveEffectiveAccess` workspace:write in the org + the
 *    cross-org notebook IDOR guard). The non-chat igniter route is unchanged.
 *
 * Read fails EMPTY without an acting human / org access; the action fails TYPED
 * and only starts the run when the caller holds `workspace:write`.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { makeTurn } from '../../host/conversation.js';
import { persistExchangedPair } from '../../host/exchange/persistExchange.js';
import { loadTurns } from '../../host/exchange/loadTurns.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { PODCASTS_GENERATE_ID } from './generateWorkflow.js';
import {
  listEpisodeProfiles, listSpeakerProfiles, listShows, listEpisodes,
  getEpisodeProfile, createEpisode, setEpisodeRun, deleteEpisode, projectStatus,
  type PodcastEpisode,
} from './podcastsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('podcasts.producer-tools');

export const PODCASTS_LIST_TOOL_ID = 'openwop:podcasts.list';
export const PODCASTS_PRODUCE_TOOL_ID = 'openwop:podcasts.produce';

const PRODUCER_AGENT_ID = 'feature.podcasts.agents.producer';

type ToolResult = { content: string; isError?: boolean };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function podcastsEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne('podcasts', { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** Resolve the org for a tool call — explicit `orgId`, else the workspace's sole
 *  org. Returns the org + the narrowed acting user when the caller holds `needed`
 *  there; otherwise a typed error (the app-builder `resolveOrgScope` precedent). */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return toolError('acting_user_required', 'Podcasts can only be produced from a human-initiated turn.');
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(needed)) {
    return toolError('forbidden_scope', `The user does not have ${needed === 'workspace:write' ? 'write' : 'read'} access to that organization.`);
  }
  return { orgId, actingUserId };
}

/** Append a server-side `workflow_run` conversation turn so the chat renders the
 *  dispatched generation run inline (the `kicktodo-creator` precedent). Best-effort. */
async function appendWorkflowRunTurn(
  storage: StartRunDeps['storage'],
  tenantId: string,
  conversationId: string,
  runId: string,
  agentId: string,
): Promise<void> {
  try {
    const meta = await getConversationMeta(tenantId, conversationId);
    const backingRunId = meta?.conversationRunId;
    if (!backingRunId) return;
    const turns = await loadTurns(storage, backingRunId, conversationId);
    const nextIndex = turns.reduce((max, t) => Math.max(max, t.turnIndex), -1) + 1;
    const turn = makeTurn({
      conversationId,
      turnIndex: nextIndex,
      role: 'agent',
      from: agentId,
      content: { kind: 'workflow_run', runId, agentId },
      ts: Date.now(),
      groupId: conversationId,
      agent: { agentId },
      speakerId: agentId,
    });
    await persistExchangedPair({ runId: backingRunId, nodeId: 'podcasts-generate-run', conversationId, entries: [[nextIndex, turn]] });
  } catch (err) {
    log.warn('generate_run_turn_persist_failed', { conversationId, runId, error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerPodcastsAgentTools(deps: StartRunDeps): void {
  // ── READ: ground on the org's cast/format profiles, shows, and episodes. ────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PODCASTS_LIST_TOOL_ID,
      description:
        'List a workspace org\'s podcast building blocks so you can plan an episode: the episode (show-format) profiles '
        + '(each pins a cast + models + segment count), the speaker/cast profiles (1–4 voices), the shows (channels), and '
        + 'recent episodes with their run-projected generation status. Use it to ground your plan before proposing or '
        + 'producing. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization to read; defaults to the workspace\'s sole org.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const empty = { content: JSON.stringify({ episodeProfiles: [], speakerProfiles: [], shows: [], episodes: [] }) };
      if (!scope.actingUserId || !(await podcastsEnabled(scope.tenantId, scope.actingUserId))) return empty;
      const resolved = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in resolved) return empty; // read tools fail EMPTY, not typed
      const { orgId } = resolved;
      const [episodeProfiles, speakerProfiles, shows, episodes] = await Promise.all([
        listEpisodeProfiles(scope.tenantId, orgId),
        listSpeakerProfiles(scope.tenantId, orgId),
        listShows(scope.tenantId, orgId),
        listEpisodes(scope.tenantId, orgId),
      ]);
      const projected = await Promise.all(episodes.map(async (e: PodcastEpisode) => {
        let runStatus: string | undefined;
        if (e.runId) { try { runStatus = (await deps.storage.getRun(e.runId))?.status; } catch { /* run gone */ } }
        return { id: e.id, title: e.title, notebookId: e.notebookId, episodeProfileId: e.episodeProfileId, status: projectStatus(runStatus) };
      }));
      return { content: JSON.stringify({ episodeProfiles, speakerProfiles, shows, episodes: projected }) };
    },
  });

  // ── ACTION: ignite the real generation run for a notebook + episode profile. ─
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PODCASTS_PRODUCE_TOOL_ID,
      description:
        'Generate a multi-speaker audio episode from a research notebook. Pass the `notebookId` (a readable notebook in '
        + 'the org) and an `episodeProfileId` (from `list` — it pins the cast + models). Optional `title` + `briefing` '
        + 'steer the outline. Starts the real `podcasts.generate` run (outline → transcript → synthesize → mix) and '
        + 'returns the `episodeId` + `runId`. Requires workspace write access; the run never publishes on its own.',
      inputSchema: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'The source research notebook (must be readable in the org).' },
          episodeProfileId: { type: 'string', description: 'The episode (show-format) profile pinning the cast + models.' },
          title: { type: 'string', description: 'Optional episode title (default "Untitled episode").' },
          briefing: { type: 'string', description: 'Optional briefing to steer the outline/angle.' },
          orgId: { type: 'string', description: 'The organization; defaults to the workspace\'s sole org.' },
        },
        required: ['notebookId', 'episodeProfileId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await podcastsEnabled(scope.tenantId, scope.actingUserId))) return toolError('feature_disabled', 'Podcasts is not enabled for this workspace.');
      const resolved = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in resolved) return resolved;
      const { orgId, actingUserId } = resolved;
      const notebookId = str(input.notebookId);
      const episodeProfileId = str(input.episodeProfileId);
      if (!notebookId) return toolError('validation_error', '`notebookId` is required.');
      if (!episodeProfileId) return toolError('validation_error', '`episodeProfileId` is required (get one from `list`).');

      // The episode profile must resolve in THIS org (it pins the cast + models).
      const profile = await getEpisodeProfile(scope.tenantId, episodeProfileId);
      if (!profile || profile.orgId !== orgId) {
        return toolError('validation_error', 'episodeProfileId does not resolve to a profile in this org.', { episodeProfileId });
      }
      // Cross-org IDOR guard (mirrors POST /episodes): the notebook must be in this
      // org AND readable by the acting user. Uniform not_found on miss/wrong-org/no-access.
      const nbProject = await getProject(scope.tenantId, notebookId);
      const nbAccess = nbProject ? await resolveProjectAccess(scope.tenantId, notebookId, actingUserId) : 'none';
      if (!nbProject || nbProject.orgId !== orgId || nbAccess === 'none') {
        return toolError('not_found', 'Notebook not found.', { notebookId });
      }
      // HIGH-1 ignition dedup — a repeated identical produce call inside the
      // window REUSES the run already started, so no orphan episode row is
      // created and no duplicate generation cost is incurred. The claim is taken
      // BEFORE createEpisode for exactly that reason. Key over the stable inputs.
      const key = ignitionKey('podcasts.produce', notebookId, episodeProfileId);
      const claim = await claimIgnition(scope.tenantId, key);
      if (!claim.claimed) {
        return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
      }

      const title = str(input.title) ?? 'Untitled episode';
      const briefing = str(input.briefing);
      const episode = await createEpisode(scope.tenantId, orgId, {
        notebookId, episodeProfileId, title, ...(briefing ? { briefing } : {}),
      });
      const runId = await startWorkflowRun(deps, {
        tenantId: scope.tenantId,
        workflowId: PODCASTS_GENERATE_ID,
        inputs: { episodeId: episode.id },
        metadata: {
          actingUserId,
          ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
          podcastEpisode: { episodeId: episode.id, notebookId: episode.notebookId },
        },
      }).catch((err) => {
        // DATA-4 — a startWorkflowRun THROW must be handled exactly like a null
        // return; coerce to null so the shared failure handler below both deletes
        // the pre-created episode AND releases the claim.
        log.warn('podcast_generation_dispatch_threw', { tenantId: scope.tenantId, orgId, episodeId: episode.id, error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (!runId) {
        // CFPT-2 / DATA-4 — the run never started (null OR a throw): release the
        // claim so an honest retry isn't blocked, AND delete the episode row we
        // pre-created so it isn't left orphaned with no generation run behind it.
        await deleteEpisode(scope.tenantId, episode.id);
        await releaseIgnition(scope.tenantId, key);
        return toolError('dispatch_failed', 'The podcast generation workflow could not start.');
      }
      await setEpisodeRun(scope.tenantId, episode.id, runId);
      await recordIgnitionRun(scope.tenantId, key, runId);
      const agentId = scope.agentProfileId ?? PRODUCER_AGENT_ID;
      if (scope.conversationId) await appendWorkflowRunTurn(deps.storage, scope.tenantId, scope.conversationId, runId, agentId);
      log.info('podcast_generation_dispatched', { tenantId: scope.tenantId, orgId, episodeId: episode.id, runId });
      return { content: JSON.stringify({ episodeId: episode.id, runId, status: 'queued' }) };
    },
  });
}
