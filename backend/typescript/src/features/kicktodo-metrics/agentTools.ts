/**
 * Challenge Author performance read (XCH-HOLE-1; ADR 0308 seam, ADR 0458 §2.1).
 *
 * The outcome metrics (ADR 0432) and the verifier-quality sample had node-pack
 * nodes but no chat tool, so a creator could not ask the Challenge Author "how
 * are my challenges doing". This is that read. It lives HERE, not in
 * `kicktodo-creator/agentTools.ts`, because `kicktodo-metrics` depends on
 * `kicktodo-creator` (metricsService reads `listCandidates`); the reverse import
 * would close a feature-dependency cycle.
 *
 * Authorization is the ROUTE's predicate, shared: the metrics routes gate on
 * `requireKicktodoManage(req, 'kicktodo-metrics', …)`, which is the toggle plus
 * `hasKicktodoManageAuthority`. This tool calls the SAME toggle resolution and
 * the SAME predicate, so a route and the tool cannot disagree on who may read.
 *   - no acting user ⇒ fail EMPTY (no probe from a system/scheduled turn);
 *   - toggle off / not entitled ⇒ the typed `featureUnavailable` refusal
 *     (the CFPT-1c posture every feature read tool shares);
 *   - acting user without manage authority ⇒ fail EMPTY.
 *
 * The payload is exactly what the routes return: counts and k-floored cells,
 * never a participant-level row. It is WORKSPACE-wide; metricsService has no
 * per-challenge breakdown, so the description tells the model not to attribute
 * these numbers to one challenge.
 *
 * Pack-allowlisted onto the Challenge Author only; never the ADR 0315 default-on
 * baseline (pinned by `kicktodo-challenge-author-prompt-parity.test`).
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { featureUnavailable, resolveFeatureAccess, toolEmpty, toolFailLog, toolOk, type ToolResult } from '../../host/agentToolKit.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { createLogger } from '../../observability/logger.js';
import { hasKicktodoManageAuthority } from '../featureRoute.js';
import { activationMetrics, engagementMetrics, factoryMetrics, K_FLOOR } from './metricsService.js';
import { verifierQuality } from './verifierSampleService.js';

const log = createLogger('kicktodo.metrics-tools');

export const KICKTODO_CHALLENGE_PERFORMANCE_TOOL_ID = 'openwop:kicktodo.challenge-performance';

const FEATURE_ID = 'kicktodo-metrics';
const FEATURE_LABEL = 'KickTodo Metrics';

/** The empty read: same keys as a real answer, every section absent. */
const EMPTY = { scope: 'workspace', activation: null, engagement: null, factory: null, verifierQuality: null } as const;

/** READ — the workspace's outcome metrics + verifier quality. Exported for direct
 *  authz testing (the `runCandidatesTool` precedent). */
export async function runChallengePerformanceTool(_input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return toolEmpty(EMPTY);
  const access = await resolveFeatureAccess(FEATURE_ID, scope);
  if (!access?.enabled) return featureUnavailable(access, FEATURE_LABEL);
  if (!(await hasKicktodoManageAuthority(scope.tenantId, scope.actingUserId))) return toolEmpty(EMPTY);
  try {
    const [activation, engagement, factory, quality] = await Promise.all([
      activationMetrics(scope.tenantId),
      engagementMetrics(scope.tenantId),
      factoryMetrics(scope.tenantId),
      verifierQuality(scope.tenantId),
    ]);
    return toolOk({ scope: 'workspace', kFloor: K_FLOOR, activation, engagement, factory, verifierQuality: quality });
  } catch (err) {
    return toolFailLog(log, KICKTODO_CHALLENGE_PERFORMANCE_TOOL_ID, err, 'Challenge performance could not be read right now. Tell the creator to try again shortly.');
  }
}

export function registerKicktodoMetricsAgentTools(): void {
  registerFeatureAgentTool({
    // Untrusted (fenced) like every feature read tool. The payload is host-
    // computed counts today, but `trusted` is a security classification that
    // removes the fence on the chat path (RFC 0137 §F1, ADR 0604) and is pinned
    // repo-wide; a read tool does not need it, so it is not claimed.
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: KICKTODO_CHALLENGE_PERFORMANCE_TOOL_ID,
      description:
        'Read how this workspace\'s published KickTodo challenges are performing: activation (enrollments started, days to first completed action), '
        + 'engagement (weekly meaningful progress, D7/D30 retention, completion, abandonment, 7-day recovery), Challenge Factory throughput '
        + '(candidates by stage, publish rate) and the automated progress verifier\'s quality (human-graded samples, false positives/negatives). '
        + 'The numbers are WORKSPACE-wide across every challenge, not per challenge — never attribute them to one challenge. '
        + `A cell drawn from fewer than ${K_FLOOR} participants comes back with \`value: null\` and \`withheldReason: "below-k-floor"\`: say it is withheld for privacy, never guess a number. `
        + '`verifierQuality.disagreementRate` is null until a human has graded a sample. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: runChallengePerformanceTool,
  });
}
