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

import type { Express, Request, Response } from 'express';
import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { requireSuperadmin } from '../host/superadmin.js';
import { requireTenantScope } from '../features/featureRoute.js';
import { listChain, verifyChain, getAuditHead } from '../host/auditChainService.js';
import { mediaDailyBudget, resolveBudget, checkMediaBudget } from '../aiProviders/mediaBudget.js';
import { resolveByokBudget } from '../aiProviders/byokChatBudget.js';
import { getEgressRules, putEgressRules } from '../host/egressPolicy.js';
import {
  getGovernancePolicy,
  setGovernancePolicy,
  type ActionKindPolicy,
} from '../host/governanceService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.governance');

const ACTION_KINDS = ['email.send', 'calendar.invite', 'calendar.reschedule', 'nudge', 'ads.publish', 'ads.budget', 'servicedesk.reply'] as const;
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

/**
 * COS-2 — the retention windows that are DECLARED nowhere and enforced nowhere.
 * Neither is read by any sweep (`host/retentionSweepDaemon.ts` honours
 * `confidentialPiiDays` / `internalDays` only), and neither survives on the
 * `GovernancePolicy` type. Rows persisted before the removal may still carry
 * them, so both the read and the write path have to cope.
 */
const DEAD_RETENTION_FIELDS = ['assistantGraphDays', 'sourceDerivedDays'] as const;

/** The exit, stated once so the GET and the PUT cannot drift apart. */
const deadRetentionMessage = (field: string): string =>
  `\`retention.${field}\` is not enforced by any sweep and is ignored. `
  + 'Use `retention.confidentialPiiDays` / `retention.internalDays`, which the '
  + 'retention sweep daemon honours per DataClassification (ADR 0077 P3). Assistant '
  + 'graph rows are reached by data-subject erasure (features/assistant/erasure.ts).';

/** Which dead windows a `retention` object carries, as operator-facing warnings. */
function deadRetentionWarnings(retention: unknown): string[] {
  const r = retention as Record<string, unknown> | undefined | null;
  if (!r || typeof r !== 'object') return [];
  return DEAD_RETENTION_FIELDS.filter((f) => r[f] !== undefined).map(deadRetentionMessage);
}

/** Drop the dead windows from a policy on the way OUT, so a GET → edit → PUT
 *  round-trip cannot keep reproducing them. The stored row is left alone (the
 *  fields are inert); what changes is that the API stops advertising a control
 *  that does nothing. */
function withoutDeadRetention<T extends { retention?: Record<string, unknown> }>(policy: T): T {
  if (!policy.retention || typeof policy.retention !== 'object') return policy;
  if (!DEAD_RETENTION_FIELDS.some((f) => policy.retention![f] !== undefined)) return policy;
  const retention = { ...policy.retention };
  for (const f of DEAD_RETENTION_FIELDS) delete retention[f];
  return { ...policy, retention };
}

