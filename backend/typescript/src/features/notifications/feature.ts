/**
 * Notifications (ADR 0010) — CORE platform infrastructure, always-on.
 *
 * History: a pre-existing core subsystem was migrated into the feature-package
 * architecture (ADR 0001) with a default-ON toggle. But the emit path is
 * unconditional (run-failure + interrupt notifications fire from the executor
 * regardless of any toggle), so the toggle only ever hid the READ surface while
 * rows + Web-Push kept flowing — a confusing half-on state. The toggle is
 * therefore **removed** (2026-06-11): run-lifecycle notifications are platform
 * behavior, not an optional product surface. The real, honest control is the
 * **per-user preferences** (mute categories / quiet hours / Web-Push opt-in),
 * which this feature still owns. See docs/adr/0010-notifications.md § Correction.
 *
 * It remains a `BackendFeature` for code organization (it owns its emit-backend
 * install + Web-Push config + routes), but carries NO `toggleDefault` and NO
 * gate middleware — the surface is always mounted.
 *
 * @see docs/adr/0010-notifications.md
 */

import type { BackendFeature } from '../types.js';
import { ensureNotificationEmitterInstalled } from '../../bootstrap/notifications.js';
import { configureWebPush } from '../../notifications/webPush.js';
import { registerNotificationRoutes } from '../../routes/notifications.js';
import { registerPushSubscriptionRoutes } from '../../routes/pushSubscriptions.js';
import { registerNotificationPreferenceRoutes, registerNotificationMutePolicy } from './preferencesRoutes.js';
import { registerNotificationsAgentTools } from './agentTools.js';
import { installNotificationSubjectEraser } from '../../host/notificationSubjectErasure.js';
import { buildNotificationsSurface } from './surface.js';

export const notificationsFeature: BackendFeature = {
  id: 'notifications',
  // `ctx.features.notifications` — the workflow-node seam over the ONE emitter.
  // Always-on like the rest of this feature (no toggle default registered), so
  // `buildFeatureSurfaces`' gate is skipped by the ADR 0027 always-on exception.
  surface: { id: 'notifications', build: buildNotificationsSurface },
  registerRoutes: (deps) => {
    const { app, storage } = deps;

    // The feature owns its infra (moved off index.ts): the run-lifecycle emit
    // backend + Web-Push. Core stays decoupled — it emits via setNotificationBackend.
    ensureNotificationEmitterInstalled(storage);
    configureWebPush();

    // Always-on surface (no toggle gate — notifications is core). Per-user
    // preferences are the control; the inbox/SSE/push/prefs routes are mounted
    // unconditionally. Anonymous callers are still 401'd by the routes' own auth.
    registerNotificationRoutes(app, { storage });
    registerPushSubscriptionRoutes(app, { storage });
    registerNotificationPreferenceRoutes(app);
    registerNotificationMutePolicy(); // ADR 0214 D2 — activate the mute enforcement seam
    // ADR 0308 P3 — the `openwop:notifications.notify-me` agent deliverable tool
    // (self-scope only; relative-in-app-URL restricted; allowlist default-deny
    // + firewall unchanged via the D2 seam).
    registerNotificationsAgentTools();
    // CMNT-11 — per-SUBJECT DSAR reclamation for the inbox. Registered here, with
    // the store's owning feature: the residual (recipientUserId + metadata
    // actorId/recipientId) is written by EVERY emitter, not just comments.
    installNotificationSubjectEraser();
  },
  // No `toggleDefault` — notifications is core platform infrastructure, not a
  // per-tenant toggle (removed 2026-06-11; the emit path was never gated anyway).
};
