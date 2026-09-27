/**
 * CSM feature routes (host-extension, best-effort — ADR 0001 §6 Phase 6).
 *
 * Surface under /v1/host/openwop-app/csm. Toggle-gated on `csm` (backend authority —
 * 404 when off). A plain on/off feature (no variants) — demonstrating the
 * contract works for the non-multivariant case too.
 *
 *   GET    /accounts            list the caller's accounts (lowest health first)
 *   POST   /accounts            create an account
 *   PATCH  /accounts/:id        update name / healthScore
 *   DELETE /accounts/:id        remove
 *
 * ADR 0582 §2 — AUTHORIZATION. Until 2026-08-18 `requireEnabled` (toggle +
 * entitlement) was the ENTIRE gate on all four routes: no scope check, no role
 * check, no caller resolution. In a shared SSO/SCIM/`ws:` tenant — many humans
 * on one tenantId — every member, a viewer included, could create, rename,
 * re-score, re-link and DELETE rows carrying ARR, renewal dates and owner
 * attribution. Two gates now apply, both pre-existing chokes reused rather than
 * copied:
 *   1. `requireTenantScope` (featureRoute.ts) — the TENANT-level authority gate
 *      built for exactly this shape (tenant-scoped route, tenant-wide state).
 *      Reads need `workspace:read`, writes `workspace:write`.
 *   2. `requireOrgScope` on a body-supplied `crmRef.orgId` (§3) — see
 *      `authorizeCrmRefOrg` below.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import type { Scope } from '../../host/accessControlService.js';
import { requireOrgScope, requireTenantScope } from '../featureRoute.js';
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount, type CrmRef } from './accountsService.js';

const TOGGLE_ID = 'csm';

function subjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: req.tenantId ?? 'default' };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  return subject;
}

/**
 * The ONE gate every csm route passes through: toggle → entitlement → RBAC.
 * `scope` is `workspace:read` on the list route and `workspace:write` on the
 * three mutating ones (ADR 0582 §2 / CSM-1).
 *
 * Order matters: the toggle 404 comes FIRST so a caller who lacks scope in a
 * workspace where CSM is off still learns nothing about CSM's existence there —
 * the same "off ⇒ indistinguishable from absent" property the feature already had.
 */
async function requireEnabled(req: Request, scope: Scope): Promise<void> {
  const assignment = await resolveOne(TOGGLE_ID, subjectOf(req));
  if (!assignment || !assignment.enabled) {
    throw new OpenwopError('not_found', 'CSM is not enabled for this tenant.', 404, { feature: TOGGLE_ID });
  }
  // ADR 0419 — CSM is a CRM-bundle feature; gate on the plan/bundle entitlement at
  // this ONE choke (all csm routes pass through it). No-op until an operator narrows
  // PLAN_FEATURES with billing on; an active `crm`-bundle grant re-includes `csm`.
  await checkEntitlement(req, TOGGLE_ID);
  // CSM-1 — the account book is tenant-wide state on a tenant-scoped route, the
  // exact shape `requireTenantScope` was written for. Fail-closed: a caller with
  // no membership resolves to zero scopes and is denied.
  await requireTenantScope(req, scope);
}

/**
 * ADR 0582 §3 (CSM-2) — authorize a BODY-SUPPLIED `crmRef.orgId` against the
 * caller before any link is written or validated.
 *
 * `validateCrmRef` proves only that the company exists in that org OF THAT
 * TENANT (`crm/entities/companies.ts` `getCompany`); it never asks whether the
 * CALLER may read that org, and it skips the ADR 0272 territory row-visibility
 * filter the CRM list path applies. So `POST /accounts` distinguished
 * "company exists in org X" (201) from "does not" (404) for ANY org in the
 * tenant — a cross-org existence oracle — and persisted a link readable back
 * through `GET /accounts` into an org the caller has no scope in.
 *
 * The cure is CRM's own precedent for a body-supplied org (`crm/routes.ts`,
 * the lead-convert route): stage it into `req.params.orgId` and run the SHARED
 * `requireOrgScope` predicate, so there is one definition of the guard rather
 * than a second copy. The toggle/entitlement half is already done by
 * `requireEnabled`, which is why this calls `requireOrgScope` rather than
 * `authorizeOrgScope`.
 */
async function authorizeCrmRefOrg(req: Request, orgId: string): Promise<void> {
  // The wildcard operator principal (env API key / admin token / conformance
  // harness) acts across tenants — the SAME trusted escape hatch
  // `requireTenantScope`/`requireProtocolScope`/`loadOwnedRun` use. Without it,
  // operator tooling would 403 on every linked create.
  if (req.principal?.tenants?.includes('*')) return;
  (req.params as Record<string, string>).orgId = orgId;
  await requireOrgScope(req, 'workspace:write');
}

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

/**
 * ADR 0582 §4 — `undefined` = absent (create: UNSCORED; patch: leave alone);
 * `null` = an explicit clear back to unscored (patch only); a number is a real
 * score. There is no path that invents 50.
 */
