/**
 * GitHub publish for an app-builder export (ADR 0306 / ADR 0305 Phase G).
 * Reuses the ONE export-security step (`generateScrubbed` — same scrub + caps as
 * the ZIP path) and pushes the generated source through `brokeredFetch`:
 * the token is resolved host-side, pinned to `api.github.com`, and never reaches
 * the caller, the response, or the logs.
 *
 * v1 semantics (ADR 0306, architect-ruled):
 *   - repo create is 409/422-tolerant — an existing repo is REUSED and flagged;
 *   - file pushes are CREATE-ONLY (no sha lookup): an existing path surfaces as
 *     a per-file warning, never a silent overwrite;
 *   - publish is capped at 200 files (secondary-rate-limit headroom).
 */
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { brokeredFetch, type BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { generateScrubbed } from './export/exportService.js';
import type { ExportTarget } from './export/generators.js';

const API = 'https://api.github.com';
const MAX_PUBLISH_FILES = 200;
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const log = createLogger('features.app-builder.publish');

export interface PublishResult {
  repoUrl: string;
  repo: 'created' | 'reused';
  filesPushed: number;
  /** Grade pass 2026-07-07 (F8): true when the push loop ABORTED early (auth/
   *  rate-limit class) or any file failed — the caller must not read a 201 as
   *  "everything landed". */
  partial: boolean;
  warnings: string[];
}

/** One brokered GitHub API call — token host-side, pinned to api.github.com.
 *  Exported for the ADR 0393 sync lane (`githubSync.ts`), which composes this
 *  instead of standing up a second GitHub client. */
export async function gh(deps: BrokeredEgressDeps, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const out = await brokeredFetch(deps, {
    provider: 'github-publish',
    url: `${API}${path}`,
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), contentType: 'application/json' } : {}),
    extraHeaders: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'openwop-app' },
  });
  if (out.outcome === 'no_connection') {
    throw new OpenwopError('credential_unavailable', 'No GitHub (publish) connection with a granted write scope — connect it under Connections first.', 424, { provider: 'github-publish' });
  }
  if (out.outcome !== 'sent') {
    throw new OpenwopError('egress_blocked', `GitHub was not reachable (${out.outcome}).`, 502, { outcome: out.outcome });
  }
  const json = (await out.res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: out.res.status, json };
}

export async function publishToGitHub(
  deps: BrokeredEgressDeps,
  args: { state: unknown; target: ExportTarget; repo: string; isPrivate: boolean },
): Promise<PublishResult> {
  if (!REPO_NAME_RE.test(args.repo)) {
    throw new OpenwopError('validation_error', 'Repository name must be 1-100 chars of letters, digits, ".", "_", "-".', 400, { field: 'repo' });
  }
  const { files, warnings } = generateScrubbed(args.state, args.target);
  if (files.length > MAX_PUBLISH_FILES) {
    throw new OpenwopError('validation_error', `Publish exceeds the ${MAX_PUBLISH_FILES}-file cap (export the ZIP instead).`, 413, { fileCount: files.length, max: MAX_PUBLISH_FILES });
  }

  // Resolve the token's login (owner of the new repo).
  const user = await gh(deps, 'GET', '/user');
  if (user.status !== 200 || typeof user.json.login !== 'string') {
    throw new OpenwopError('egress_blocked', `GitHub rejected the connection token (${user.status}).`, 502, { status: user.status });
  }
  const owner = user.json.login;

  // Create the repo; an existing repo of that name is reused — flagged, never silent.
  const create = await gh(deps, 'POST', '/user/repos', { name: args.repo, private: args.isPrivate, auto_init: false, description: 'Published by OpenWOP App Builder' });
  let repoState: PublishResult['repo'];
  if (create.status === 201) repoState = 'created';
  // 422 = "name already exists on this account"; 409 = the same, raced (F8 —
  // the header always promised 409-tolerance; now it is implemented).
  else if (create.status === 422 || create.status === 409) repoState = 'reused';
  else throw new OpenwopError('egress_blocked', `GitHub repo creation failed (${create.status}).`, 502, { status: create.status });

  // Create-only content pushes (no sha → GitHub 422s on an existing path → warning).
  // Grade pass 2026-07-07 (F8): an auth/rate-limit-class failure ABORTS the loop
  // (a revoked token previously produced 200 identical warnings + a "successful"
  // 201 with zero files); per-file 422s stay warnings.
  let pushed = 0;
  let aborted = false;
  for (const f of files) {
    const put = await gh(deps, 'PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(args.repo)}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`, {
      message: `Add ${f.path} (OpenWOP App Builder)`,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
    });
    if (put.status === 201 || put.status === 200) { pushed += 1; continue; }
    if (put.status === 401 || put.status === 403 || put.status === 429) {
      warnings.push(`Push aborted at '${f.path}': GitHub returned ${put.status} (token/rate limit). ${pushed}/${files.length} file(s) landed.`);
      aborted = true;
      break;
    }
    if (put.status === 422) warnings.push(`'${f.path}' already exists in the repository — left untouched (no overwrite).`);
    else warnings.push(`'${f.path}' failed to push (${put.status}).`);
  }

  const partial = aborted || pushed < files.length;
  // One structured line per vendor write (the ADR 0028 observability posture) —
  // repo + counts only, never content or the token.
  log.info('github_publish', { tenantId: deps.tenantId, actor: deps.actingUserId ?? null, repo: `${owner}/${args.repo}`, repoState, files: files.length, pushed, partial });
  return { repoUrl: `https://github.com/${owner}/${args.repo}`, repo: repoState, filesPushed: pushed, partial, warnings };
}