export function registerGovernanceRoutes(app: Express, deps: { storage: Storage }): void {
  app.get('/v1/host/openwop-app/governance/policy', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const policy = await getGovernancePolicy(tenantOf(req));
      // COS-2 — a legacy row may still carry the two dead windows. Strip them
      // from the response (and say why) rather than handing a caller a control
      // that does nothing and then rejecting it when they hand it back.
      const warnings = deadRetentionWarnings((policy as { retention?: unknown } | null)?.retention);
      res.json({
        policy: policy ? withoutDeadRetention(policy as never) : { tenantId: tenantOf(req) },
        defaults: { actionPolicy: 'approval-required', providerAllowlist: null },
        actionKinds: ACTION_KINDS,
        ...(warnings.length > 0 ? { warnings } : {}),
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
      // ADR 0401 P4 / 0411 P2 — the images + video units (KV-counted) report through the same panel.
      const imagesCheck = await checkMediaBudget(tenantOf(req), 'images', 0);
      const videoCheck = await checkMediaBudget(tenantOf(req), 'video', 0);
      res.json({
        date,
        // The EFFECTIVE caps actually enforced (override wins over env; 0 = uncapped).
        budgets: { ttsChars: effective.tts, sttBytes: effective.stt, images: effective.images, video: effective.video },
        envDefaults: { ttsChars: env.tts, sttBytes: env.stt, images: env.images, video: env.video },
        override, // the per-org override (or null) — what the editor binds to
        usage: { ...usage, images: imagesCheck.used, video: videoCheck.used },
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
      const body = (req.body ?? {}) as { ttsChars?: unknown; sttBytes?: unknown; images?: unknown; videoJobs?: unknown };
      const field = (name: 'ttsChars' | 'sttBytes' | 'images' | 'videoJobs'): number | undefined => {
        const v = body[name];
        if (v === undefined || v === null) return undefined; // cleared ⇒ fall to env default
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw new OpenwopError('validation_error', `\`${name}\` MUST be null or a non-negative number.`, 400, { field: name });
        }
        return Math.floor(v);
      };
      const ttsChars = field('ttsChars');
      const sttBytes = field('sttBytes');
      const images = field('images');
      const videoJobs = field('videoJobs');
      const mediaBudget = {
        ...(ttsChars !== undefined ? { ttsChars } : {}),
        ...(sttBytes !== undefined ? { sttBytes } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(videoJobs !== undefined ? { videoJobs } : {}),
      };
      const updatedBy = req.userId ?? req.principal?.principalId;
      // Patch-merge (grade-pass DEBT-1): absent fields PRESERVE at the service.
      await setGovernancePolicy(tenantOf(req), { mediaBudget }, updatedBy);
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
      res.json({ override: mediaBudget, budgets: { ttsChars: effective.tts, sttBytes: effective.stt, images: effective.images, video: effective.video } });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0178 Phase 3 — read-only BYOK LLM chat spend budget + today's usage for
  // the superadmin Governance panel. The cap is operator env-configured
  // (OPENWOP_BYOK_DAILY_TOKEN_CAP; 0 ⇒ uncapped) with a per-org override. Usage is
  // keyed per (tenant, provider); pass ?provider=<id> to read a specific provider's
  // accumulation for the current UTC day (else zero).
  app.get('/v1/host/openwop-app/governance/byok-chat-budget', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const date = new Date().toISOString().slice(0, 10);
      const effective = await resolveByokBudget(tenantOf(req)); // override-aware (ADR 0178)
      const override = (await getGovernancePolicy(tenantOf(req)))?.byokChatBudget ?? null;
      const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
      const usage = provider
        ? await deps.storage.getByokChatUsage(tenantOf(req), provider, date)
        : { inputTokens: 0, outputTokens: 0 };
      res.json({
        date,
        // The EFFECTIVE budget actually enforced (override wins over env; 0 = uncapped).
        budget: { dailyTokenCap: effective.dailyTokenCap, softWarningPct: effective.softWarningPct },
        envDefaults: { dailyTokenCap: Number(process.env.OPENWOP_BYOK_DAILY_TOKEN_CAP) || 0 },
        override, // the per-org override (or null) — what the editor binds to
        ...(provider ? { provider, usage } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0178 (editable override) — set/clear the per-org BYOK chat spend budget
  // override. Body: { dailyTokenCap?, softWarningPct? } — a finite integer cap ≥0
  // (0 ⇒ uncapped for this org); a softWarningPct in [0,100]; `null` CLEARS that
  // field (falls back to the env default / the 80% default). A read-modify-write
  // that preserves the other policy fields (the policy store does a full replace).
  app.put('/v1/host/openwop-app/governance/byok-chat-budget', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const body = (req.body ?? {}) as { dailyTokenCap?: unknown; softWarningPct?: unknown };
      const dailyTokenCap = ((): number | undefined => {
        const v = body.dailyTokenCap;
        if (v === undefined || v === null) return undefined; // cleared ⇒ fall to env default
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
          throw new OpenwopError('validation_error', '`dailyTokenCap` MUST be null or a non-negative integer.', 400, { field: 'dailyTokenCap' });
        }
        return v;
      })();
      const softWarningPct = ((): number | undefined => {
        const v = body.softWarningPct;
        if (v === undefined || v === null) return undefined; // cleared ⇒ fall to the 80% default
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
          throw new OpenwopError('validation_error', '`softWarningPct` MUST be null or a number in [0, 100].', 400, { field: 'softWarningPct' });
        }
        return v;
      })();
      const byokChatBudget = {
        ...(dailyTokenCap !== undefined ? { dailyTokenCap } : {}),
        ...(softWarningPct !== undefined ? { softWarningPct } : {}),
      };
      const updatedBy = req.userId ?? req.principal?.principalId;
      // Patch-merge (grade-pass DEBT-1 — the hand-kept preserve list here
      // shipped the SEC-C1 requireMfa wipe; the service now preserves).
      await setGovernancePolicy(tenantOf(req), { byokChatBudget }, updatedBy);
      void deps.storage
        .appendAudit({
          timestamp: new Date().toISOString(),
          principalId: updatedBy ?? 'unknown',
          action: 'governance.byok-chat-budget.updated',
          resource: `tenant:${tenantOf(req)}`,
          outcome: 'success',
          payload: { tenantId: tenantOf(req), byokChatBudget },
        })
        .catch(() => undefined);
      const effective = await resolveByokBudget(tenantOf(req));
      res.json({
        override: byokChatBudget,
        budget: { dailyTokenCap: effective.dailyTokenCap, softWarningPct: effective.softWarningPct },
      });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0187 — the per-tenant egress firewall rules. Superadmin-managed; layered
  // on top of the always-on SSRF baseline.
  app.get('/v1/host/openwop-app/governance/egress-rules', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const rules = await getEgressRules(tenantOf(req));
      res.json({ mode: rules.mode, hosts: rules.hosts });
    } catch (err) {
      next(err);
    }
  });

  // Body: { mode: 'off'|'allowlist'|'denylist', hosts: string[] }. Hosts are
  // normalized + de-duped; each matches itself + any subdomain (suffix). The
  // SSRF baseline (private/loopback/metadata) is never relaxed by an allowlist.
  app.put('/v1/host/openwop-app/governance/egress-rules', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const body = (req.body ?? {}) as { mode?: unknown; hosts?: unknown };
      if (body.mode !== 'off' && body.mode !== 'allowlist' && body.mode !== 'denylist') {
        throw new OpenwopError('validation_error', '`mode` MUST be one of "off" | "allowlist" | "denylist".', 400, { field: 'mode' });
      }
      if (!Array.isArray(body.hosts) || !body.hosts.every((h) => typeof h === 'string')) {
        throw new OpenwopError('validation_error', '`hosts` MUST be an array of strings.', 400, { field: 'hosts' });
      }
      const saved = await putEgressRules(tenantOf(req), body.mode, body.hosts);
      const updatedBy = req.userId ?? req.principal?.principalId;
      void deps.storage
        .appendAudit({
          timestamp: new Date().toISOString(),
          principalId: updatedBy ?? 'unknown',
          action: 'governance.egress-rules.updated',
          resource: `tenant:${tenantOf(req)}`,
          outcome: 'success',
          payload: { tenantId: tenantOf(req), mode: saved.mode, hostCount: saved.hosts.length },
        })
        .catch(() => undefined);
      res.json({ mode: saved.mode, hosts: saved.hosts });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/governance/policy', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Governance administration');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const providerAllowlist =
        body.providerAllowlist === undefined || body.providerAllowlist === null
          ? undefined // null = explicit clear, handled in the merge below
          : Array.isArray(body.providerAllowlist)
            ? body.providerAllowlist.filter((p): p is string => typeof p === 'string')
            : (() => {
                throw new OpenwopError('validation_error', '`providerAllowlist` MUST be an array of provider ids (or null to clear).', 400, {});
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
      // COS-2 — the two dead windows are STRIPPED AND REPORTED, never persisted.
      // `retention.assistantGraphDays` / `sourceDerivedDays` were accepted here,
      // stored, and read by NOTHING repo-wide: an operator set a retention
      // window, got a 200, and nothing was ever purged. A dishonest control
      // surface is worse than a missing one, because it stops the operator
      // looking for the real answer.
      //
      // CORRECTED (adversarial review, 2026-08-19): this was first written as a
      // hard 400, and a hard 400 BREAKS THE READ-MODIFY-WRITE. This route's GET
      // returns the persisted policy verbatim, and the removal deliberately
      // leaves the dead fields on rows that already carry them — so on any
      // tenant that ever set one, GET → edit → PUT now 400s and blocks EVERY
      // OTHER governance change (providerAllowlist, actionPolicy, requireMfa,
      // the two live retention windows) until an operator hand-strips a field
      // they did not add. Refusing an input the surface itself just handed you
      // is not honesty, it is a dead end; the honest form is to drop the value,
      // say so, and NAME the exit — the two windows `host/retentionSweepDaemon.ts`
      // actually enforces. `deadRetentionWarnings` also strips them from the GET
      // (below), so a round-trip stops reproducing them at all.
      const warnings = deadRetentionWarnings(body.retention);
      const confidentialPiiDays = retentionWindow('confidentialPiiDays'); // validated once
      const internalDays = retentionWindow('internalDays');
      const retention =
        body.retention && typeof body.retention === 'object'
          ? {
              ...(confidentialPiiDays !== undefined ? { confidentialPiiDays } : {}),
              ...(internalDays !== undefined ? { internalDays } : {}),
            }
          : undefined;
      // Campaign gap plan §5B B3 — ad-spend approval threshold (minor units).
      // `null` clears it; a finite ≥0 number sets it.
      let adSpend: { approvalThresholdMinor?: number } | undefined;
      if (body.adSpend !== undefined) {
        if (body.adSpend === null) {
          adSpend = {};
        } else if (typeof body.adSpend === 'object') {
          const t = (body.adSpend as Record<string, unknown>).approvalThresholdMinor;
          if (t === undefined || t === null) adSpend = {};
          else if (typeof t === 'number' && Number.isFinite(t) && t >= 0) adSpend = { approvalThresholdMinor: Math.floor(t) };
          else throw new OpenwopError('validation_error', '`adSpend.approvalThresholdMinor` MUST be null or a non-negative number (minor units).', 400, {});
        } else {
          throw new OpenwopError('validation_error', '`adSpend` MUST be an object or null.', 400, {});
        }
      }
      // Ecommerce gap plan §5B B3 — commerce order/refund approval thresholds
      // (minor units). Same contract as `adSpend`: `null` clears; finite ≥0 sets.
      let commerce: { orderApprovalThresholdMinor?: number; refundApprovalThresholdMinor?: number } | undefined;
      if (body.commerce !== undefined) {
        if (body.commerce === null) {
          commerce = {};
        } else if (typeof body.commerce === 'object') {
          commerce = {};
          for (const field of ['orderApprovalThresholdMinor', 'refundApprovalThresholdMinor'] as const) {
            const t = (body.commerce as Record<string, unknown>)[field];
            if (t === undefined || t === null) continue;
            if (typeof t === 'number' && Number.isFinite(t) && t >= 0) commerce[field] = Math.floor(t);
            else throw new OpenwopError('validation_error', `\`commerce.${field}\` MUST be null or a non-negative number (minor units).`, 400, {});
          }
        } else {
          throw new OpenwopError('validation_error', '`commerce` MUST be an object or null.', 400, {});
        }
      }
      // BRAND-CODE-6 — tenant-default brand compliance policy. Contract: `null`
      // (or an object with `blockPublish:'off'`) is the cleared/no-op posture; an
      // object sets it. `blockPublish` is REQUIRED and one of off|critical|threshold;
      // `blockThreshold` is an optional non-negative number; `defaultBrandId` is an
      // optional string (the brand whose rules govern unbriefed publishAd dispatch).
      let brandCompliance: { blockPublish: 'off' | 'critical' | 'threshold'; blockThreshold?: number; defaultBrandId?: string } | undefined;
      let brandComplianceCleared = false;
      if (body.brandCompliance !== undefined) {
        if (body.brandCompliance === null) {
          brandComplianceCleared = true;
        } else if (typeof body.brandCompliance === 'object') {
          const bc = body.brandCompliance as Record<string, unknown>;
          if (bc.blockPublish !== 'off' && bc.blockPublish !== 'critical' && bc.blockPublish !== 'threshold') {
            throw new OpenwopError('validation_error', '`brandCompliance.blockPublish` MUST be one of "off" | "critical" | "threshold".', 400, { field: 'brandCompliance.blockPublish' });
          }
          let blockThreshold: number | undefined;
          if (bc.blockThreshold !== undefined && bc.blockThreshold !== null) {
            if (typeof bc.blockThreshold !== 'number' || !Number.isFinite(bc.blockThreshold) || bc.blockThreshold < 0) {
              throw new OpenwopError('validation_error', '`brandCompliance.blockThreshold` MUST be a non-negative number.', 400, { field: 'brandCompliance.blockThreshold' });
            }
            blockThreshold = bc.blockThreshold;
          }
          let defaultBrandId: string | undefined;
          if (bc.defaultBrandId !== undefined && bc.defaultBrandId !== null) {
            if (typeof bc.defaultBrandId !== 'string') {
              throw new OpenwopError('validation_error', '`brandCompliance.defaultBrandId` MUST be a string.', 400, { field: 'brandCompliance.defaultBrandId' });
            }
            defaultBrandId = bc.defaultBrandId;
          }
          brandCompliance = {
            blockPublish: bc.blockPublish,
            ...(blockThreshold !== undefined ? { blockThreshold } : {}),
            ...(defaultBrandId !== undefined ? { defaultBrandId } : {}),
          };
        } else {
          throw new OpenwopError('validation_error', '`brandCompliance` MUST be an object or null.', 400, {});
        }
      }
      // ADR 0389 P4 — tenant MFA enforcement flag. `null` clears; boolean sets.
      let requireMfa: boolean | undefined;
      let requireMfaCleared = false;
      if (body.requireMfa !== undefined) {
        if (body.requireMfa === null) requireMfaCleared = true;
        else if (typeof body.requireMfa === 'boolean') requireMfa = body.requireMfa;
        else throw new OpenwopError('validation_error', '`requireMfa` MUST be a boolean or null.', 400, { field: 'requireMfa' });
      }
      const updatedBy = req.userId ?? req.principal?.principalId;
      // Patch-merge (grade-pass DEBT-1/SEC-C12): present = set, explicit null =
      // clear, absent = preserved by the service. No hand-kept preserve list.
      const policy = await setGovernancePolicy(
        tenantOf(req),
        {
          ...(providerAllowlist !== undefined ? { providerAllowlist } : body.providerAllowlist === null ? { providerAllowlist: null } : {}),
          ...(parseActionPolicy(body.actionPolicy) !== undefined ? { actionPolicy: parseActionPolicy(body.actionPolicy) } : {}),
          ...(retention !== undefined ? { retention } : body.retention === null ? { retention: null } : {}),
          ...(adSpend !== undefined ? { adSpend } : {}),
          ...(commerce !== undefined ? { commerce } : {}),
          ...(brandCompliance !== undefined ? { brandCompliance } : brandComplianceCleared ? { brandCompliance: null } : {}),
          ...(requireMfa !== undefined ? { requireMfa } : requireMfaCleared ? { requireMfa: null } : {}),
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
      // COS-2 — the operator DID get told, on a 200 that did not block the rest
      // of their edit. Also logged, because a script client will not read this.
      if (warnings.length > 0) {
        log.warn('governance_dead_retention_ignored', {
          tenantId: tenantOf(req),
          fields: DEAD_RETENTION_FIELDS.filter((f) => (body.retention as Record<string, unknown> | undefined)?.[f] !== undefined),
        });
      }
      res.json({ policy: withoutDeadRetention(policy as never), ...(warnings.length > 0 ? { warnings } : {}) });
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
      // ADR 0416 P2 — optional download serialization of the SAME scoped rows.
      // No integrity proof here: the flat audit_log is not the hash chain (the
      // provable export is /governance/audit/export below).
      const format = typeof req.query.format === 'string' ? req.query.format : '';
      if (format === 'csv' || format === 'jsonl') {
        sendAuditDownload(res, `audit-log.${format}`, format, scoped.map((r) => ({
          timestamp: r.timestamp, principalId: r.principalId, action: r.action, resource: r.resource, outcome: r.outcome, payload: r.payload ?? {},
        })));
        return;
      }
      res.json({ items: scoped });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0416 P2 — the tenant-admin audit-chain export: "your audit trail is
  // yours." Exports the caller tenant's ADR 0301 tamper-evident chain with an
  // integrity proof (head pointer + a fresh verifyChain attestation) so an
  // auditor can verify the records offline. Authority: the tenant-level
  // `host:members:manage` gate (the 2026-07 vuln-scan seam) — NEVER cross-
  // tenant (the chain read is keyed by the caller's own tenant, no override).
  app.get('/v1/host/openwop-app/governance/audit/export', async (req, res, next) => {
    try {
      await requireTenantScope(req, 'host:members:manage');
      const tenantId = tenantOf(req);
      const format = req.query.format === 'csv' ? 'csv' : 'jsonl';
      const entries = await listChain(tenantId);
      const head = await getAuditHead(tenantId);
      const verified = await verifyChain(tenantId);
      const proof = {
        proof: true, tenantId, exportedAt: new Date().toISOString(), entries: entries.length,
        head: head ?? null, verified: verified.ok, ...(verified.ok ? {} : { brokenAt: verified.brokenAt }),
      };
      if (format === 'csv') {
        // Proof rides response headers (a CSV body stays purely tabular).
        res.setHeader('x-audit-head-seq', String(head?.seq ?? 0));
        res.setHeader('x-audit-head-hash', head?.headHash ?? '');
        res.setHeader('x-audit-verified', String(verified.ok));
        sendAuditDownload(res, 'audit-chain.csv', 'csv', entries.map((e) => ({
          seq: e.seq, at: e.at, kind: e.kind, prevHash: e.prevHash, entryHash: e.entryHash, payload: e.payload,
        })));
        return;
      }
      // JSONL: line 1 is the proof object, then one chain entry per line.
      res.setHeader('content-type', 'application/x-ndjson');
      res.setHeader('content-disposition', 'attachment; filename="audit-chain.jsonl"');
      res.send([JSON.stringify(proof), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n');
    } catch (err) {
      next(err);
    }
  });
}

/** Serialize rows as a CSV or JSONL attachment. CSV cells are RFC-4180-escaped;
 *  object cells (payload) are embedded as JSON. */
function sendAuditDownload(res: Response, filename: string, format: 'csv' | 'jsonl', rows: Array<Record<string, unknown>>): void {
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  if (format === 'jsonl') {
    res.setHeader('content-type', 'application/x-ndjson');
    res.send(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    return;
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const cell = (v: unknown): string => {
    const s = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))];
  res.send(lines.join('\r\n') + (rows.length ? '\r\n' : ''));
}
