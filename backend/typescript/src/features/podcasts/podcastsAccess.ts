/**
 * ADR 1115 D1 — the ONE episode-access rule. The HTTP doors (`routes.ts`), both chat
 * tools (`agentTools.ts`) and the run lane (`surface.ts`) all ask it, so "may this
 * person touch this episode" has one answer in every lane. Before this, each lane
 * answered its own question and they disagreed: the read doors checked the episode's
 * notebook, the write doors and the `list` tool did not, and the run checked nothing
 * but the tenant (`PODC93-2/-3/-4`).
 *
 * - Org scope is `resolveEffectiveAccess` in the episode's org (the ADR 0006 rule).
 * - A `private` notebook is read-gated to its members (`resolveProjectAccess`); org read
 *   is necessary but not sufficient (CPU-2).
 * - An ORPHAN episode (its notebook project was deleted; project delete does not cascade
 *   episodes) has no notebook policy left, so it stays reachable to org readers (the
 *   ADR 0086 orphan rule). It can never be a GENERATION target (`generateTargetAccess`).
 *
 * @see docs/adr/1115-podcasts-one-episode-access-rule.md
 */

import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
// ADR 1115 D1 — a provisioned notebook (a project with a bound KB collection) is the
// only valid generation source. `notebookAccess` is the notebooks feature's own rule
// (ADR 1103 D1); notebooks does not import podcasts, so this static edge has no cycle.
import { notebookAccess } from '../notebooks/notebooksService.js';
import type { PodcastEpisode } from './podcastsService.js';

export type EpisodeNeed = 'read' | 'write';
export type EpisodeAccess = 'ok' | 'hidden' | 'forbidden';

/** Does `subject` hold `scope` in `orgId`? An absent subject holds nothing. */
export async function orgAllows(tenantId: string, orgId: string, subject: string | undefined, scope: Scope): Promise<boolean> {
  if (!subject) return false;
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** May `subject` read the episode's notebook? `true` for an orphan (see file doc).
 *  The optional `memo` dedupes per-notebook resolves across a list (many episodes share
 *  a notebook); it caches the in-flight Promise. */
export async function notebookReadableBy(
  tenantId: string,
  notebookId: string,
  subject: string | undefined,
  memo?: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const cached = memo?.get(notebookId);
  if (cached) return cached;
  const p = (async (): Promise<boolean> => {
    const nb = await getProject(tenantId, notebookId);
    if (!nb) return true; // orphan — the org-read scope already gated it
    return (await resolveProjectAccess(tenantId, notebookId, subject)) !== 'none';
  })();
  memo?.set(notebookId, p);
  return p;
}

/** THE rule for an existing episode. `hidden` = no org read, or the notebook is not
 *  readable (doors 404, the run says "not found"); `forbidden` = readable, but `write`
 *  was needed and the subject lacks `workspace:write` (doors 403). */
export async function episodeAccess(
  tenantId: string,
  episode: Pick<PodcastEpisode, 'orgId' | 'notebookId'>,
  subject: string | undefined,
  need: EpisodeNeed,
): Promise<EpisodeAccess> {
  if (!(await orgAllows(tenantId, episode.orgId, subject, 'workspace:read'))) return 'hidden';
  if (!(await notebookReadableBy(tenantId, episode.notebookId, subject))) return 'hidden';
  if (need === 'write' && !(await orgAllows(tenantId, episode.orgId, subject, 'workspace:write'))) return 'forbidden';
  return 'ok';
}

export type GenerateTargetRefusal = 'hidden' | 'forbidden' | 'notebook_has_no_sources';

/** The rule for GENERATING into (orgId, notebookId), new or re-run: `workspace:write` in
 *  the org (else `forbidden`); the project exists in that org and the subject can read it
 *  (else `hidden`, uniform with a missing one); and it is a provisioned notebook (else
 *  `notebook_has_no_sources`: a project the caller can read but with no bound source
 *  collection, ADR 1115 D1 as corrected by the architect pass). */
export async function generateTargetAccess(
  tenantId: string,
  orgId: string,
  notebookId: string,
  subject: string | undefined,
): Promise<{ ok: true } | { refused: GenerateTargetRefusal }> {
  // Write in the org first: the org comes from the caller's own body (create) or the
  // episode row, so a 403 here discloses nothing, and it is the order `POST /episodes`
  // always had (403 before any notebook lookup).
  if (!(await orgAllows(tenantId, orgId, subject, 'workspace:write'))) return { refused: 'forbidden' };
  const project = await getProject(tenantId, notebookId);
  if (!project || project.orgId !== orgId) return { refused: 'hidden' };
  if ((await resolveProjectAccess(tenantId, notebookId, subject)) === 'none') return { refused: 'hidden' };
  if (!(await notebookAccess(tenantId, notebookId, subject))) return { refused: 'notebook_has_no_sources' };
  return { ok: true };
}

/** The episodes of a list `subject` may read (the CPU-2 filter), shared by
 *  `GET /episodes`, the `list` chat tool and the run lane's `listEpisodes`. The caller
 *  has already checked org read. */
export async function filterReadableEpisodes<E extends Pick<PodcastEpisode, 'notebookId'>>(
  tenantId: string,
  list: readonly E[],
  subject: string | undefined,
): Promise<E[]> {
  const memo = new Map<string, Promise<boolean>>();
  const out: E[] = [];
  for (const e of list) if (await notebookReadableBy(tenantId, e.notebookId, subject, memo)) out.push(e);
  return out;
}
