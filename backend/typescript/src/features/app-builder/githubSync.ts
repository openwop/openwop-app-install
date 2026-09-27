/**
 * Outbound GitHub sync for a bound app-builder canvas (ADR 0393 Lane A).
 *
 * Architect-ruled deviation from the ADR's sketch (recorded as a correction
 * note in the ADR): the sync push is ONE ATOMIC COMMIT via the Git Data API
 * (tree → commit → ref fast-forward), not per-file create-or-update PUTs.
 * Per-file `PUT /contents` makes one commit per file — N marker commits that
 * defeat the Phase 2 head-commit skip-self check, 2N API calls, and a torn
 * active branch on a mid-loop abort. The tree flow is 5 calls regardless of
 * file count, content-addressed (identical model → identical tree → honest
 * no-op), and either the whole snapshot lands or nothing does.
 *
 * The pushed repo has two disjoint regions (ADR 0393 A1):
 *   - `app.model.json` — the canonical model serialization, the ONLY
 *     round-trippable artifact (imported back by inbound sync, Phase 2);
 *   - generated framework source — build output, regenerated every push and
 *     ignored on inbound. `.openwop/generated.json` manifests the paths this
 *     sync owns, so the NEXT sync can delete stale generated files without
 *     ever touching files the developer added themselves.
 *
 * ADR 0306's `publishToGitHub` (create-only, its own toggle + governance pins)
 * is intentionally untouched; both lanes share the exported `gh()` broker.
 */
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { generateScrubbed } from './export/exportService.js';
import { gh } from './publishService.js';
import type { SyncBinding } from './syncBinding.js';

const log = createLogger('features.app-builder.githubSync');

/** Head-commit actor marker (ADR 0393 A2/A3) — the Phase 2 skip-self check
 *  parses `model-version=<n>` out of a message carrying this marker. */
export const SYNC_ACTOR_MARKER = '[openwop-sync]';
export const MODEL_FILE = 'app.model.json';
export const GENERATED_MANIFEST = '.openwop/generated.json';
const MAX_SYNC_FILES = 200;

/** Parse the model version out of a sync commit message; null when the commit
 *  is not ours (no marker) or carries no readable version. */
