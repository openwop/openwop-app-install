/**
 * Sub-run dispatcher used by the chat responder when an LLM tool call
 * invokes a saved workflow. Posts to `/v1/runs` on this same host and
 * polls the snapshot endpoint until the run reaches a terminal status
 * (completed / failed / cancelled) or the budget elapses. Interrupts
 * count as "pending" — the budget is exhausted, the LLM gets a stub
 * tool_result, and the human can resume from /runs/:id.
 *
 * Localhost round-trip: ~1ms, so the cost is acceptable. The alternative
 * (importing executeRun + plumbing storage / hostSuite into nodes via
 * a new singleton) is intrusive enough that we defer it until there's
 * a non-sample driver for it.
 */

import { createLogger } from '../observability/logger.js';

const log = createLogger('subRunDispatcher');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 250;

/**
 * Resolve the bearer the dispatcher presents on the internal `/v1/runs`
 * round-trip. Precedence:
 *   1. `OPENWOP_INTERNAL_TOKEN` — an explicit service-principal token.
 *   2. A configured API key (`OPENWOP_API_KEYS` / `OPENWOP_API_KEY`) — the
 *      same allow-list the auth middleware trusts, so the call authenticates
 *      without a second credential to provision.
 *
 * When NEITHER is set we FAIL CLOSED only under explicit bearer enforcement
 * (`OPENWOP_AUTH_ENFORCE_BEARER=true`) rather than fall back to a guessable
 * literal — there a real service principal MUST be provisioned. A plain
 * `NODE_ENV=production` cookie-per-visitor deploy is NOT bearer-enforcing, so
 * the dev literal survives there (it isn't honored as a wildcard API key in
 * prod regardless — readValidKeys withdraws it — so the round-trip falls
 * through to an anonymous principal, exactly as before this hardening).
 */
export function resolveInternalToken(): string {
  const explicit = process.env.OPENWOP_INTERNAL_TOKEN;
  if (explicit && explicit.length > 0) return explicit;
  const apiKeys = process.env.OPENWOP_API_KEYS ?? process.env.OPENWOP_API_KEY;
  const firstKey = apiKeys?.split(',').map((s) => s.trim()).find((s) => s.length > 0);
  if (firstKey) return firstKey;
  // Fail closed ONLY when the deploy explicitly enforces bearer auth
  // (OPENWOP_AUTH_ENFORCE_BEARER=true) — there a guessable literal is a real
  // hole and a real service principal MUST be provisioned. A plain
  // NODE_ENV=production COOKIE-per-visitor demo (anonymous cookies allowed, no
  // bearer enforcement) is NOT enforcing auth: there the dev literal is the
  // intended internal round-trip token and throwing would break sub-run
  // dispatch. (`dev-token` isn't honored as a wildcard API key in prod anyway —
  // readValidKeys withdraws it — so the sub-run falls through to anon.)
  if (process.env.OPENWOP_AUTH_ENFORCE_BEARER === 'true') {
    throw new Error(
      'sub-run dispatch requires a service credential: set OPENWOP_INTERNAL_TOKEN (or OPENWOP_API_KEYS) — refusing to fall back to a guessable literal under OPENWOP_AUTH_ENFORCE_BEARER',
    );
  }
  return 'dev-token';
}

export interface SubRunRequest {
  workflowId: string;
  inputs: unknown;
  budgetMs: number;
  /** Tenant of the calling chat run. The sub-run inherits this so
   *  the LLM can't escalate across tenants by invoking another
   *  tenant's workflows. Real hosts MUST pass through the caller's
   *  principal+tenant; the sample's authorizer happens to allow `*`
   *  but that's not the contract. */
  tenantId: string;
  scopeId?: string;
  /** ADR 0133 — the run whose tool-call spawned this sub-run + the delegating
   *  subject (`agent:<id>`). Stamped into the child's `run.metadata` so the task
   *  deck (Phase 2 projection) can group delegated children under their parent.
   *  Non-secret identifiers; absent ⇒ no linkage (the deck shows it ungrouped). */
  parentRunId?: string;
  delegatedBy?: string;
}

export type SubRunResult =
  | { status: 'completed'; runId: string; output: unknown }
  | { status: 'failed'; runId: string; error: { code?: string; message?: string } }
  | { status: 'pending'; runId: string; budgetMs: number };

interface CreateRunResponse {
  runId: string;
  status: string;
  eventsUrl?: string;
  statusUrl?: string;
}

interface RunSnapshot {
  runId: string;
  status: string;
  error?: { code?: string; message?: string };
}

export async function dispatchSubRun(req: SubRunRequest): Promise<SubRunResult> {
  const baseUrl = process.env.OPENWOP_INTERNAL_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
  // Resolve a real service credential (fails closed under enforced auth
  // instead of presenting a guessable literal — see resolveInternalToken).
  const token = resolveInternalToken();

  const createRes = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflowId: req.workflowId,
      tenantId: req.tenantId,
      ...(req.scopeId ? { scopeId: req.scopeId } : {}),
      inputs: req.inputs,
      // ADR 0133 — parent-run linkage in the child's run.metadata (POST /v1/runs
      // spreads body.metadata). Only emitted when present, so the create body is
      // unchanged for callers that don't link.
      ...((req.parentRunId || req.delegatedBy)
        ? { metadata: {
            ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
            ...(req.delegatedBy ? { delegatedBy: req.delegatedBy } : {}),
          } }
        : {}),
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    return {
      status: 'failed',
      runId: '',
      error: { code: 'sub_run_create_failed', message: `${createRes.status}: ${text.slice(0, 300)}` },
    };
  }
  const created = (await createRes.json()) as CreateRunResponse;
  const runId = created.runId;

  const deadline = Date.now() + req.budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let snap: RunSnapshot;
    try {
      const res = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      snap = (await res.json()) as RunSnapshot;
    } catch (err) {
      log.warn('subrun_poll_failed', { runId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!TERMINAL.has(snap.status)) continue;
    if (snap.status === 'completed') {
      // Fetch the final run.completed event to recover the output.
      try {
        const evRes = await fetch(`${baseUrl}/v1/runs/${runId}/events/poll?limit=1000`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (evRes.ok) {
          const body = (await evRes.json()) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
          const completed = body.events.find((e) => e.type === 'run.completed');
          const output = completed?.payload?.output ?? null;
          return { status: 'completed', runId, output };
        }
      } catch {
        /* fall through to no-output completion */
      }
      return { status: 'completed', runId, output: null };
    }
    return {
      status: 'failed',
      runId,
      error: snap.error ?? { code: snap.status, message: `run terminated with status ${snap.status}` },
    };
  }
  // Budget exhausted; run may be still executing or paused on an interrupt.
  return { status: 'pending', runId, budgetMs: req.budgetMs };
}
