/**
 * Personal settings (ADR 0396) — the backend half of the consolidation: the
 * per-user server-authoritative prefs (`prefsStore.ts`), the self-scoped
 * `GET/PUT /settings/prefs` routes, and the DI wiring that injects the
 * personal lanes into core:
 *   - `configurePersonalByokBudget` → the ADR 0178 seam gains the personal
 *     min() lane (self-service; can only LOWER effective spend);
 *   - `configureUserReasoningOverride` → the RFC 0030 directive gains a
 *     per-user strength override (host-wide advertisement unchanged).
 * Both are inversions — core never imports this feature.
 *
 * The `settings-shell` toggle gates the consolidated /settings SURFACE (FE);
 * budget ENFORCEMENT is deliberately independent of it (a safety concern,
 * off by default per user — matrix row 2).
 */
import type { BackendFeature } from '../types.js';
import { registerSettingsRoutes } from './routes.js';
import { configurePersonalByokBudget } from '../../aiProviders/byokChatBudget.js';
import { configureUserReasoningOverride } from '../../host/envelopeReasoningConfig.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createLogger } from '../../observability/logger.js';
import { getUserPrefs, getUserByokUsage, incrementUserByokUsage } from './prefsStore.js';

const log = createLogger('features.settings');
const DEFAULT_SOFT_WARNING_PCT = 80;

export const settingsFeature: BackendFeature = {
  id: 'settings',
  registerRoutes: (deps) => {
    registerSettingsRoutes(deps);
    // ── The personal BYOK budget lane (ADR 0396 P3, composing ADR 0178). ────
    configurePersonalByokBudget({
      async resolveCap(tenantId, userId) {
        const prefs = await getUserPrefs(tenantId, userId);
        const budget = prefs?.personalBudget;
        if (!budget || budget.dailyTokenCap <= 0) return null;
        return { dailyTokenCap: budget.dailyTokenCap, softWarningPct: budget.softWarningPct ?? DEFAULT_SOFT_WARNING_PCT };
      },
      async getUsed(tenantId, userId, dayUtc) {
        const u = await getUserByokUsage(tenantId, userId, dayUtc);
        return u.inputTokens + u.outputTokens;
      },
      async record(tenantId, userId, dayUtc, inputTokens, outputTokens) {
        // Threshold-crossing detection brackets the increment so the alert
        // fires ONCE per crossing (best-effort; the inline ByokBudgetNotice is
        // the primary surface).
        const prefs = await getUserPrefs(tenantId, userId);
        const budget = prefs?.personalBudget;
        const before = budget && budget.dailyTokenCap > 0 ? await getUserByokUsage(tenantId, userId, dayUtc) : null;
        await incrementUserByokUsage(tenantId, userId, dayUtc, inputTokens, outputTokens);
        if (!budget || budget.dailyTokenCap <= 0 || !before) return;
        const warnPct = budget.softWarningPct ?? DEFAULT_SOFT_WARNING_PCT;
        const beforePct = ((before.inputTokens + before.outputTokens) / budget.dailyTokenCap) * 100;
        const afterPct = ((before.inputTokens + before.outputTokens + inputTokens + outputTokens) / budget.dailyTokenCap) * 100;
        if (beforePct < warnPct && afterPct >= warnPct) {
          try {
            await getNotificationEmitter().emit({
              tenantId,
              recipientUserId: userId,
              type: 'byok-personal-budget-warning',
              priority: 'normal',
              title: 'Personal AI budget threshold crossed',
              message: `You have used ${Math.round(afterPct)}% of your personal daily BYOK token budget. The hard limit blocks further BYOK turns until 00:00 UTC.`,
              actionUrl: '/settings#ai',
            });
          } catch (err) {
            log.warn('personal_budget_alert_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
          }
        }
      },
    });
    // ── The per-user reasoning-directive override (ADR 0396 P4). ────────────
    configureUserReasoningOverride(async (tenantId, userId) => {
      const prefs = await getUserPrefs(tenantId, userId);
      return prefs?.reasoningDirective ?? null;
    });
  },
  toggleDefault: {
    id: 'settings-shell',
    label: 'Settings (consolidated)',
    description:
      'The consolidated /settings page: General (theme, motion, density), Accessibility depth (text size, focus '
      + 'indicator), personal AI Usage & Budget (a self-service daily BYOK token cap that can only lower the org '
      + 'backstop), Agent Escalation (per-user reasoning-directive strength), Privacy opt-outs, and Account '
      + 'deep-links. Composition only — every capability keeps its owning feature. OFF by default.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'settings-shell',
  },
};