export function parseSyncMarker(message: string): number | null {
  if (!message.includes(SYNC_ACTOR_MARKER)) return null;
  const m = /model-version=(\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

/** Deterministic JSON — sorted object keys so an identical model always
 *  serializes to an identical blob (the content-addressed no-op guarantee). */
export function canonicalModelJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

export interface SyncPushResult {
  outcome: 'pushed' | 'noop' | 'ref_conflict';
  repoUrl: string;
  branch: string;
  commitSha?: string;
  filesPushed: number;
  deletedStale: number;
  modelVersion: number;
  warnings: string[];
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  content?: string;
  sha?: null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Push the bound canvas's current model + regenerated source as one commit
 *  onto the binding's active branch. Fast-forward only — a concurrent external
 *  push surfaces as `ref_conflict` (retried once), never a force overwrite. */
export async function syncPushToGitHub(
  deps: BrokeredEgressDeps,
  binding: SyncBinding,
  args: { app: unknown; modelVersion: number },
): Promise<SyncPushResult> {
  const { owner, repo, branch } = binding;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  // Branch names may contain '/' (feature/x) — encode per segment, keep the
  // separators literal (the GitHub ref path convention).
  const refSegment = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const { files, warnings } = generateScrubbed(args.app, binding.target);
  if (files.length + 2 > MAX_SYNC_FILES) {
    throw new OpenwopError('validation_error', `Sync exceeds the ${MAX_SYNC_FILES}-file cap.`, 413, { fileCount: files.length, max: MAX_SYNC_FILES });
  }

  const generatedPaths = files.map((f) => f.path).sort();
  const snapshot: { path: string; content: string }[] = [
    { path: MODEL_FILE, content: canonicalModelJson(args.app) },
    { path: GENERATED_MANIFEST, content: JSON.stringify({ note: 'Paths below are OpenWOP build output — regenerated on every sync, ignored on inbound. Edit app.model.json (or the builder), not these.', modelVersion: args.modelVersion, paths: generatedPaths }, null, 2) + '\n' },
    ...files,
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 1. Resolve the active-branch head (missing branch ⇒ first sync on an empty ref).
    const ref = await gh(deps, 'GET', `${repoPath}/git/ref/${refSegment}`);
    let headSha: string | undefined;
    let baseTreeSha: string | undefined;
    if (ref.status === 200) {
      headSha = str((ref.json.object as Record<string, unknown> | undefined)?.sha);
      if (!headSha) throw new OpenwopError('egress_blocked', 'GitHub returned an unreadable ref.', 502);
      const head = await gh(deps, 'GET', `${repoPath}/git/commits/${headSha}`);
      if (head.status !== 200) throw new OpenwopError('egress_blocked', `GitHub head-commit read failed (${head.status}).`, 502, { status: head.status });
      baseTreeSha = str((head.json.tree as Record<string, unknown> | undefined)?.sha);
    } else if (ref.status !== 404) {
      throw new OpenwopError('egress_blocked', `GitHub ref read failed (${ref.status}).`, 502, { status: ref.status });
    }

    // 2. Stale-file cleanup: diff the PREVIOUS sync's generated manifest against
    //    this snapshot; delete only paths WE generated that are gone now.
    let deletions: string[] = [];
    if (headSha) {
      const prev = await gh(deps, 'GET', `${repoPath}/contents/${GENERATED_MANIFEST}?ref=${encodeURIComponent(branch)}`);
      if (prev.status === 200 && typeof prev.json.content === 'string') {
        try {
          const parsed = JSON.parse(Buffer.from(prev.json.content, 'base64').toString('utf8')) as { paths?: unknown };
          const prevPaths = Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === 'string') : [];
          const current = new Set(snapshot.map((f) => f.path));
          deletions = prevPaths.filter((p) => !current.has(p));
        } catch {
          warnings.push('Previous generated-files manifest was unreadable — stale build output (if any) was left in place.');
        }
      }
    }

    // 3. One tree: full snapshot + explicit deletions of our own stale output.
    const tree: TreeEntry[] = [
      ...snapshot.map((f): TreeEntry => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      ...deletions.map((p): TreeEntry => ({ path: p, mode: '100644', type: 'blob', sha: null })),
    ];
    const treeRes = await gh(deps, 'POST', `${repoPath}/git/trees`, baseTreeSha ? { base_tree: baseTreeSha, tree } : { tree });
    if (treeRes.status !== 201) {
      throw new OpenwopError('egress_blocked', `GitHub tree creation failed (${treeRes.status}).`, 502, { status: treeRes.status });
    }
    const treeSha = str(treeRes.json.sha);
    if (!treeSha) throw new OpenwopError('egress_blocked', 'GitHub returned an unreadable tree.', 502);

    // Content-addressed no-op: identical model + output ⇒ identical tree.
    if (baseTreeSha && treeSha === baseTreeSha) {
      log.info('github_sync_push', { tenantId: deps.tenantId, actor: deps.actingUserId ?? null, repo: `${owner}/${repo}`, branch, outcome: 'noop', modelVersion: args.modelVersion });
      return { outcome: 'noop', repoUrl: `https://github.com/${owner}/${repo}`, branch, filesPushed: 0, deletedStale: 0, modelVersion: args.modelVersion, warnings };
    }

    // 4. The ONE sync commit — actor marker + model version (skip-self basis).
    const message = `Sync from OpenWOP App Builder\n\n${SYNC_ACTOR_MARKER} model-version=${args.modelVersion}`;
    const commit = await gh(deps, 'POST', `${repoPath}/git/commits`, { message, tree: treeSha, parents: headSha ? [headSha] : [] });
    if (commit.status !== 201 || !str(commit.json.sha)) {
      throw new OpenwopError('egress_blocked', `GitHub commit creation failed (${commit.status}).`, 502, { status: commit.status });
    }
    const commitSha = str(commit.json.sha)!;

    // 5. Fast-forward the active branch (create the ref on first sync).
    const refUpdate = headSha
      ? await gh(deps, 'PATCH', `${repoPath}/git/refs/${refSegment}`, { sha: commitSha, force: false })
      : await gh(deps, 'POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitSha });
    if (refUpdate.status === 200 || refUpdate.status === 201) {
      log.info('github_sync_push', { tenantId: deps.tenantId, actor: deps.actingUserId ?? null, repo: `${owner}/${repo}`, branch, outcome: 'pushed', commitSha, files: snapshot.length, deleted: deletions.length, modelVersion: args.modelVersion });
      return { outcome: 'pushed', repoUrl: `https://github.com/${owner}/${repo}`, branch, commitSha, filesPushed: snapshot.length, deletedStale: deletions.length, modelVersion: args.modelVersion, warnings };
    }
    // 422 = non-fast-forward: someone pushed between our ref read and update.
    // One re-read-and-rebuild retry; a second loss is a typed conflict.
    if (refUpdate.status === 422 && attempt === 0) continue;
    if (refUpdate.status === 422) {
      log.info('github_sync_push', { tenantId: deps.tenantId, actor: deps.actingUserId ?? null, repo: `${owner}/${repo}`, branch, outcome: 'ref_conflict', modelVersion: args.modelVersion });
      return { outcome: 'ref_conflict', repoUrl: `https://github.com/${owner}/${repo}`, branch, filesPushed: 0, deletedStale: 0, modelVersion: args.modelVersion, warnings: [...warnings, 'The active branch moved during the push (concurrent external commits). Sync again once the branch settles.'] };
    }
    throw new OpenwopError('egress_blocked', `GitHub ref update failed (${refUpdate.status}).`, 502, { status: refUpdate.status });
  }
  // Unreachable: the loop either returns or throws by the second attempt.
  throw new OpenwopError('egress_blocked', 'GitHub sync did not converge.', 502);
}
