/**
 * RFC 0059 — agent workspace (DURABLE, tenant/workspace-scoped file layer).
 *
 * A named, versioned file store that sits alongside the transactional memory
 * layer (RFC 0004). Files are owner-scoped to a {tenant, workspace} pair
 * (RFC 0048); writes are atomic with optimistic concurrency (If-Match etag),
 * size-bounded (maxFileBytes), and SR-1-redacted on write (WSR-1).
 *
 * Invariants:
 *   - WCT-1 (cross-tenant isolation): every file is keyed by its owner; no
 *     read/list against {T, W} can ever surface a file owned by
 *     {T2, W2} != {T, W}, regardless of the caller's permissions elsewhere
 *     (SECURITY/invariants.yaml `workspace-cross-tenant-isolation`).
 *   - WSR-1 (secret redaction): content is routed through the SR-1 harness on
 *     write so a stored file never persists secret-shaped plaintext.
 *
 * DURABLE as of ADR 0551 P0 — backed by `Storage` (`workspace_files`, sqlite
 * mig 38 / postgres mig 36), keyed on the RFC 0048 owner triple plus path.
 *
 * It was previously a module-scope `Map`, and this header claimed "durable"
 * fifteen lines above the paragraph admitting it was not. That gap mattered:
 * `spec/v1/agent-workspace.md` §9 requires that "a run replayed on another host
 * MUST observe the same workspace snapshot", which a process-local Map fails
 * even on a SINGLE instance — the guarantee is about portability across hosts,
 * not concurrency within one. The `If-Match` CAS was also instance-local, so
 * two Cloud Run instances could each believe they had won the same
 * compare-and-set.
 *
 * Every function now takes `Storage` as its first argument rather than reaching
 * for module state. That is what makes the owner triple a database key instead
 * of a lookup in a per-process object.
 *
 * @see RFCS/0059-agent-workspace.md (sections C/D/E)
 * @see spec/v1/agent-workspace.md
 */

import { createHash } from 'node:crypto';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import type { Storage } from '../storage/storage.js';

/** Per-file byte ceiling — mirrors the advertised
 *  `capabilities.workspace.maxFileBytes`. */
export const WORKSPACE_MAX_FILE_BYTES = 64 * 1024;

export interface WorkspaceFile {
  path: string;
  content: string;
  contentType: string;
  version: number;
  etag: string;
  updatedAt: string;
}

/** Metadata view (list) — content omitted per the spec's list endpoint. */
export type WorkspaceFileMeta = Omit<WorkspaceFile, 'content'>;

export interface WorkspaceFileRow {
  path: string;
  content: string;
  contentType: string;
  version: number;
  etag: string;
  sizeBytes: number;
  updatedAt: string;
}

/**
 * The etag, DERIVED FROM CONTENT — never random.
 *
 * This used to be `` `"${version}-${Math.random().toString(36).slice(2,8)}"` ``.
 * Two problems with that, both real:
 *
 *  1. **It broke replay.** RFC 0059 exposes a workspace snapshot at
 *     `run.started` and `spec/v1/agent-workspace.md` makes that snapshot a
 *     replay-determinism guarantee. An etag containing `Math.random()` differs
 *     on every write of identical content, so the snapshot could never be
 *     reproduced — the guarantee was unmeetable by construction.
 *  2. **It made the etag meaningless as an identifier.** An etag is supposed to
 *     identify a representation; a random one only identifies a write event.
 *
 * Version is mixed in alongside the digest so that a file reverted to earlier
 * content still gets a distinct etag — otherwise an If-Match built against v1
 * would spuriously match v3 with the same bytes, and the CAS would let a
 * genuinely stale writer through.
 */
export function workspaceEtag(version: number, content: string): string {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return `"${version}-${digest}"`;
}

/** H27-b — the refusal arms carry `message` because the canonical error envelope
 *  REQUIRES it (`schemas/error-envelope.schema.json`). The route used to emit
 *  `{ error, details }` with no message at all, so a 409 conflict and a 413
 *  over-size were equally unexplained; the store is the only place that knows
 *  which happened, so the sentence belongs here rather than being re-derived
 *  from the code at the route. */
export type PutOutcome =
  | { ok: true; file: WorkspaceFile }
  | { ok: false; status: 409; error: 'workspace_conflict'; message: string; details: { currentVersion: number } }
  | { ok: false; status: 413; error: 'workspace_too_large'; message: string; details: { maxBytes: number; providedBytes: number } };

/**
 * Atomic create/replace. Honors If-Match; enforces maxFileBytes; bumps
 * version + etag; SR-1-redacts content (WSR-1).
 *
 * The size check happens BEFORE the redaction and before storage is touched:
 * `workspace_too_large` is about what the caller sent, so redaction (which can
 * only shrink content) must not be able to turn a rejected write into an
 * accepted one.
 */
export async function putWorkspaceFile(
  storage: Storage,
  tenant: string,
  workspace: string,
  path: string,
  input: { content: string; contentType?: string; ifMatch?: string },
): Promise<PutOutcome> {
  const providedBytes = Buffer.byteLength(input.content, 'utf8');
  if (providedBytes > WORKSPACE_MAX_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'workspace_too_large',
      message: `The file is ${providedBytes} bytes; this workspace caps files at ${WORKSPACE_MAX_FILE_BYTES}.`,
      details: { maxBytes: WORKSPACE_MAX_FILE_BYTES, providedBytes },
    };
  }
  const outcome = await storage.putWorkspaceFile({
    tenantId: tenant,
    workspaceId: workspace,
    path,
    // WSR-1 — redact secret-shaped plaintext before it persists.
    content: sanitizeFreeText(input.content),
    contentType: input.contentType ?? 'text/markdown',
    etagFor: workspaceEtag,
    ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {}),
    updatedAt: new Date().toISOString(),
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: 409,
      error: 'workspace_conflict',
      message: 'The file changed since the version you supplied in If-Match.',
      details: { currentVersion: outcome.currentVersion },
    };
  }
  return { ok: true, file: toFile(outcome.row) };
}

function toFile(r: WorkspaceFileRow): WorkspaceFile {
  return {
    path: r.path,
    content: r.content,
    contentType: r.contentType,
    version: r.version,
    etag: r.etag,
    updatedAt: r.updatedAt,
  };
}

/** Read one file (latest), or null when absent for THIS owner (WCT-1). */
export async function getWorkspaceFile(
  storage: Storage,
  tenant: string,
  workspace: string,
  path: string,
): Promise<WorkspaceFile | null> {
  const row = await storage.getWorkspaceFile(tenant, workspace, path);
  return row ? toFile(row) : null;
}

/** List file metadata (no bodies) for THIS owner, optionally prefix-filtered. */
export async function listWorkspaceFiles(
  storage: Storage,
  tenant: string,
  workspace: string,
  prefix?: string,
): Promise<WorkspaceFileMeta[]> {
  const rows = await storage.listWorkspaceFiles(tenant, workspace, prefix);
  return rows.map((r) => ({
    path: r.path,
    contentType: r.contentType,
    version: r.version,
    etag: r.etag,
    updatedAt: r.updatedAt,
  }));
}

/** Delete a file. Returns true when a file existed (so the route can 404). */
export async function deleteWorkspaceFile(
  storage: Storage,
  tenant: string,
  workspace: string,
  path: string,
): Promise<boolean> {
  return storage.deleteWorkspaceFile(tenant, workspace, path);
}
