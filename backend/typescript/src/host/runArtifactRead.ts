/**
 * `getArtifact` (`GET /runs/{runId}/artifacts/{artifactId}`) — resolve an
 * artifact a run ANNOUNCED (RFC 0205, ADR 0746).
 *
 * Three rules, in order, each of which ends in `null` (the route's 404, never a
 * 403 — existence is not disclosed):
 *
 *   1. **Announcement.** The run's own event log must carry an `artifact.created`
 *      whose `artifactId` is the requested one. The wire names artifacts ONLY
 *      through that event, so an id the run never announced is not one of its
 *      artifacts, whatever a store might hold under it. An inherited fork prefix
 *      counts: the fork announces what its source announced.
 *   2. **Ownership.** Announcing is not owning — any node can `ctx.emit` any id.
 *      A `run-event:` row must sit in the run's tenant AND belong to the run or
 *      to one of its `parentRunId` ancestors (fork source / sub-workflow parent);
 *      a Documents-backed artifact is resolved through the ONE artifact
 *      projection (`artifactProjection.ts`), so the org + `ownerSubject`
 *      membership gate that guards `/artifacts/*` guards this door too.
 *   3. **Content.** No second store: `run-event:` rows live in the ADR 0083
 *      `runartifact` collection (cascaded by run delete + retention), documents
 *      in their immutable versions.
 *
 * The result is shape-neutral; the route renders it as `application/json` or as
 * an A2A `Artifact` (`a2aCodec10.artifact10`).
 */

import type { Storage } from '../storage/storage.js';

/** The two reads this resolver needs — narrowed so it is drivable without a full backend. */
type RunLogReader = Pick<Storage, 'findFirstEventByPayload' | 'getRun'>;
import type { RunRecord } from '../types.js';
import { getRunArtifact } from './runArtifactStore.js';
import { getArtifact as getProjectedArtifact, getArtifactRevision } from './artifactProjection.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.run-artifact-read');

/**
 * ADR 0755 (WIT-ART-6) — every miss is the same non-disclosing 404 on the wire,
 * so the REASON lives here, at debug, keyed by a closed set. Never in the
 * response: telling "not announced" from "not owned" is exactly the oracle the
 * 404 exists to withhold.
 */
type MissReason = 'not-announced' | 'row-absent' | 'row-foreign' | 'not-owned' | 'no-subject' | 'document-absent' | 'unrecognised-id';
function miss(reason: MissReason, runId: string, artifactId: string): null {
  log.debug('run_artifact_miss', { reason, runId, artifactId });
  return null;
}

export interface ResolvedRunArtifact {
  artifactId: string;
  /** Absent when neither the announcement nor the row names a type (ADR 0755
   *  WIT-ART-10: omitted, never the invented literal `'unknown'`). */
  artifactType?: string;
  nodeId?: string;
  name?: string;
  description?: string;
  body: { kind: 'data'; data: unknown } | { kind: 'text'; text: string; mediaType: string };
}

type Json = Record<string, unknown>;

/** Bound on the `parentRunId` walk. */
const MAX_ANCESTRY = 16;

/**
 * The `artifact.created` payload in this run's log that names `artifactId`, or null.
 *
 * ADR 0754 — ONE database read (`findFirstEventByPayload`, over the existing
 * `(run_id, sequence)` index). This used to page the log into the process, 500
 * events per round-trip up to 100 of them, and answer a silent 404 for any
 * announcement past event 50,000.
 */
async function findAnnouncement(storage: RunLogReader, runId: string, artifactId: string): Promise<{ payload: Json; nodeId?: string } | null> {
  const e = await storage.findFirstEventByPayload(runId, 'artifact.created', 'artifactId', artifactId);
  if (!e) return null;
  const p = e.payload;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  const nodeId = typeof (p as Json)['nodeId'] === 'string' ? ((p as Json)['nodeId'] as string) : e.nodeId;
  return { payload: p as Json, ...(nodeId ? { nodeId } : {}) };
}

