/**
 * Analytics chat tool (CFP-1 repair; ADR 0308 D2 seam) — the read grounding for
 * the Analytics Insights agent. The pack formerly allowlisted the workflow node
 * typeId `feature.analytics.nodes.query`, which nothing projects into a
 * conversational tool (CFP-1). This `registerFeatureAgentTool` tool makes the
 * same summary read real, over the same `analyticsService` the routes + surface
 * use.
 *
 * Authority parity (hard rule #1): resolves org scope through the same `listOrgs`
 * + `resolveEffectiveAccess('workspace:read')` predicate the analytics routes
 * enforce via `authorizeOrgScope`. Read posture: FAIL EMPTY — no acting user,
 * feature off, or no accessible org ⇒ a null summary (annotated), never a probe.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveReadOrgScope, str, toolEmpty, toolOk } from '../../host/agentToolKit.js';
import { summarizeForReport } from './analyticsService.js';

export const ANALYTICS_QUERY_TOOL_ID = 'openwop:analytics.query';

const resolveReadOrg = (scope: Parameters<typeof resolveReadOrgScope>[0], orgIdInput?: string) =>
  resolveReadOrgScope(scope, { featureId: 'analytics', featureLabel: 'Analytics' }, orgIdInput);

export function registerAnalyticsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ANALYTICS_QUERY_TOOL_ID,
      description:
        "Read an organization's analytics summary — total events; counts by type (pageview / event / conversion); "
        + 'unique sessions; top paths; top UTM sources; Web Vitals p75. Read-only; grounded in the workspace\'s own analytics data. '
        + 'Defaults to the last 30 days (the same window the analytics page shows); pass days=7|30|90 or days=0 for all time.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' },
          days: { type: 'number', description: 'Reporting window in days: 7, 30 (default), or 90. 0 = all time.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const r = await resolveReadOrg(scope, str(input.orgId));
      if (r.kind === 'empty') return toolEmpty({ summary: null, note: r.note });
      if (r.kind === 'error') return r.result;
      // R2 AN-SP-10 — the tool was ALL-TIME only, so agent answers disagreed
      // with the page's 30-day default. Same allowlist as the route; 0 opts
      // into all time explicitly.
      const rawDays = typeof input.days === 'number' ? input.days : 30;
      const days = rawDays === 0 ? undefined : ([7, 30, 90].includes(rawDays) ? rawDays : 30);
      // ANL-UX-4 R2 — `summarizeForReport`, NOT `summarize`. The route was given
      // the deployment-scoped `uniqueVisitorsSince` override and this tool was
      // not, so a model asking about 7 days was told uniques "have been counted
      // since" a date ~8 days old that moved with the window — a fabricated
      // fact, on the lane where a fabricated fact is hardest to notice. Same
      // single indexed read; the honest date and the ANL-UX-3 measured-zero
      // distinction come with it.
      const { summary } = await summarizeForReport(scope.tenantId, r.orgId, days);
      return toolOk({ summary, window: days === undefined ? 'all-time' : `${days}d` });
    },
  });
}
