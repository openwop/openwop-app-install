/**
 * Governance administration (ADR 0028) — host-extension, NON-NORMATIVE.
 *
 *   GET /v1/host/openwop-app/governance/policy   — the tenant's policy (defaults shown)
 *   PUT /v1/host/openwop-app/governance/policy   — upsert (superadmin; itself audited)
 *   GET /v1/host/openwop-app/governance/audit    — the audit READ VIEW over
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
import { mediaDailyBudget, resolveBudget } from '../aiProviders/mediaBudget.js';
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
  app.get('/v1/host/openwop-app/governance/policy', async (req, res, next) => {
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

  // ADR 0106 Phase 3 — read-only media-generation budget + today's usage for the
  // superadmin Governance panel. Budgets are operator env-configured
  // (OPENWOP_MEDIA_DAILY_{TTS_CHARS,STT_BYTES}); 0 ⇒ uncapped. Usage is this
  // tenant's accumulation for the current UTC day.
  app.get('/v1/host/openwop-app/governance/media-budget', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const date = new Date().toISOString().slice(0, 10);
      const env = mediaDailyBudget();
      const effective = await resolveBudget(tenantOf(req)); // override-aware (ADR 0106)
      const override = (await getGovernancePolicy(tenantOf(req)))?.mediaBudget ?? null;
      const usage = await deps.storage.getMediaUsage(tenantOf(req), date);
      res.json({
        date,
        // The EFFECTIVE caps actually enforced (override wins over env; 0 = uncapped).
        budgets: { ttsChars: effective.tts, sttBytes: effective.stt },
        envDefaults: { ttsChars: env.tts, sttBytes: env.stt },
        override, // the per-org override (or null) — what the editor binds to
        usage,
      });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0106 (editable override) — set/clear the per-org media budget override.
  // Body: { ttsChars?, sttBytes? } — a finite ≥0 number sets that kind's cap
  // (0 ⇒ uncapped for this org); `null` CLEARS that field (falls back to the env
  // default). A read-modify-write that preserves the other policy fields (the
  // policy store does a full replace).
  app.put('/v1/host/openwop-app/governance/media-budget', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const body = (req.body ?? {}) as { ttsChars?: unknown; sttBytes?: unknown };
      const field = (name: 'ttsChars' | 'sttBytes'): number | undefined => {
        const v = body[name];
        if (v === undefined || v === null) return undefined; // cleared ⇒ fall to env default
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw new OpenwopError('validation_error', `\`${name}\` MUST be null or a non-negative number.`, 400, { field: name });
        }
        return Math.floor(v);
      };
      const ttsChars = field('ttsChars');
      const sttBytes = field('sttBytes');
      const mediaBudget = {
        ...(ttsChars !== undefined ? { ttsChars } : {}),
        ...(sttBytes !== undefined ? { sttBytes } : {}),
      };
      const current = await getGovernancePolicy(tenantOf(req));
      const updatedBy = req.userId ?? req.principal?.principalId;
      await setGovernancePolicy(
        tenantOf(req),
        {
          ...(current?.providerAllowlist !== undefined ? { providerAllowlist: current.providerAllowlist } : {}),
          ...(current?.actionPolicy !== undefined ? { actionPolicy: current.actionPolicy } : {}),
          ...(current?.retention !== undefined ? { retention: current.retention } : {}),
          mediaBudget,
        },
        updatedBy,
      );
      void deps.storage
        .appendAudit({
          timestamp: new Date().toISOString(),
          principalId: updatedBy ?? 'unknown',
          action: 'governance.media-budget.updated',
          resource: `tenant:${tenantOf(req)}`,
          outcome: 'success',
          payload: { mediaBudget },
        })
        .catch(() => undefined);
      const effective = await resolveBudget(tenantOf(req));
      res.json({ override: mediaBudget, budgets: { ttsChars: effective.tts, sttBytes: effective.stt } });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/governance/policy', async (req, res, next) => {
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
      // The two DELETION-driving windows (GOV-2) are validated strictly: the sweep computes
      // `cutoff = now - days*DAY`, so a negative/NaN value would push the cutoff into the
      // future and purge EVERYTHING. Reject anything that isn't a finite, non-negative number.
      const retentionWindow = (field: 'confidentialPiiDays' | 'internalDays'): number | undefined => {
        const v = (body.retention as Record<string, unknown> | undefined)?.[field];
        if (v === undefined) return undefined;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw new OpenwopError('validation_error', `\`retention.${field}\` MUST be a non-negative number of days.`, 400, {});
        }
        return v;
      };
      const confidentialPiiDays = retentionWindow('confidentialPiiDays'); // validated once
      const internalDays = retentionWindow('internalDays');
      const retention =
        body.retention && typeof body.retention === 'object'
          ? {
              ...(typeof (body.retention as Record<string, unknown>).assistantGraphDays === 'number'
                ? { assistantGraphDays: (body.retention as Record<string, number>).assistantGraphDays }
                : {}),
              ...(typeof (body.retention as Record<string, unknown>).sourceDerivedDays === 'number'
                ? { sourceDerivedDays: (body.retention as Record<string, number>).sourceDerivedDays }
                : {}),
              ...(confidentialPiiDays !== undefined ? { confidentialPiiDays } : {}),
              ...(internalDays !== undefined ? { internalDays } : {}),
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

  app.get('/v1/host/openwop-app/governance/audit', async (req, res, next) => {
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
