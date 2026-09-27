/**
 * Personal settings routes (ADR 0396 §4) — SELF-SCOPED: every read/write is
 * keyed by the AUTHENTICATED user's own id (never a request-supplied id —
 * IDOR-safe by construction). The prefs here are the server-authoritative
 * tier only (budget / escalation / privacy); cosmetic prefs stay client-side.
 *
 *   GET /v1/host/openwop-app/settings/prefs        — the caller's prefs + today's usage
 *   PUT /v1/host/openwop-app/settings/prefs        — update (partial; null clears a group)
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { getUserPrefs, putUserPrefs, getUserByokUsage, type PersonalBudgetPref, type PrivacyPrefs } from './prefsStore.js';
import { describeOwnManagedUsage } from '../../providers/managedProvider.js';
import type { ReasoningDirectiveStrength } from '../../host/envelopeDirective.js';

const BASE = '/v1/host/openwop-app/settings/prefs';
const STRENGTHS = new Set<ReasoningDirectiveStrength>(['off', 'advisory', 'mandatory']);
const MAX_DAILY_TOKEN_CAP = 1_000_000_000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseBudget(v: unknown): PersonalBudgetPref | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new OpenwopError('validation_error', '`personalBudget` must be an object or null.', 400, { field: 'personalBudget' });
  }
  const o = v as Record<string, unknown>;
  const cap = Number(o.dailyTokenCap);
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_DAILY_TOKEN_CAP) {
    throw new OpenwopError('validation_error', `\`personalBudget.dailyTokenCap\` must be an integer between 0 and ${MAX_DAILY_TOKEN_CAP} (tokens; 0 clears the cap).`, 400, { field: 'personalBudget.dailyTokenCap' });
  }
  let softWarningPct: number | undefined;
  if (o.softWarningPct !== undefined) {
    softWarningPct = Number(o.softWarningPct);
    if (!Number.isInteger(softWarningPct) || softWarningPct < 1 || softWarningPct > 100) {
      throw new OpenwopError('validation_error', '`personalBudget.softWarningPct` must be an integer between 1 and 100.', 400, { field: 'personalBudget.softWarningPct' });
    }
  }
  if (cap === 0) return null; // 0 = clear the personal cap
  return { dailyTokenCap: cap, ...(softWarningPct !== undefined ? { softWarningPct } : {}) };
}

function parsePrivacy(v: unknown): PrivacyPrefs | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new OpenwopError('validation_error', '`privacy` must be an object or null.', 400, { field: 'privacy' });
  }
  const o = v as Record<string, unknown>;
  return {
    ...(o.analyticsOptOut !== undefined ? { analyticsOptOut: o.analyticsOptOut === true } : {}),
    ...(o.crashReportsOptOut !== undefined ? { crashReportsOptOut: o.crashReportsOptOut === true } : {}),
    ...(o.recentFilesOptOut !== undefined ? { recentFilesOptOut: o.recentFilesOptOut === true } : {}),
  };
}

export function registerSettingsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const prefs = await getUserPrefs(user.tenantId, user.userId);
      const usage = await getUserByokUsage(user.tenantId, user.userId, todayUtc());
      // ADR 0693 phase 5 — the managed free tier's own-usage read lands HERE,
      // beside the BYOK figure, rather than on a new endpoint. This route is
      // already the answer to "how much have I used today"; a second endpoint
      // for the second lane would make a user check two places to learn one
      // thing, and would be the parallel-surface mistake this repo keeps paying
      // for. `null` when no managed target is configured — a white-label
      // deployment with no free tier has nothing to report, which is different
      // from reporting zero.
      //
      // The read composes the SAME bucket the dispatcher charges: the ACTIVE
      // workspace (`tenantOf(req)` — the `ws:`/host workspace a switched user is
      // in) and the acting subject `runs.ts` stamps on every run
      // (`req.userId ?? principalId`, i.e. `callerSubject`). `user.tenantId` is
      // the caller's HOME tenant (resolveCallerUser canonicalises on it), which is
      // the personal `user:` tenant — a single-principal bucket that no shared-
      // workspace turn ever charges. Measured on kicktodo.com 2026-09-16: two
      // participants switched into `host-kicktodo` both read `scope: 'tenant'`,
      // tokens 0, while their turns were metered per subject on the workspace.
      const managedUsageToday = await describeOwnManagedUsage(tenantOf(req), callerSubject(req) ?? user.userId).catch(() => null);
      res.json({
        personalBudget: prefs?.personalBudget ?? null,
        reasoningDirective: prefs?.reasoningDirective ?? null,
        privacy: prefs?.privacy ?? null,
        usageToday: { day: todayUtc(), tokens: usage.inputTokens + usage.outputTokens },
        managedUsageToday,
      });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      let reasoningDirective: ReasoningDirectiveStrength | null | undefined;
      if (body.reasoningDirective === undefined) reasoningDirective = undefined;
      else if (body.reasoningDirective === null) reasoningDirective = null;
      else if (typeof body.reasoningDirective === 'string' && STRENGTHS.has(body.reasoningDirective as ReasoningDirectiveStrength)) {
        reasoningDirective = body.reasoningDirective as ReasoningDirectiveStrength;
      } else {
        throw new OpenwopError('validation_error', "`reasoningDirective` must be 'off' | 'advisory' | 'mandatory' | null.", 400, { field: 'reasoningDirective' });
      }
      const saved = await putUserPrefs(user.tenantId, user.userId, {
        personalBudget: parseBudget(body.personalBudget),
        reasoningDirective,
        privacy: parsePrivacy(body.privacy),
      });
      res.json({
        personalBudget: saved.personalBudget ?? null,
        reasoningDirective: saved.reasoningDirective ?? null,
        privacy: saved.privacy ?? null,
      });
    } catch (err) { next(err); }
  });
}
