/**
 * Issue #4543 (DSHCD-9) — who may read a run's PAYLOAD on the snapshot reads.
 *
 * `runs:read` lets every workspace member list and open runs, and Viewer holds
 * it. Before this, the list and the snapshot carried what the run was STARTED
 * WITH and what it holds (inputs, variables, channels) for every one of them,
 * so a fired scheduled chat's prompt reached any member of the workspace.
 *
 * The rule, decided once per request:
 *   - a wildcard principal (operator / conformance), the caller's own personal
 *     workspace, and a tenant where membership does not define presence (a
 *     deployment-named tenant with RFC 0049 enforcement off: nobody to isolate
 *     from) read every payload;
 *   - otherwise an ADMIN of the tenant (`host:members:manage`, the scope that
 *     separates Admin from Editor) reads every payload;
 *   - anyone else reads the payload only of a run THEY started (the RFC 0165
 *     owner stamp, compared through the same opaque projection `ownRuns.ts`
 *     uses). A run with no owner stamp (host-fired) is nobody's: admins only.
 *
 * The status, timing, error and owner fields stay: they are what a member
 * needs to see that a run exists and how it went. All four withheld fields are
 * optional in both snapshot schemas, so the projection stays valid on the wire.
 */
import type { Request } from 'express';
import type { RunRecord } from '../types.js';
import { opaquePrincipal, runOwner } from './runOwner.js';
import { callerSubject, isOwnPersonalWorkspace, tenantOf } from './requestSubject.js';
import { membershipDefinesPresence } from './accessControlService.js';
import { decideProtocolAuthorization } from './protocolAuthorization.js';
import { runStreamTokenGrant } from './runStreamToken.js';

/** The snapshot fields that carry a run's payload. */
export const RUN_PAYLOAD_FIELDS = ['inputs', 'variables', 'channels', 'configurable'] as const;

/** Decide, once per request, which runs in `tenantId` the caller may read the
 *  payload of. Defaults to the caller's active tenant. */
export async function runPayloadReader(req: Request, tenantId: string = tenantOf(req)): Promise<(run: Pick<RunRecord, 'tenantId' | 'metadata'>) => boolean> {
  if (req.principal?.tenants?.includes('*')) return () => true;
  if (isOwnPersonalWorkspace(req) && tenantId === tenantOf(req)) return () => true;
  if (!membershipDefinesPresence(tenantId)) return () => true;
  const subject = callerSubject(req);
  if ((await decideProtocolAuthorization(tenantId, subject, 'host:members:manage')).allowed) return () => true;
  const me = subject !== undefined ? opaquePrincipal(subject) : undefined;
  return (run) => me !== undefined && runOwner(run)?.principal === me;
}

/** A copy of `snapshot` without the payload fields. */
export function withoutRunPayload<T extends object>(snapshot: T): T {
  const out = { ...snapshot } as Record<string, unknown>;
  for (const k of RUN_PAYLOAD_FIELDS) delete out[k];
  return out as T;
}

/**
 * The same rule for ONE run, as the run-event reads decide it (the SSE stream,
 * its JSON sibling, the poll and the debug bundle). A request authorized by a
 * `?streamToken` is decided by the GRANT the token carries: the cross-origin
 * stream arrives on a fresh anonymous session, so the minting caller's identity
 * is not there to re-check, and the mint endpoint already decided it with this
 * same function. The order matches `runAccess.loadReadableRun`, which admits a
 * verifying token before it looks at the session.
 */
export async function mayReadRunPayload(req: Request, run: Pick<RunRecord, 'runId' | 'tenantId' | 'metadata'>): Promise<boolean> {
  const token = typeof req.query?.streamToken === 'string' ? req.query.streamToken : undefined;
  const grant = token !== undefined ? runStreamTokenGrant(run.runId, token) : null;
  if (grant !== null) return grant === 'full';
  return (await runPayloadReader(req, run.tenantId))(run);
}

/**
 * The payload keys an event keeps for a member who may not read the run's
 * payload: what says WHICH step moved and HOW it went, never what it was given or
 * produced. An allowlist, so an event type added later is withheld by default.
 * `error` keeps only `code` and `message`, the same fields the snapshot shows
 * that member.
 */
const EVENT_PAYLOAD_KEEP = ['workflowId', 'nodeId', 'nodeType', 'status', 'attempt', 'durationMs'] as const;

/** A copy of `event` whose payload holds only {@link EVENT_PAYLOAD_KEEP} (and the
 *  error's code and message). A non-object payload becomes `{}`. The v2 envelope
 *  types `payload` as any JSON value, so the event stays valid on the wire. */
export function withoutEventPayload<T extends { payload: unknown }>(event: T): T {
  const p = event.payload;
  const kept: Record<string, unknown> = {};
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const src = p as Record<string, unknown>;
    for (const k of EVENT_PAYLOAD_KEEP) if (k in src) kept[k] = src[k];
    const err = src.error;
    if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
      const e = err as Record<string, unknown>;
      kept.error = {
        ...(typeof e.code === 'string' ? { code: e.code } : {}),
        ...(typeof e.message === 'string' ? { message: e.message } : {}),
      };
    }
  }
  return { ...event, payload: kept };
}
