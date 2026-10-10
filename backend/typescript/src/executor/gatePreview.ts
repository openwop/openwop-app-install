/**
 * loop row 3, P2 — interrupt.md §Events — the artifact an approval's `interrupt.requested` names.
 *
 * `ApprovalData.artifactId` is REQUIRED on the wire, and a client that follows
 * it must reach something: an id that does not resolve is a false claim, not a
 * placeholder. The executor already persists the gate's UPSTREAM output as its
 * preview (ADR 0083). This covers the two cases that leave nothing to name:
 *
 *  - a REPLAY fork persists nothing (the source's artifacts are canonical), so
 *    it names the INHERITED source preview — only when that id resolves from
 *    the fork's own tenant;
 *  - a gate with no upstream output (or whose inherited preview does not
 *    resolve) gets a MINIMAL preview describing what is being approved (the
 *    title/prompt the gate carries), persisted like any gate preview.
 *
 * Both live in the `runartifact` store under the deterministic
 * `${runId}:${nodeId}` key, so run delete, retention and DSAR cascade over them
 * exactly as over every other gate preview; a re-execution re-reads, never
 * re-mints (insert-only CAS).
 */
import type { RunRecord } from '../types.js';
import { getRunArtifact, persistRunArtifact, runArtifactKey } from '../host/runArtifactStore.js';
import { getArtifact } from '../host/artifactProjection.js';

type Preview = { artifactId: string; revisionId: string };

async function inheritedPreview(run: RunRecord, nodeId: string): Promise<Preview | null> {
  if (run.forkMode !== 'replay' || typeof run.parentRunId !== 'string') return null;
  const row = await getRunArtifact(runArtifactKey(run.parentRunId, nodeId));
  if (!row) return null;
  const artifactId = row.linkedArtifactId ?? `run-event:${row.artifactKey}`;
  // Resolves from the FORK's tenant (subject-less = the tenant-owner view the
  // artifact routes fall back to), or it is not named.
  const projected = await getArtifact(run.tenantId, undefined, artifactId);
  if (!projected) return null;
  return { artifactId, revisionId: row.linkedArtifactId ? (row.linkedRevisionId ?? '') : `${row.artifactKey}:1` };
}

export async function ensureApprovalPreview(input: { run: RunRecord; nodeId: string; data: unknown }): Promise<Preview | null> {
  const inherited = await inheritedPreview(input.run, input.nodeId);
  if (inherited) return inherited;
  const d = (input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {}) as Record<string, unknown>;
  const title = [d.title, d.prompt, d.question].find((v): v is string => typeof v === 'string' && v.length > 0) ?? `Approve ${input.nodeId}`;
  return persistRunArtifact({
    tenantId: input.run.tenantId,
    runId: input.run.runId,
    nodeId: input.nodeId,
    role: 'gate-preview',
    // Plain text, so the artifact's title (its first line) IS the gate's title.
    output: [
      title,
      ...(typeof d.prompt === 'string' && d.prompt !== title ? ['', d.prompt] : []),
      '',
      `Approval requested at gate "${input.nodeId}".`,
      ...(Array.isArray(d.actions) ? [`Actions: ${d.actions.filter((a) => typeof a === 'string').join(', ')}`] : []),
    ].join('\n'),
    now: new Date().toISOString(),
  });
}
