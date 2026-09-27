/**
 * Agent org-chart — the RFC 0087 NORMATIVE read pair plus the host-extension
 * write surface.
 *
 * The reference implementation of RFCS/0087 §B/§D. Two surfaces, ONE service
 * (`host/orgChartService.ts`) — there is no second store and no second
 * validation path:
 *
 *   NORMATIVE (§D, `registerOrgChartNormativeRoutes`):
 *   GET /v1/agents/org-chart                  the caller's full chart
 *   GET /v1/agents/org-chart/{departmentId}   subtree + responsibility roll-up
 *
 *   HOST-EXTENSION (non-normative, `registerOrgChartRoutes`):
 *   GET    /v1/host/openwop-app/org-chart                the same read
 *   PUT    /v1/host/openwop-app/org-chart                replace the chart
 *   DELETE /v1/host/openwop-app/org-chart                remove the chart
 *   GET    /v1/host/openwop-app/org-chart/{departmentId} the same roll-up
 *
 * The host-extension reads are RETAINED rather than redirected: existing
 * callers (the operator console) use them, and RFC 0087 does not forbid a
 * host alias. WRITES stay host-extension only — §A/§D mint no normative write
 * route, so serving one would invent wire surface.
 *
 * Tenant-scoped per chart ownership (the RFC 0074 carry-forward). The chart
 * is DESCRIPTIVE — there is no permissions/scopes surface here, and these
 * routes never read or mutate toolAllowlist / RBAC / approval gates
 * (RFC 0087 §B `org-position-no-authority-escalation`: position describes,
 * it never authorizes). That invariant is what the conformance scenario
 * `org-position-no-authority-escalation` reads the NORMATIVE route to check,
 * which is why the host advertising `agents.orgChart.supported: true` while
 * serving only the host-extension alias was a dishonest claim: the capability
 * was real, the wire the spec names for reading it was not there.
 *
 * @see src/host/orgChartService.ts
 * @see RFCS/0087-agent-org-chart.md §A/§B/§C/§D
 * @see spec/v1/agent-org-chart.md §C (tenant scoping) §D (the endpoint pair)
 */

import type { Express, Request } from 'express';
import { v1 } from '../middleware/protocolVersion.js';
import { OpenwopError } from '../types.js';
import {
  deleteChart,
  getChart,
  putChart,
  responsibilityView,
  type OrgDepartment,
  type OrgMember,
} from '../host/orgChartService.js';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

/** The empty chart a tenant with no stored org-chart reads as. §D types the
 *  response as `{ departments[], members[] }`, so an absent chart is an EMPTY
 *  chart, not a 404 — a tenant that has not built one has no departments, and
 *  404 would be indistinguishable from "the capability is not served". */
function emptyChart(tenantId: string) {
  return { tenantId, departments: [], members: [], updatedAt: null };
}

/**
 * The RFC 0087 §D normative read pair.
 *
 * **Registration order is load-bearing.** `routes/agents.ts` serves
 * `GET /v1/agents/:agentId`, which matches the literal segment `org-chart` and
 * answers `404 not_found` for it. Express resolves in registration order, so
 * these routes MUST be registered BEFORE the `agents` module or they are dead
 * — and dead in the most misleading way available, because the 404 is exactly
 * what the conformance scenario reads as "seam absent". `registerAllRoutes.ts`
 * therefore lists `orgChartNormative` ahead of `agents`, and
 * `org-chart-normative-route.test.ts` pins that it is not shadowed.
 */
export function registerOrgChartNormativeRoutes(app: Express): void {
  app.get(v1('/agents/org-chart'), async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const chart = await getChart(tenantId);
      res.json(chart ?? emptyChart(tenantId));
    } catch (err) {
      next(err);
    }
  });

  app.get(v1('/agents/org-chart/:departmentId'), async (req, res, next) => {
    try {
      // §D — `?recursive=false` NARROWS the roll-up to direct members without
      // changing the response shape. Any other value (including absent) is the
      // default recursive roll-up.
      const recursive = req.query.recursive !== 'false';
      const view = await responsibilityView(tenantOf(req), req.params.departmentId, recursive);
      if (!view) {
        // §C — an unknown OR cross-tenant departmentId is the SAME 404. The
        // service is already tenant-keyed, so a foreign id cannot resolve; the
        // shared status is what stops the response distinguishing "absent" from
        // "not yours" (the CTI-1 carry-forward).
        throw new OpenwopError('not_found', "Department not found in this tenant's org-chart.", 404, {
          departmentId: req.params.departmentId,
        });
      }
      res.json(view);
    } catch (err) {
      next(err);
    }
  });
}

export function registerOrgChartRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/org-chart', async (req, res, next) => {
    try {
      const chart = await getChart(tenantOf(req));
      res.json(chart ?? emptyChart(tenantOf(req)));
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/org-chart', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { departments?: unknown; members?: unknown };
      if (!Array.isArray(body.departments) || !Array.isArray(body.members)) {
        throw new OpenwopError('validation_error', 'Fields `departments` and `members` are required arrays.', 400, {
          field: 'departments|members',
        });
      }
      const result = await putChart({
        tenantId: tenantOf(req),
        departments: body.departments as OrgDepartment[],
        members: body.members as OrgMember[],
      });
      if ('error' in result) {
        // A cycle / cross-tenant member / dangling ref is a client error.
        throw new OpenwopError('validation_error', result.error.message, 400, {
          reason: result.error.code,
          detail: result.error.detail,
        });
      }
      res.status(200).json(result.chart);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/org-chart', async (req, res, next) => {
    try {
      await deleteChart(tenantOf(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/org-chart/:departmentId', async (req, res, next) => {
    try {
      const recursive = req.query.recursive !== 'false';
      const view = await responsibilityView(tenantOf(req), req.params.departmentId, recursive);
      if (!view) {
        throw new OpenwopError('not_found', 'Department not found in this tenant\'s org-chart.', 404, {
          departmentId: req.params.departmentId,
        });
      }
      res.json(view);
    } catch (err) {
      next(err);
    }
  });
}
