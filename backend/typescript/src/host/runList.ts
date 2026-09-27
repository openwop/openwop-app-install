/**
 * RFC 0182 `listRuns` (ADR 0658) — the `runList` family's facets and the
 * host-minted page cursor.
 *
 * ONE owner for the advertised numbers: `routes/discovery.ts` advertises
 * `RUN_LIST` and `routes/runs.ts` enforces it, so the wire claim and the
 * behaviour cannot drift apart (the ADR 0435/0440 shape).
 *
 * The cursor is a keyset (the last item's `createdAt` + `runId`, which the
 * storage order `created_at DESC, run_id DESC` makes total) signed with the
 * session secret. runs.md §List: a cursor the host did not mint is
 * `400 validation_error` — so the signature is the whole point; an
 * attacker-composed keyset would otherwise let a caller page from an
 * arbitrary point, which is harmless for a tenant-scoped list but is exactly
 * the "cursor you did not mint" the spec forbids.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../middleware/cookieSession.js';

export const RUN_LIST = {
  maxPageSize: 100,
  defaultPageSize: 50,
  filters: ['workflowId', 'status'] as const,
} as const;

export interface RunListKey {
  readonly createdAt: string;
  readonly runId: string;
}

const PREFIX = 'runlist:v1:';

function sign(payload: string): string {
  return createHmac('sha256', readSessionSecret()).update(`${PREFIX}${payload}`).digest('base64url');
}

export function mintRunListCursor(key: RunListKey): string {
  const payload = Buffer.from(JSON.stringify([key.createdAt, key.runId]), 'utf8').toString('base64url');
  return `v1.${payload}.${sign(payload)}`;
}

/** `null` = not a cursor this host minted (malformed, foreign, or tampered). */
export function parseRunListCursor(cursor: string): RunListKey | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 2048) return null;
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [createdAt, runId] = decoded as [unknown, unknown];
    if (typeof createdAt !== 'string' || typeof runId !== 'string' || createdAt.length === 0 || runId.length === 0) return null;
    return { createdAt, runId };
  } catch {
    return null;
  }
}
