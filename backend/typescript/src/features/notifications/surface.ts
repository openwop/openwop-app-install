/**
 * `ctx.features.notifications` — the workflow-node seam over the ONE notification
 * owner, `notifications/emitter.ts`.
 *
 * WHY THIS EXISTS. 55 chain nodes across 53 shipped chains used
 * `core.openwop.integration.notification-push`, whose input schema requires a
 * `deviceToken` — a per-recipient RUNTIME value no chain author can know. Zero of
 * the 55 bound it, so the Expo adapter POSTed `to: undefined`, errored, and the
 * node returned `status:'success'` with `sent:false`. A run whose only outbound
 * action failed completed GREEN.
 *
 * Those chains never wanted a device push. They wanted an IN-APP inbox
 * notification — a concept that already had exactly one owner (the emitter:
 * durable row + SSE + Web Push + Teams + email) and no node exposing it. This is
 * that node's surface. It adds no second notification model; it makes the
 * existing one reachable from a workflow.
 *
 * AUDIENCE IS EXPLICIT, and that is a deliberate override of the earlier
 * "recipient comes from the run, no input needed" design. `BundleScope.actingUserId`
 * is documented as "Absent for system runs (schedule / inbound webhook — no
 * human), which is the correct fail-closed signal" — and of the 53 chains only 3
 * are event/form triggered. Inferring the audience would silently change WHO gets
 * notified based on how the run happened to start, which is how the next
 * silent-delivery defect gets authored. So the caller names it, and a `self`
 * notification on a run with no acting human REFUSES rather than quietly
 * broadcasting to the whole tenant.
 *
 * The three audiences map 1:1 onto the ADR 0050 targeting modes already in
 * `NotificationRecord`: `tenant` (broadcast, no recipient field), `self`
 * (`recipientUserId`, default-deny), `role:<name>` (`recipientRole`, default-deny).
 *
 * NOTE on `role:` — the mode was declared, persisted and read-filtered, but
 * `emitter.buildRecord` DROPPED the field, so no caller could ever reach it. Fixed
 * alongside this surface. Nothing wrote it before, so no live data was affected;
 * unfixed it would have made every `role:` notice a tenant-wide broadcast, which is
 * the inverse of the default-deny guarantee.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import type { NotificationPriority } from '../../types.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.notifications.surface');

/** `tenant` | `self` | `role:<roleName>`. */
const ROLE_PREFIX = 'role:';

export interface NotifyEmitArgs {
  audience?: unknown;
  title?: unknown;
  message?: unknown;
  priority?: unknown;
  type?: unknown;
}

export interface NotifyEmitResult extends Record<string, unknown> {
  emitted: boolean;
  audience: string;
  /** Present only when `emitted` is false — the machine-readable reason. */
  reason?: string;
}

// Derived from `NotificationPriority`, not hand-listed: the first cut wrote
// {low, normal, high} and dropped 'urgent', which would have silently DOWNGRADED
// an urgent notice. The `satisfies` keeps this honest if the union ever changes.
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const satisfies readonly NotificationPriority[];
const PRIORITY_SET = new Set<string>(PRIORITIES);

function asText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function buildNotificationsSurface(scope: BundleScope): FeatureSurface {
  return {
    /**
     * Emit ONE in-app notification. Returns a typed refusal rather than throwing:
     * a notification is a side-channel, and failing the whole run because nobody
     * could be addressed would be a worse outcome than a recorded refusal. The
     * refusal is EXPLICIT (`emitted:false` + `reason`) precisely so it cannot be
     * read as success — the defect this node replaces returned `sent:false`
     * underneath `status:'success'` and nothing ever surfaced it.
     */
    async emit(rawArgs: unknown): Promise<NotifyEmitResult> {
      const args = (rawArgs ?? {}) as NotifyEmitArgs;
      const audience = asText(args.audience, 120);
      const title = asText(args.title, 200);
      const message = asText(args.message, 2000);

      if (!title) return { emitted: false, audience, reason: 'title_required' };
      if (!audience) return { emitted: false, audience, reason: 'audience_required' };

      const priorityRaw = asText(args.priority, 20).toLowerCase();
      const priority: NotificationPriority = PRIORITY_SET.has(priorityRaw)
        ? (priorityRaw as NotificationPriority)
        : 'normal';
      const type = asText(args.type, 60) || 'workflow.notice';

      // ADR 0050 targeting. Exactly one of the three modes; never a silent fallback.
      let target: { recipientUserId?: string; recipientRole?: string };
      if (audience === 'tenant') {
        target = {};
      } else if (audience === 'self') {
        const userId = scope.actingUserId;
        if (!userId) {
          // The fail-closed case the surface exists to make honest: a scheduled or
          // webhook run has no acting human. Broadcasting to the tenant instead
          // would notify people the author never intended.
          return { emitted: false, audience, reason: 'no_acting_user_on_this_run' };
        }
        target = { recipientUserId: userId };
      } else if (audience.startsWith(ROLE_PREFIX)) {
        const role = audience.slice(ROLE_PREFIX.length).trim();
        if (!role) return { emitted: false, audience, reason: 'role_required' };
        target = { recipientRole: role };
      } else {
        return { emitted: false, audience, reason: 'unknown_audience' };
      }

      try {
        // `emit`, NOT `signal`. `signal()` is TRANSIENT — its own comment reads
        // "Deliberately NO `insertNotification` and NO web-push — never persisted"
        // — so it reaches only whoever happens to have an SSE stream open at that
        // instant. A workflow notification that evaporates unless someone is
        // watching is the same silent-delivery defect this node replaces. `emit`
        // is the durable path: inbox row + SSE fanout + Web Push + Teams.
        await getNotificationEmitter().emit({
          tenantId: scope.tenantId,
          type,
          priority,
          title,
          message,
          ...(scope.runId ? { runId: scope.runId } : {}),
          // ── ADR 0600 §5 (`ISU-8`) — the deep link, DERIVED, never authored ──
          // Without `actionUrl` the inbox page still linked out, but only via a
          // FALLBACK it open-codes from `runId`. The bell drawer has no such
          // fallback and the dashboard tile hard-codes `/inbox`, so every
          // workflow notification DEAD-ENDED on the two ambient surfaces — a
          // headline with no way to reach what it is about.
          //
          // Derived from `scope.runId`, never from author input: that is what
          // makes it safe to set without the `isSafeInAppPath` validation the
          // agent tool needs, because no caller-controlled string reaches it.
          ...(scope.runId ? { actionUrl: `/runs/${encodeURIComponent(scope.runId)}` } : {}),
          ...target,
        });
      } catch (err) {
        // The emitter is best-effort by design; report the refusal rather than
        // failing the run, but never report it as an emission.
        log.warn('notification emit failed', {
          tenantId: scope.tenantId,
          audience,
          error: err instanceof Error ? err.message : String(err),
        });
        return { emitted: false, audience, reason: 'emitter_error' };
      }

      return { emitted: true, audience };
    },
  };
}
