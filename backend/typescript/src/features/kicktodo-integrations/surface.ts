/**
 * `ctx.features.kicktodo-integrations` (ADR 0421 P5) — consent reads + the
 * calendar-write op for the daily-loop workflow.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listConsents } from './integrationService.js';
import { syncEnrollmentCalendar, routeReminder } from './calendarWriteService.js';
import { getEnrollment } from '../kicktodo-core/enrollmentService.js';
import { todayFor } from '../kicktodo-core/todayService.js';

export function buildKicktodoIntegrationsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    consents: async (args) => ({ consents: await listConsents(tenant, surfaceStr(args.ownerSubject)) }),
    calendarSync: async (args) => ({
      result: await syncEnrollmentCalendar(tenant, surfaceStr(args.ownerSubject), surfaceStr(args.enrollmentId)),
    }),
    // ADR 0443 R1 — the reminder-loop's one op. Integrations OWNS reminders
    // (routeReminder is the single consent-gated path); it reads core state
    // (integrations→core import, the creator→core precedent). Honest skips:
    // a non-active enrollment (snooze/abandon pauses reminders — deck slide 14),
    // a wrong-owner call, or an all-done day reminds NOTHING.
    remindToday: async (args) => {
      const enrollmentId = surfaceStr(args.enrollmentId);
      const ownerSubject = surfaceStr(args.ownerSubject);
      const e = await getEnrollment(tenant, enrollmentId);
      if (!e || e.ownerSubject !== ownerSubject) return { reminded: false, reason: 'not-found' };
      if (e.state !== 'active') return { reminded: false, reason: 'not-active' };
      const today = await todayFor(tenant, ownerSubject);
      const mine = today.enrollments.find((en) => en.enrollmentId === enrollmentId);
      const pending = mine?.actions.find((a) => !a.checkIn);
      if (!pending) return { reminded: false, reason: 'nothing-pending' };
      const title = pending.card?.title ?? 'Today’s action is ready';
      const reminded = await routeReminder(tenant, ownerSubject, title);
      return { reminded, reason: reminded ? undefined : 'no-consent' };
    },
  };
}
