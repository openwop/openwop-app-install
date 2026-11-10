/**
 * ADR 1014 D7 / P5 — user-authored agents get revisions.
 *
 * Before this, an edit overwrote the agent in place and every user agent's
 * version was `'0'`, so a deployment of a user agent could only ever name the
 * code that was live. Now an edit that changes the agent's content writes a new
 * revision (`1`, `2`, …) and keeps the old one, so a deployment can keep serving a
 * revision while a newer one is a draft.
 *
 * Compatibility, by construction: an agent never edited since this shipped HAS
 * NO revision rows, and its version is `0`, exactly as before. Its first edit
 * snapshots the pre-edit content as revision `0` and writes revision `1`, so a
 * deployment row that named `0` still names the same content.
 *
 * Storage is the host-extension KV (`DurableCollection`), tenant-partitioned: no
 * SQL migration. Retention keeps the newest ten and every revision a deployment
 * row names (the same seam the pack archive uses, ADR 1014 Q3).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser, type SubjectEraseReport } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import type { UserAgentRecord } from '../types.js';

export const REVISION_KEEP_NEWEST = 10;

/** `authoredBy` is the signed-in user whose create or edit produced this content
 *  (ADR 1014 D8). Absent when nobody is known: a row written before D8, or the
 *  pre-edit snapshot of an agent that had no revisions yet. */
interface RevisionRow { tenantId: string; agentId: string; revision: number; contentKey: string; record: UserAgentRecord; createdAt: string; authoredBy?: string }
interface HeadRow { tenantId: string; agentId: string; revision: number; contentKey: string }

const revisions = new DurableCollection<RevisionRow>(
  'user-agent-revisions', (r) => `${r.tenantId}::${r.agentId}::${r.revision}`, undefined, (r) => r.tenantId,
);
const heads = new DurableCollection<HeadRow>(
  'user-agent-revision-heads', (h) => `${h.tenantId}::${h.agentId}`, undefined, (h) => h.tenantId,
);

type PinnedRevisions = (tenant: string, agentId: string) => Promise<ReadonlySet<string>>;
let pinned: PinnedRevisions | undefined;
/** The agent-deployments feature registers which revisions its rows still name. */
export function setUserAgentPinnedRevisions(fn: PinnedRevisions | undefined): void {
  pinned = fn;
}

type RevisedHook = (tenant: string, agentId: string, revision: string) => Promise<void>;
let revisedHook: RevisedHook | undefined;
/** ADR 1014 D7 — with deployment rows, an edit arrives as a `draft` (the feature mints it). */
export function setUserAgentRevisedHook(fn: RevisedHook | undefined): void {
  revisedHook = fn;
}

/** What makes two edits the same revision: the fields a run actually reads. */
export function revisionContentKey(r: UserAgentRecord): string {
  return JSON.stringify([r.persona, r.label ?? null, r.description ?? null, r.modelClass, r.systemPrompt, r.toolAllowlist ?? null, r.memoryShape ?? null, r.confidenceThreshold ?? null]);
}

/** The agent's current revision as a version string; `'0'` for an agent with no revisions. */
export async function currentRevision(tenant: string, agentId: string): Promise<string> {
  const h = await readHead(tenant, agentId);
  return h ? String(h.revision) : '0';
}

async function readHead(tenant: string, agentId: string): Promise<HeadRow | null> {
  const h = await heads.get(`${tenant}::${agentId}`);
  return h && h.tenantId === tenant && h.agentId === agentId ? h : null;
}

/** The newest revision whose content is `record`'s, or null when none is numbered.
 *  For an edit that a newer edit superseded before it could number itself. */
export async function revisionOfContent(record: UserAgentRecord): Promise<string | null> {
  const key = revisionContentKey(record);
  let best: number | null = null;
  for (const row of await revisions.listByPrefix(`${record.tenantId}::${record.agentId}::`)) {
    if (row.tenantId !== record.tenantId || row.agentId !== record.agentId || row.contentKey !== key) continue;
    if (best === null || row.revision > best) best = row.revision;
  }
  return best === null ? null : String(best);
}

