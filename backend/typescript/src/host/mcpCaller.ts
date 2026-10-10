/**
 * ADR 0788 D1 — WHO is asking an MCP question, resolved ONCE per HTTP request.
 *
 * Every MCP lane that decides what a caller may see or run (`tools/list`,
 * `tools/call`, resources, prompts, the legacy handler bridges, and the RFC
 * 0078 `/v1/tools` catalog) takes one of these instead of re-deriving tenant
 * and authority from the principal id.
 *
 * Two facts, and why each is spelled the way it is:
 *
 *  - `tenantId` is `tenantOf(req)`. For every non-wildcard credential lane it
 *    equals `principal.tenants[0]` (`middleware/auth.ts`); for a wildcard
 *    operator key it is `'default'`, which is exactly where `POST /workflows`
 *    records that caller's ownership. Keying off `principal.tenants[0]` instead
 *    gave wildcard keys no workspace at all, which is what the conformance
 *    harness authenticates with (architect B1).
 *  - `workspaceLaunch` is the predicate that let a workflow be AUTHORED in that
 *    tenant (`requireWorkflowWrite`, provenance-classified), plus the
 *    `runs:create` narrowing an `owk_` key's declaration imposes on HTTP launch
 *    (`routes/runs.ts`). An MCP call into a workspace-owned workflow is a launch
 *    of an arbitrary tenant workflow, so it takes both (architect B4).
 */
import type { Request } from 'express';
import { OpenwopError, type Principal } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { tenantOf } from './requestSubject.js';
import { requireWorkflowWrite } from './workflowWriteAuthority.js';
import { keyDeclarationPermits } from './protocolAuthorization.js';
import { resolveLaunchWorkflow, type LaunchResolvedWorkflow } from './resolveLaunchDefinition.js';
import { WorkflowFeatureRefusedError } from './workflowFeatureGate.js';

export interface McpCaller {
  principal: Principal | undefined;
  /** The ONE tenant every MCP decision for this request is made in. */
  tenantId: string;
  /** May this caller launch the tenant's OWN (workspace-owned) MCP workflows? */
  workspaceLaunch: boolean;
  /** The launch resolution a call would run (published-when-present). */
  resolveLaunch(workflowId: string): Promise<LaunchResolvedWorkflow | null>;
}

type Catalog = { getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> };

/** Does `req` carry authority to launch this tenant's own workflows? Never
 *  throws: a refusal is `false`, so the caller simply sees no workspace entries. */
export async function workspaceLaunchAllowed(req: Request): Promise<boolean> {
  try {
    await requireWorkflowWrite(req);
  } catch (err) {
    if (err instanceof OpenwopError && (err.httpStatus === 401 || err.httpStatus === 403)) return false;
    throw err;
  }
  const auth = req.principal?.auth;
  if (auth?.kind === 'api-key' && !keyDeclarationPermits(auth.scopes, 'runs:create')) return false;
  return true;
}

export async function mcpCallerFor(req: Request, principal: Principal | undefined, catalog: Catalog): Promise<McpCaller> {
  const tenantId = tenantOf(req);
  return {
    principal,
    tenantId,
    workspaceLaunch: principal ? await workspaceLaunchAllowed(req) : false,
    // ADR 0820 §7 / G6 — a workflow whose owning feature the tenant may not use
    // is not a tool for it: the enumeration skips it (null), it never throws.
    resolveLaunch: (workflowId) => resolveLaunchWorkflow(catalog, tenantId, workflowId).catch((err: unknown) => {
      if (err instanceof WorkflowFeatureRefusedError) return null;
      throw err;
    }),
  };
}
