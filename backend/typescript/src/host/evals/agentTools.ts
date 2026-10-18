/**
 * ADR 0889 D8 — chat reach for agent evals (ADR 0058 "chat-drivability = agent + nodes").
 *
 * Three feature tools, registered but NOT in the ADR 0315 default-on baseline:
 * an agent gets them only when its pack allowlists them.
 *   - `openwop:agent-evals.list-suites` (read)  — the tenant's suites, optionally for one agent
 *   - `openwop:agent-evals.run`         (write) — start an eval run (spends model calls ⇒
 *                                                  safe-mode approval)
 *   - `openwop:agent-evals.get-summary` (read)  — an eval run's content-free scorecard
 *
 * Authority is the run's tenant, and every tool fails EMPTY/closed without an
 * acting user (the ADR 0308 rule). The data shaping is the SAME code the HTTP
 * routes use (`listResolvableSuites`, `createAgentEvalRun`, `metadata.evalSummary`),
 * so a tool and its route cannot drift.
 */
import { registerFeatureAgentTool } from '../agentToolProvider.js';
import type { BundleScope } from '../inMemorySurfaces.js';
import { hostExtStorage } from '../hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { suiteRef } from './suiteStore.js';
import { listResolvableSuites } from './packSuites.js';
import { createAgentEvalRunOnce } from './createEvalRun.js';
import { isAgentEvalRun } from './agentEvalRun.js';
import { storedRunId } from './runIds.js';
import { agentEvalsToolGate } from './access.js';
import { OWNER_METADATA_KEY, type RunOwnerStamp } from '../runOwner.js';
import { createHash } from 'node:crypto';


export const AGENT_EVALS_LIST_SUITES_TOOL_ID = 'openwop:agent-evals.list-suites';
export const AGENT_EVALS_RUN_TOOL_ID = 'openwop:agent-evals.run';
export const AGENT_EVALS_GET_SUMMARY_TOOL_ID = 'openwop:agent-evals.get-summary';

const fail = (error: string, message: string) => ({ content: JSON.stringify({ error, message }), isError: true as const });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function registerAgentEvalTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted', // suite ids/refs are member-authored text — fenced, not added to the trusted set
    effect: 'read',
    def: {
      name: AGENT_EVALS_LIST_SUITES_TOOL_ID,
      description: 'List this workspace\'s agent eval suites (ref, target agent, task count, trials, whether it has been run). '
        + 'Read this BEFORE starting an eval run, to pick a suite ref. Read-only.',
      inputSchema: { type: 'object', properties: { agentId: { type: 'string', description: 'Only suites for this agent id.' } }, additionalProperties: false },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ items: [] }) };
      // Review M3/H1 — the route's predicate (evals enabled + workspace:read); fails EMPTY.
      if (await agentEvalsToolGate(scope, 'workspace:read')) return { content: JSON.stringify({ items: [] }) };
      const agentId = str(input.agentId);
      const rows = await listResolvableSuites(scope.tenantId, agentId);
      return {
        content: JSON.stringify({
          items: rows.map((r) => ({
            ref: suiteRef(r.suite), targetAgentId: r.suite.targetAgentId ?? null, modes: r.suite.modes,
            taskCount: r.suite.tasks.length, trials: r.suite.trials?.count ?? 1,
            locked: r.source === 'pack' || !!r.stored.lockedAt, source: r.source,
          })),
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted', // echoes a member-supplied suite ref in errors
    effect: 'write',
    safeModeApproval: { reason: 'Running an eval suite spends model calls on every task and trial.' },
    def: {
      name: AGENT_EVALS_RUN_TOOL_ID,
      description: 'Start an eval run of a suite against an agent (RFC 0081). Returns the eval runId; poll it with '
        + `${AGENT_EVALS_GET_SUMMARY_TOOL_ID}. Optionally compare to a previous eval run with baselineRunId.`,
      inputSchema: {
        type: 'object',
        properties: {
          suiteRef: { type: 'string', description: 'The suite ref, <suiteId>@<version> (from list-suites).' },
          agentId: { type: 'string', description: 'The agent to evaluate.' },
          baselineRunId: { type: 'string', description: 'Optional earlier eval run of the same suite to compare against.' },
        },
        required: ['suiteRef', 'agentId'],
        additionalProperties: false,
      },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return fail('acting_user_required', 'Starting an eval run needs a signed-in person behind the run.');
      // Review M3/H1 — evals enabled + workspace:write, the same predicate as the write routes; fails CLOSED.
      const refused = await agentEvalsToolGate(scope, 'workspace:write');
      if (refused) return fail(refused.error, refused.message);
      const storage = hostExtStorage();
      const body = {
        mode: 'eval', evalSuiteRef: str(input.suiteRef), agentId: str(input.agentId),
        ...(str(input.baselineRunId) ? { configurable: { baselineRunId: str(input.baselineRunId) } } : {}),
      };
      try {
        // The RFC 0165 owner echo HTTP-created runs carry: the conversation run's,
        // because the person behind that run is the one starting this one.
        const parent = scope.runId ? await storage.getRun(scope.runId).catch(() => null) : null;
        const owner = parent && parent.tenantId === scope.tenantId ? (parent.metadata?.[OWNER_METADATA_KEY] as RunOwnerStamp | undefined) : undefined;
        // EVD-7 — same args in the same conversation run ⇒ the same eval run (a model
        // re-issuing the call must not spend the suite again). A runless caller has no
        // stable identity to key on and creates as before.
        const created = await createAgentEvalRunOnce({
          caller: {
            actingUserId: scope.actingUserId,
            ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}),
            ...(owner ? { owner } : {}),
          },
          storage,
          tenantId: scope.tenantId,
          body,
          ...(scope.runId ? { dedupeKey: `chat-tool:${scope.runId}:${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}` } : {}),
        });
        return { content: JSON.stringify({ runId: created.runId, status: created.status, ...(created.replayed ? { replayed: true } : {}) }) };
      } catch (err) {
        if (err instanceof OpenwopError) return fail(err.code, err.message);
        throw err;
      }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted', // content-free, but suite/task ids are member-authored
    effect: 'read',
    def: {
      name: AGENT_EVALS_GET_SUMMARY_TOOL_ID,
      description: 'Read an eval run\'s status and, once complete, its content-free scorecard: aggregate score, pass/fail, '
        + 'per-task scores, pass@k / pass^k, trajectory counts, and the regression verdict. Read-only.',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return fail('not_found', 'Eval run not found.');
      const refused = await agentEvalsToolGate(scope, 'workspace:read');
      if (refused) return fail(refused.error, refused.message);
      const id = storedRunId(str(input.runId), scope.tenantId);
      const run = id ? await hostExtStorage().getRun(id) : null;
      // Another tenant's run is indistinguishable from an absent one.
      if (!run || run.tenantId !== scope.tenantId || !isAgentEvalRun(run)) return fail('not_found', 'Eval run not found.');
      return { content: JSON.stringify({ runId: run.runId, status: run.status, summary: run.metadata?.evalSummary ?? null, error: run.error ?? null }) };
    },
  });
}
