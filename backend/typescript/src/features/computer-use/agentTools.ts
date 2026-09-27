/**
 * Computer-use chat tool (CFP-1 repair; ADR 0308 D2 seam) — the read grounding
 * for the Browser Operator agent. The pack formerly allowlisted the workflow node
 * typeIds `feature.computer-use.nodes.task` / `decide` / `status`, none of which
 * project into a conversational tool (CFP-1). Of those three, only a STATUS READ
 * is safe as a chat tool: starting a task and deciding a commit-tier action MUST
 * ride the governed executor + `core.approvalGate` HITL path (a workflow run) —
 * projecting them as naive chat tools would fork execution AND bypass the human
 * approval halts (ADR 0418). So `task`/`decide` are PRUNED from the allowlist
 * (they stay on the governed run path) and only `openwop:computer-use.status` is
 * registered here, over the same `sessionStore` reads the routes expose.
 *
 * Authority parity (hard rule #1): resolves org scope through the same `listOrgs`
 * + `resolveEffectiveAccess('workspace:read')` predicate the computer-use routes
 * enforce via `authorizeOrgScope`. Read posture: FAIL EMPTY. Approval gating is
 * untouched — this tool only observes the recorded trajectory, it drives nothing.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listSessions, getSession, type CuSession } from './sessionStore.js';

export const COMPUTER_USE_STATUS_TOOL_ID = 'openwop:computer-use.status';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Read-safe projection of a governed session (mirrors the sessions-list route):
 *  the recorded trajectory + status, mock task masked, no internal ids. */
function project(s: CuSession): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    status: s.status,
    task: s.task.startsWith('mock:') ? '(mock script)' : s.task,
    startUrl: s.startUrl,
    steps: s.steps.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(s.pendingAction ? { pendingAction: s.pendingAction } : {}),
    ...(s.resultSummary ? { resultSummary: s.resultSummary } : {}),
    ...(s.error ? { error: s.error } : {}),
  };
}

async function computerUseEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('computer-use', scope);
}

async function resolveReadOrg(
  scope: BundleScope,
  orgIdInput: string | undefined,
): Promise<{ orgId: string } | { note: string }> {
  if (!scope.actingUserId) return { note: 'This tool only reads from a human-initiated turn.' };
  if (!(await computerUseEnabled(scope))) return { note: 'The Computer Use feature is not enabled for this workspace.' };
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { note: `This workspace has ${orgs.length} organizations — pass \`orgId\`.` };
  if (!orgs.some((o) => o.orgId === orgId)) return { note: 'Organization not found in this workspace.' };
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: scope.actingUserId, orgId });
  if (!access.scopes.includes('workspace:read')) return { note: 'You do not have read access to that organization.' };
  return { orgId };
}

export function registerComputerUseAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: COMPUTER_USE_STATUS_TOOL_ID,
      description:
        'Read the status of governed browser sessions — steps taken, current status (running / awaiting_approval / '
        + 'completed / failed / denied), any pending commit-tier action, and result/error. Pass `sessionId` for one '
        + 'session, or omit it to list the org\'s sessions. Read-only: it never starts a task or approves an action.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional: one session to report on. Omit to list the org\'s sessions.' },
          orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveReadOrg(scope, str(input.orgId));
      if ('note' in resolved) return { content: JSON.stringify({ sessions: [], note: resolved.note }) };
      const sessionId = str(input.sessionId);
      if (sessionId) {
        const s = await getSession(scope.tenantId, sessionId);
        if (!s || s.orgId !== resolved.orgId) return { content: JSON.stringify({ sessions: [], note: 'Session not found in this organization.' }) };
        return { content: JSON.stringify({ sessions: [project(s)] }) };
      }
      const rows = (await listSessions(scope.tenantId)).filter((s) => s.orgId === resolved.orgId);
      return { content: JSON.stringify({ sessions: rows.map(project) }) };
    },
  });
}