function parseScore(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OpenwopError('validation_error', 'Field `healthScore` MUST be a number in [0, 100], or null to clear it.', 400, { field: 'healthScore' });
  }
  return value;
}

/**
 * ADR 0212 §1 — `crmRef` is both-or-neither. `undefined` (absent) means
 * "leave unchanged" on PATCH / "no link" on create; `null` means an explicit
 * clear (PATCH only — `createAccount` treats it as "no link"); a half-ref
 * (only one of `orgId`/`companyId`) is a 400. The existence/tombstone check
 * against CRM happens in accountsService (`validateCrmRef`), not here.
 */
function parseCrmRef(value: unknown): CrmRef | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') {
    throw new OpenwopError('validation_error', 'Field `crmRef` MUST be an object with `orgId` and `companyId`, or null.', 400, { field: 'crmRef' });
  }
  const v = value as { orgId?: unknown; companyId?: unknown };
  const orgId = typeof v.orgId === 'string' ? v.orgId.trim() : '';
  const companyId = typeof v.companyId === 'string' ? v.companyId.trim() : '';
  if (Boolean(orgId) !== Boolean(companyId)) {
    throw new OpenwopError('validation_error', 'Field `crmRef` requires BOTH `orgId` and `companyId` (or neither).', 400, { field: 'crmRef' });
  }
  return orgId && companyId ? { orgId, companyId } : null;
}

export function registerCsmRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/v1/host/openwop-app/csm/accounts', async (req, res, next) => {
    try {
      await requireEnabled(req, 'workspace:read');
      res.json({ accounts: await listAccounts(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/csm/accounts', async (req, res, next) => {
    try {
      await requireEnabled(req, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; healthScore?: unknown; crmRef?: unknown; renewalDate?: unknown; arr?: unknown; arrCurrency?: unknown; owner?: unknown };
      const crmRef = parseCrmRef(body.crmRef);
      // CSM-2 — authorize the target org BEFORE `createAccount` resolves the
      // company (which is what would leak its existence).
      if (crmRef) await authorizeCrmRefOrg(req, crmRef.orgId);
      // ADR 0582 §4 — absent OR an explicit null on create means UNSCORED.
      const createScore = parseScore(body.healthScore);
      const account = await createAccount({
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        ...(typeof createScore === 'number' ? { healthScore: createScore } : {}),
        ...(crmRef ? { crmRef } : {}),
        // CRM-3 — the service validates (fail-closed); the route only narrows the primitive type.
        ...(typeof body.renewalDate === 'string' ? { renewalDate: body.renewalDate } : {}),
        ...(typeof body.arr === 'number' ? { arr: body.arr } : {}),
        ...(typeof body.arrCurrency === 'string' ? { arrCurrency: body.arrCurrency } : {}),
        ...(typeof body.owner === 'string' ? { owner: body.owner } : {}),
      });
      res.status(201).json(account);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/openwop-app/csm/accounts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req, 'workspace:write');
      const existing = await getAccount(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Account not found.', 404, { accountId: req.params.id });
      }
      const body = (req.body ?? {}) as { name?: unknown; healthScore?: unknown; crmRef?: unknown; renewalDate?: unknown; arr?: unknown; arrCurrency?: unknown; owner?: unknown };
      const crmRef = parseCrmRef(body.crmRef);
      // CSM-2 — same gate on the PATCH lane; a re-link is the same authority
      // decision as the original link. (`null` clears and touches no org.)
      if (crmRef) await authorizeCrmRefOrg(req, crmRef.orgId);
      // CRM-3 — an explicit `null` clears the field; a primitive is passed to the service to
      // validate; anything else is treated as absent (untouched).
      const nStr = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined);
      const nNum = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' ? v : undefined);
      // ADR 0582 §4 — `null` here CLEARS the score back to unscored (the
      // affordance for an operator who no longer trusts the number); `undefined`
      // leaves it untouched.
      const patchScore = parseScore(body.healthScore);
      const updated = await updateAccount(req.params.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(patchScore !== undefined ? { healthScore: patchScore } : {}),
        ...(crmRef !== undefined ? { crmRef } : {}),
        ...(nStr(body.renewalDate) !== undefined ? { renewalDate: nStr(body.renewalDate) } : {}),
        ...(nNum(body.arr) !== undefined ? { arr: nNum(body.arr) } : {}),
        ...('arrCurrency' in body ? { arrCurrency: body.arrCurrency === null ? null : typeof body.arrCurrency === 'string' ? body.arrCurrency : undefined } : {}),
        ...(nStr(body.owner) !== undefined ? { owner: nStr(body.owner) } : {}),
      });
      // CSM-7 — `updateAccount` returns null when the row vanished between the
      // existence check above and the write (a concurrent DELETE). Shipping that
      // unguarded was a `200` with an empty body: a failed write presenting as
      // success. It is a 404, the same answer the pre-read gives.
      if (!updated) {
        throw new OpenwopError('not_found', 'Account not found.', 404, { accountId: req.params.id });
      }
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/csm/accounts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req, 'workspace:write');
      const existing = await getAccount(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Account not found.', 404, { accountId: req.params.id });
      }
      await deleteAccount(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