/** The record stored for one revision, or null. Revision `0` of a never-edited agent is its live record (the caller has it). */
export async function getRevision(tenant: string, agentId: string, revision: string): Promise<UserAgentRecord | null> {
  if (!/^(0|[1-9]\d{0,8})$/.test(revision)) return null; // canonical only: `01` is not revision 1
  const row = await revisions.get(`${tenant}::${agentId}::${Number(revision)}`);
  return row && row.tenantId === tenant && row.agentId === agentId ? row.record : null;
}

async function putRevision(record: UserAgentRecord, revision: number, contentKey: string, authoredBy: string | undefined): Promise<boolean> {
  return revisions.compareAndSwap(null, {
    tenantId: record.tenantId, agentId: record.agentId, revision, contentKey, record, createdAt: new Date().toISOString(),
    ...(authoredBy ? { authoredBy } : {}),
  });
}

/**
 * Make the revision head agree with the STORED record, and return its revision.
 * - No head (never edited since revisions shipped): the record is revision 0.
 * - Head on other content (an edit committed but not yet numbered, here or on
 *   another instance): the record becomes the next revision.
 * - Head on this content: nothing is written.
 * Numbering follows the stored record, never a caller's idea of "before", so two
 * concurrent edits always number the content that was actually stored, in the
 * order the record's own CAS committed it.
 *
 * `authoredBy` names who wrote this content; pass it only from the create or edit
 * that stored it, never from a catch-up, which cannot know.
 */
export async function alignHead(
  first: UserAgentRecord,
  authoredBy?: string,
  /** TST-FIB-GC1 — re-read the STORED record before each retry. A caller's record can
   *  be stale by the time a retry runs (a newer edit committed meanwhile); numbering
   *  it then names content that is no longer stored. Absent: number `first` only. */
  reload?: () => Promise<UserAgentRecord | null>,
): Promise<string> {
  const tenant = first.tenantId;
  const firstKey = revisionContentKey(first);
  let record = first;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0 && reload) record = (await reload().catch(() => null)) ?? record;
    const key = revisionContentKey(record);
    // The author is credited only while the content is still the one they wrote.
    const author = key === firstKey ? authoredBy : undefined;
    const head = await readHead(tenant, record.agentId);
    if (head && head.contentKey === key) return String(head.revision);
    const revision = head ? head.revision + 1 : 0;
    if (!(await putRevision(record, revision, key, author))) {
      // TST-FIB-GC1 — another aligner already wrote revision `revision` and has not
      // moved the head yet. The head must never name a row holding other content (it
      // used to: this aligner's head CAS could win and point `revision` at the other
      // aligner's row). If that row is ours, take it; otherwise finish the other
      // aligner's step (move the head onto ITS content) and number ours after it.
      // The next pass returns when the head is on our content, or numbers ours next.
      const existing = await revisions.get(`${tenant}::${record.agentId}::${revision}`);
      if (existing && await heads.compareAndSwap(head, { tenantId: tenant, agentId: record.agentId, revision, contentKey: existing.contentKey })) {
        await afterHeadMoved(tenant, record.agentId, revision);
      }
      continue;
    }
    if (!(await heads.compareAndSwap(head, { tenantId: tenant, agentId: record.agentId, revision, contentKey: key }))) continue;
    await afterHeadMoved(tenant, record.agentId, revision);
    return String(revision);
  }
  return currentRevision(tenant, record.agentId);
}

/** Retention and the draft hook run once per head move, whoever moved it. */
async function afterHeadMoved(tenant: string, agentId: string, revision: number): Promise<void> {
  if (revision === 0) return;
  await pruneRevisions(tenant, agentId, revision);
  if (revisedHook) await revisedHook(tenant, agentId, String(revision)).catch(() => undefined);
}

/**
 * The revision to REGISTER a record under, reading only: the head's when it is on
 * this content, `'0'` for a never-edited agent, and (rare: an edit whose numbering
 * did not complete) an `alignHead` catch-up. So a restarted instance registers the
 * same version for the same content as the instance that made the edit.
 */
