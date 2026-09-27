/**
 * Interrupt-resolution client. Wraps the OpenwopClient surface +
 * provides a token-inspect convenience used by deep-link UIs.
 */

import { getSdkClient, bound } from './runsClient.js';
import { unbindRunIds } from './v2Wire.js';
import { authedHeaders, config, fetchOpts } from './config.js';
import { ApiError } from './requestJson.js';
import type { InterruptByTokenInspection, ResolveInterruptResponse } from '@openwop/openwop';

/** Resolve an interrupt by run+node. Returns the resolve response body so a
 *  conversation-exchange caller can read the host-internal advisory fields the
 *  backend attaches to it (e.g. ADR 0173's `notice`); non-exchange callers
 *  ignore it. */
export async function resolveByRun(runId: string, nodeId: string, resumeValue: unknown): Promise<ResolveInterruptResponse> {
  return getSdkClient().interrupts.resolveByRun(await bound(runId), nodeId, { resumeValue });
}

export async function resolveByToken(token: string, resumeValue: unknown): Promise<void> {
  await getSdkClient().interrupts.resolveByToken(token, { resumeValue });
}

/** Re-exported from the SDK so call sites can import a single name from
 *  this module without also reaching into `@openwop/openwop` for the type. */
export type InterruptInspection = InterruptByTokenInspection;

export async function inspectByToken(token: string): Promise<InterruptInspection> {
  // A major-2 SDK read: routed through the one unbind seam like every other
  // (`runsClient`). `InterruptByTokenInspection` carries no bound id today; the
  // seam is here so a field the corpus adds is unbound the day it appears
  // (ADR 0723 widened the predicate to every tenant-bound kind).
  return unbindRunIds(await getSdkClient().interrupts.inspectByToken(token));
}

export interface OpenInterrupt {
  interruptId: string;
  nodeId: string;
  /** Open-ended per `spec/v1/interrupt.md` so new kinds (e.g. `low-confidence`,
   *  `conversation.start` / `.exchange` / `.close`) reach the frontend without
   *  a coordinated SDK + host bump. Consumers narrow as needed. */
  kind:
    | 'approval'
    | 'clarification'
    | 'refinement'
    | 'cancellation'
    | 'low-confidence'
    | 'conversation.start'
    | 'conversation.exchange'
    | 'conversation.close'
    | (string & {});
  token?: string;
  data: unknown;
  resumeSchema?: Record<string, unknown>;
  createdAt: string;
}

/** Authenticated list of open interrupts for a run — needed because the
 *  public event log no longer carries the resume token. Vendor-
 *  prefixed under /host/openwop-app/* per host-extensions.md (strong
 *  candidate for future RFC promotion). */
export async function listOpenInterrupts(runId: string): Promise<readonly OpenInterrupt[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/runs/${encodeURIComponent(runId)}/interrupts`, fetchOpts({
    headers: authedHeaders(),
  }));
  if (!res.ok) throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `listOpenInterrupts returned ${res.status}` });
  const body = (await res.json()) as { interrupts: OpenInterrupt[] };
  return body.interrupts;
}