/** True when `ownerRunId` is `run` or one of its `parentRunId` ancestors in the same tenant. */
async function isRunOrAncestor(storage: RunLogReader, run: RunRecord, ownerRunId: string): Promise<boolean> {
  let cur: RunRecord | null = run;
  for (let hop = 0; cur && hop <= MAX_ANCESTRY; hop++) {
    if (cur.runId === ownerRunId) return true;
    if (!cur.parentRunId) return false;
    const parent: RunRecord | null = await storage.getRun(cur.parentRunId);
    cur = parent && parent.tenantId === run.tenantId ? parent : null;
  }
  return false;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function resolveRunArtifact(input: {
  storage: RunLogReader;
  run: RunRecord;
  artifactId: string;
  /** The authenticated subject, for the Documents membership gate. */
  subject: string | undefined;
}): Promise<ResolvedRunArtifact | null> {
  const { storage, run, artifactId } = input;
  const announced = await findAnnouncement(storage, run.runId, artifactId);
  if (!announced) return miss('not-announced', run.runId, artifactId);
  const artifactType = str(announced.payload['artifactType']) ?? str(announced.payload['artifactTypeId']);
  const summary = str(announced.payload['summary']);

  // (a) A run-output artifact (ADR 0083 id scheme `run-event:<runId>:<nodeId>`).
  if (artifactId.startsWith('run-event:')) {
    const row = await getRunArtifact(artifactId.slice('run-event:'.length));
    if (!row || row.linkedArtifactId) return miss('row-absent', run.runId, artifactId);
    if (row.tenantId !== run.tenantId) return miss('row-foreign', run.runId, artifactId);
    if (!(await isRunOrAncestor(storage, run, row.runId))) return miss('not-owned', run.runId, artifactId);
    const type = row.announcedType ?? row.artifactTypeId ?? artifactType;
    const body: ResolvedRunArtifact['body'] = row.format === 'application/json'
      ? { kind: 'data', data: parseJson(row.content) }
      : { kind: 'text', text: row.content, mediaType: row.format };
    return {
      artifactId,
      ...(type ? { artifactType: type } : {}),
      nodeId: row.nodeId,
      name: row.title,
      ...(summary ? { description: summary } : {}),
      body,
    };
  }

  // (b) A Documents-backed artifact (the documents `generate` node announces
  // `${documentId}:${version}` = the immutable version id).
  const documentId = str(announced.payload['documentId']);
  const versionId = str(announced.payload['versionId']);
  if (documentId && versionId && versionId === artifactId) {
    if (!input.subject) return miss('no-subject', run.runId, artifactId); // fail-closed: the projection would read an absent subject as tenant-owner
    const projectedId = `document:${documentId}`;
    const [doc, revision] = await Promise.all([
      getProjectedArtifact(run.tenantId, input.subject, projectedId),
      getArtifactRevision(run.tenantId, input.subject, projectedId, versionId),
    ]);
    if (!doc || revision?.content === undefined) return miss('document-absent', run.runId, artifactId);
    // ADR 0755 (WIT-ART-5) — HIGH-1 ("announcing is not owning") applied to this
    // lane too: the VERSION must have been produced by this run or one of its
    // ancestors. Without it any node in the tenant could announce any readable
    // document version and have it served as its run's artifact.
    const producer = revision.createdBy;
    if (producer?.kind !== 'run' || !(await isRunOrAncestor(storage, run, producer.id))) {
      return miss('not-owned', run.runId, artifactId);
    }
    // The typed payload the node validated against the artifact type
    // (`packs/feature.documents.nodes` §generate), rebuilt from the durable version.
    return {
      artifactId,
      ...(artifactType ? { artifactType } : {}),
      ...(announced.nodeId ? { nodeId: announced.nodeId } : {}),
      name: doc.title,
      ...(summary ? { description: summary } : {}),
      body: { kind: 'data', data: { content: revision.content, title: doc.title, kind: doc.kind, documentId } },
    };
  }
  return miss('unrecognised-id', run.runId, artifactId);
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}
