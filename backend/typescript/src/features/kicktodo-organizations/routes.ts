/**
 * kicktodo-organizations REST (ADR 0428 P1–P3) — org-admin-gated mutations
 * (`host:org:manage` via the SINGLE composed gate `authorizeOrgScope`),
 * member reads via `manifest:read`. `/kicktodo/org-programs/:orgId/*`
 * (deliberately NOT `/kicktodo/orgs` — concept clarity vs accessControl).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireKicktodoManage, requireString, tenantOf } from '../featureRoute.js';
import { listOrgs, listTenantMembers } from '../../host/accessControlService.js';
import {
  setLibraryEntry,
  getLibrary,
  libraryCatalog,
  linkCohort,
  unlinkCohort,
  listCohortLinks,
  setBrandRef,
  getBrandRef,
  orgReport,
  OrgProgramError,
  OrgProgramNotFoundError,
} from './orgProgramService.js';

export const KICKTODO_ORG_PREFIX = '/v1/host/openwop-app/kicktodo/org-programs';

const FEATURE = { toggleId: 'kicktodo-organizations', label: 'KickTodo Organizations' };

type Handler = (req: Request, res: Response) => Promise<void>;

function mapError(err: unknown): never {
  if (err instanceof OrgProgramError) throw new OpenwopError('validation_error', err.message, 422);
  if (err instanceof OrgProgramNotFoundError) throw new OpenwopError('not_found', 'Not found.', 404);
  throw err;
}

export const KICKTODO_ORG_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'get',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/library`,
    handler: async (req, res) => {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'manifest:read');
      res.json({
        library: await getLibrary(tenantId, orgId),
        catalog: await libraryCatalog(tenantId, orgId),
      });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/library`,
    handler: async (req, res) => {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:org:manage');
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.version !== 'number') throw new OpenwopError('validation_error', 'Field `version` must be a number.', 400);
      try {
        res.json(await setLibraryEntry(tenantId, orgId, user.userId, {
          challengeId: requireString(b.challengeId, 'challengeId'),
          version: b.version,
          present: b.present !== false,
        }));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/cohorts`,
    handler: async (req, res) => {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'manifest:read');
      res.json({ cohorts: await listCohortLinks(tenantId, orgId) });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/cohorts`,
    handler: async (req, res) => {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:org:manage');
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await linkCohort(tenantId, orgId, user.userId, requireString(b.circleId, 'circleId')));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/cohorts/unlink`,
    handler: async (req, res) => {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:org:manage');
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        // ARCH-M6 — the cohort OWNER withdraws their own cohort; org scope
        // alone is not enough, or one member could undo another's decision.
        await unlinkCohort(tenantId, orgId, requireString(b.circleId, 'circleId'), user.userId);
      } catch (err) {
        mapError(err);
      }
      res.json({ unlinked: true });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/brand`,
    handler: async (req, res) => {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'manifest:read');
      res.json({ brandProfileId: await getBrandRef(tenantId, orgId) });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/brand`,
    handler: async (req, res) => {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:org:manage');
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        await setBrandRef(tenantId, orgId, requireString(b.brandProfileId, 'brandProfileId'));
        res.json({ saved: true });
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    // k-anonymous, computed-on-read; ADMIN read (aggregate outcomes).
    method: 'get',
    path: `${KICKTODO_ORG_PREFIX}/:orgId/report`,
    handler: async (req, res) => {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:org:manage');
      res.json({ cells: await orgReport(tenantId, orgId) });
    },
  },
  {
    // ADR 0438 A4 — the admin "People & access" lens, AGGREGATES ONLY. Composes
    // the platform member roster (host accessControl) + this feature's org-program
    // links into counts a platform admin may lawfully see WITHOUT a per-person row:
    // no names/emails/subjects, no cohort membership, and — the B16 law — NO cohort
    // outcome aggregates (those stay behind the per-org `:orgId/report` at org-manager
    // authority, k-anon + consent re-verified per read). Read-only; grants/suspensions
    // live on the platform `/access` surface at `host:members:manage` (§3.3 — this
    // tier never mints roles).
    //
    // Authority note (grade-trio): `requireKicktodoManage` admits `host:kicktodo:manage`
    // holders — the KickTodo AUTHORING scope, reachable only via the built-in
    // admin/owner roles whose scope set includes `host:members:manage`, so every
    // admitted caller could already read full member rows at /access; this lens shows
    // strictly less. The gate rides THIS feature's toggle (`kicktodo-organizations`) —
    // with it OFF the console page renders its error state by design.
    method: 'get',
    path: `${KICKTODO_ORG_PREFIX}/admin/people`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, FEATURE.toggleId, FEATURE.label);
      const tenantId = tenantOf(req);
      // ONE roster scan; every aggregate below groups this in memory (grade-trio
      // fix: the per-org listMembers re-scan was an N+1 full-collection fan-out).
      const roster = await listTenantMembers(tenantId);
      // Count PEOPLE, not membership rows: one person seated at the workspace root
      // and in a sub-org is one member; their role set is the union across seats.
      // (Descriptive members with no principal binding count by their memberId.)
      const personRoles = new Map<string, Set<string>>();
      const orgMemberPersons = new Map<string, Set<string>>();
      for (const m of roster) {
        const person = m.subject ?? m.memberId;
        const roles = personRoles.get(person) ?? new Set<string>();
        for (const role of m.roles) roles.add(role);
        personRoles.set(person, roles);
        const orgSet = orgMemberPersons.get(m.orgId) ?? new Set<string>();
        orgSet.add(person);
        orgMemberPersons.set(m.orgId, orgSet);
      }
      const byRole = new Map<string, number>();
      let rolelessCount = 0;
      for (const roles of personRoles.values()) {
        if (roles.size === 0) { rolelessCount += 1; continue; }
        for (const role of roles) byRole.set(role, (byRole.get(role) ?? 0) + 1);
      }
      // Bounded per-org reads only: cohort links are a `${tenantId}::${orgId}::`
      // prefix scan and the library a point get; member counts come from the
      // roster grouping above.
      const orgs = [] as Array<{ orgId: string; name: string; memberCount: number; cohortLinkCount: number; libraryCurated: boolean }>;
      for (const org of await listOrgs(tenantId)) {
        orgs.push({
          orgId: org.orgId,
          name: org.name,
          memberCount: orgMemberPersons.get(org.orgId)?.size ?? 0,
          cohortLinkCount: (await listCohortLinks(tenantId, org.orgId)).length,
          libraryCurated: (await getLibrary(tenantId, org.orgId)) !== null,
        });
      }
      res.json({
        members: {
          total: personRoles.size,
          byRole: [...byRole.entries()]
            .map(([role, count]) => ({ role, count }))
            .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
          // Structural (never an in-band sentinel like '(none)'): people whose
          // seats carry no role at all.
          rolelessCount,
        },
        orgs,
        // Honest consent posture: cohort OUTCOME aggregates are consent-gated per
        // org link (B16) and readable only at the org's own authority.
        consent: { cohortAggregatesGated: true },
      });
    },
  },
];

export function registerKicktodoOrgRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_ORG_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
}
