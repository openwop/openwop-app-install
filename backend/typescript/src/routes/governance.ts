/**
 * Governance administration (ADR 0028) — host-extension, NON-NORMATIVE.
 *
 *   GET /v1/host/sample/governance/policy   — the tenant's policy (defaults shown)
 *   PUT /v1/host/sample/governance/policy   — upsert (superadmin; itself audited)
 *   GET /v1/host/sample/governance/audit    — the audit READ VIEW over
 *       storage.appendAudit rows (no second audit store) — assistant
 *       decisions, policy edits, connector use.
 *
 * The policy never evaluates anything here: enforcement lives at the existing
 * seams (the connections routes + node-exec resolver consult
 * `isProviderAllowed`; the assistant enqueue/execution seams consult
 * `actionPolicyOf`). Superadmin gate shared with feature-toggles
 * (`host/superadmin.ts`).
 */

import type { Express, Request } from 'express';
import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { requireSuperadmin } from '../host/superadmin.js';
import {
  getGovernancePolicy,
  setGovernancePolicy,
  type ActionKindPolicy,
} from '../host/governanceService.js';

const ACTION_KINDS = ['email.send', 'calendar.invite', 'calendar.reschedule', 'nudge'] as const;
const POLICY_VALUES: readonly ActionKindPolicy[] = ['disabled', 'draft-only', 'approval-required'];

const tenantOf = (req: Request): string => req.tenantId ?? 'default';

function parseActionPolicy(v: unknown): Record<string, ActionKindPolicy> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object') {
    throw new OpenwopError('validation_error', '`actionPolicy` MUST be an object of kind → policy.', 400, {});
  }
  const out: Record<string, ActionKindPolicy> = {};
  for (const [kind, policy] of Object.entries(v as Record<string, unknown>)) {
    if (!(ACTION_KINDS as readonly string[]).includes(kind)) {
      throw new OpenwopError('validation_error', `Unknown action kind '${kind}'.`, 400, { kind, known: ACTION_KINDS });
    }
    if (!POLICY_VALUES.includes(policy as ActionKindPolicy)) {
      throw new OpenwopError('validation_error', `Policy for '${kind}' MUST be one of ${POLICY_VALUES.join(' | ')}.`, 400, { kind });
    }
    out[kind] = policy as ActionKindPolicy;
  }
  return out;
}

export function registerGovernanceRoutes(app: Express, deps: { storage: Storage }): void {
  app.get('/v1/host/sample/governance/policy', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const policy = await getGovernancePolicy(tenantOf(req));
      res.json({
        policy: policy ?? { tenantId: tenantOf(req) },
        defaults: { actionPolicy: 'approval-required', providerAllowlist: null },
        actionKinds: ACTION_KINDS,
      });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/sample/governance/policy', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const providerAllowlist =
        body.providerAllowlist === undefined
          ? undefined
          : Array.isArray(body.providerAllowlist)
            ? body.providerAllowlist.filter((p): p is string => typeof p === 'string')
            : (() => {
                throw new OpenwopError('validation_error', '`providerAllowlist` MUST be an array of provider ids.', 400, {});
              })();
      const retention =
        body.retention && typeof body.retention === 'object'
          ? {
              ...(typeof (body.retention as Record<string, unknown>).assistantGraphDays === 'number'
                ? { assistantGraphDays: (body.retention as Record<string, number>).assistantGraphDays }
                : {}),
              ...(typeof (body.retention as Record<string, unknown>).sourceDerivedDays === 'number'
                ? { sourceDerivedDays: (body.retention as Record<string, number>).sourceDerivedDays }
                : {}),
            }
          : undefined;
      const updatedBy = req.userId ?? req.principal?.principalId;
      const policy = await setGovernancePolicy(
        tenantOf(req),
        {
          ...(providerAllowlist !== undefined ? { providerAllowlist } : {}),
          ...(parseActionPolicy(body.actionPolicy) !== undefined ? { actionPolicy: parseActionPolicy(body.actionPolicy) } : {}),
          ...(retention !== undefined ? { retention } : {}),
        },
        updatedBy,
      );
      // Policy edits are themselves audited (ADR 0028) — best-effort.
      void deps.storage
        .appendAudit({
          timestamp: new Date().toISOString(),
          principalId: updatedBy ?? 'unknown',
          action: 'governance.policy.updated',
          resource: `governance:${tenantOf(req)}`,
          outcome: 'success',
          payload: { tenantId: tenantOf(req), policy },
        })
        .catch(() => {});
      res.json({ policy });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/sample/governance/audit', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const actionPrefix = typeof req.query.actionPrefix === 'string' ? req.query.actionPrefix : 'assistant.';
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
      const items = await deps.storage.listAudit({
        actionPrefix,
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(sinceIso !== undefined ? { sinceIso } : {}),
      });
      // TENANT ISOLATION — `audit_log` has no tenant column, and a
      // "superadmin" can be TENANT-SCOPED (OPENWOP_SUPERADMIN_TENANTS, the
      // documented prod mechanism). Only the wildcard admin principal sees
      // the unfiltered log; everyone else sees rows whose payload.tenantId
      // matches their tenant — rows without a payload tenant stamp are
      // withheld (fail closed) rather than leaked.
      const isWildcardAdmin = req.principal?.tenants?.includes('*') === true;
      const tenantId = tenantOf(req);
      const scoped = isWildcardAdmin
        ? items
        : items.filter((r) => {
            const p = r.payload as Record<string, unknown> | undefined;
            return p !== undefined && p !== null && typeof p === 'object' && p.tenantId === tenantId;
          });
      res.json({ items: scoped });
    } catch (err) {
      next(err);
    }
  });
}