export async function revisionForRecord(record: UserAgentRecord): Promise<string> {
  const head = await readHead(record.tenantId, record.agentId);
  if (!head) return '0';
  if (head.contentKey === revisionContentKey(record)) return String(head.revision);
  return alignHead(record);
}

type DeletedHook = (tenant: string, agentId: string) => Promise<void>;
let deletedHook: DeletedHook | undefined;
/** The agent-deployments feature drops a deleted agent's deployment rows. */
export function setUserAgentDeletedHook(fn: DeletedHook | undefined): void {
  deletedHook = fn;
}

/** ADR 1014 P5 — a deleted user agent leaves nothing runnable behind. */
export async function onUserAgentDeleted(tenant: string, agentId: string): Promise<void> {
  await purgeUserAgentRevisions(tenant, agentId);
  if (deletedHook) await deletedHook(tenant, agentId);
}

/** ADR 1014 P5 — a deleted agent's revisions go with it (its prompts are tenant IP). */
export async function purgeUserAgentRevisions(tenant: string, agentId: string): Promise<void> {
  const head = await readHead(tenant, agentId);
  for (const row of await revisions.listByPrefix(`${tenant}::${agentId}::`)) {
    if (row.tenantId === tenant && row.agentId === agentId) await revisions.compareAndDelete(row);
  }
  if (head) await heads.compareAndDelete(head);
}

/**
 * ADR 1014 D8 / ADR 0464 — DSAR subject-eraser for the text a person typed into a
 * user agent. A revision the subject authored is DELETED (its prompt, persona,
 * label and description go with it), unless the agent is serving it: the head
 * revision, or one a deployment row names. Deleting those would break a live
 * agent the tenant still runs, so they keep their text and only `authoredBy` is
 * redacted. The live agent row has no author field, so it is not touched.
 * When the pinned set cannot be read, every row is treated as serving: the
 * eraser redacts and keeps rather than delete a revision a deployment may serve.
 *
 * A deployment can pin a revision while this runs. So the serving set is read
 * just before each row, and again after a delete: a revision pinned in between
 * is put back, redacted. Only a pin made after that second read can still find
 * its revision gone, and it then fails closed (`agent_version_unavailable`).
 */
export async function eraseSubjectUserAgentRevisions(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  let rowsTouched = 0;
  if (!tenantId || !subjectKey) return { rowsTouched };
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await revisions.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId || !row.authoredBy || !forms.has(row.authoredBy)) continue;
    const redacted: RevisionRow = { ...row, authoredBy: ERASED };
    let ok: boolean;
    if (isServing(await servingRevisions(tenantId, row.agentId), row.revision)) {
      ok = await revisions.compareAndSwap(row, redacted);
    } else {
      ok = await revisions.compareAndDelete(row);
      if (ok && isServing(await servingRevisions(tenantId, row.agentId), row.revision)) await revisions.putIfAbsent(redacted);
    }
    if (ok) rowsTouched += 1;
  }
  return { rowsTouched };
}

function isServing(keep: ReadonlySet<string> | null, revision: number): boolean {
  return keep === null || keep.has(String(revision));
}

/** The head plus every pinned revision; null when the pins cannot be read. */
async function servingRevisions(tenant: string, agentId: string): Promise<ReadonlySet<string> | null> {
  try {
    const out = new Set(pinned ? await pinned(tenant, agentId) : []);
    out.add(await currentRevision(tenant, agentId));
    return out;
  } catch {
    return null;
  }
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerUserAgentRevisionErasure(): void {
  registerSubjectEraser(eraseSubjectUserAgentRevisions);
}

async function pruneRevisions(tenant: string, agentId: string, newest: number): Promise<void> {
  const floor = newest - REVISION_KEEP_NEWEST;
  if (floor < 0) return;
  let keep: ReadonlySet<string> = new Set();
  try {
    keep = pinned ? await pinned(tenant, agentId) : new Set();
  } catch {
    return; // unknown pins: keep everything rather than delete a rollback target
  }
  for (let r = 0; r <= floor; r += 1) {
    if (keep.has(String(r))) continue;
    const row = await revisions.get(`${tenant}::${agentId}::${r}`);
    if (row) await revisions.compareAndDelete(row);
  }
}
