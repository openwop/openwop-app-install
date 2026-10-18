import { projectBoundId } from './boundIdProjection.js';
import { toWireRunId } from './v2Ids.js';

/**
 * The `eventsUrl` / `statusUrl` a run-creating response carries — ONE builder for
 * `POST /runs` (workflow and eval branches) and `:fork`, so the v1→v2 move
 * (ADR 0812) edits one line, not one per branch.
 *
 * ADR 0812 P4 slice 2b — minted in their FINAL major-2 form: unversioned, with
 * the tenant-bound id projected exactly as `projectV2RunIds` projects it
 * (`identity.md` §5, RFC 0184 §A.1). Until this slice the builder minted
 * `/v1/runs/<bare id>` and relied on the response projector rewriting it.
 * `tenant` MUST be the tenant the projector binds with (`req.tenantId ??
 * 'default'`), so the URL's id equals the response's `runId`.
 *
 * Idempotency-ledger rows written before this slice hold `/v1/runs/<bare id>`;
 * a replay re-mints its links here (`remintRunWireUrls`), so no response path
 * rewrites a URL after the fact (the projector's leg was deleted, ADR 0812 P4
 * slice 4).
 */
export function runWireUrls(origin: string, runId: string, tenant: string): { eventsUrl: string; statusUrl: string } {
  const base = `${origin}/runs/${projectBoundId(toWireRunId(runId, tenant))}`;
  return { eventsUrl: `${base}/events`, statusUrl: base };
}

/**
 * ADR 0812 P4 slice 4 — a `POST /runs` idempotency REPLAY re-mints its links from
 * the stored `runId`, instead of serving the URLs stored with the first answer.
 * Rows written before slice 2b hold `/v1/runs/<bare id>`, which answers 410 since
 * the cut; a row written since gets the same URL back. Only a stored body that
 * already carries the links is touched, and the stored `runId` is bare (the
 * ledger holds the handler's response before the major-2 projection).
 */
export function remintRunWireUrls(body: unknown, origin: string, tenant: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (typeof b['runId'] !== 'string' || (!('statusUrl' in b) && !('eventsUrl' in b))) return body;
  return { ...b, ...runWireUrls(origin, b['runId'], tenant) };
}
