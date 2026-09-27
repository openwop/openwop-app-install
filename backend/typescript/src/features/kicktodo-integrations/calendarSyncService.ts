/**
 * kicktodo-integrations calendar-sync SCHEDULE BINDING (ADR 0421 P2 / ADR 0466).
 *
 * The opt-in cadence that actually IGNITES the calendar-write lane. Mirrors the
 * reminder-loop binding (`enrollmentService.setSchedulePreference`) one size
 * smaller: a per-enrollment scheduler JOB (never a second cadence engine)
 * running the `openwop-app.kicktodo.calendar-sync` builtin daily in the
 * enrollment's timezone. It is OPT-IN and multiply gated, so NOTHING syncs by
 * default:
 *
 *   - the participant must explicitly enable sync for THEIR OWN enrollment
 *     (owner-checked here) — a REST write with the acting human, never a chat
 *     tool (the accountability precedent: consent-class opt-ins stay route-level);
 *   - a live `calendar-write` consent is required to arm (else `ConsentRequiredError`);
 *   - a calendar TRANSPORT must be configured in this deployment (else
 *     `CalendarUnavailableError`) — the lane ships gated-off
 *     (`OPENWOP_CALENDAR_MCP_ENABLED` / `OPENWOP_CALENDAR_PROVIDER_ENABLED` unset),
 *     so arming is refused until an operator wires one.
 *
 * Disabling flips the job's `enabled` flag off (kept-armed-but-disabled, the
 * sibling reminder-loop's no-disarm posture). The fired run's `calendar-sync`
 * node fails closed on a later consent-revoke or transport removal, so the job
 * can never write without a live consent + transport.
 */

import { createLogger } from '../../observability/logger.js';
import { registerJob, setJobEnabled } from '../../host/schedulingService.js';
import { getEnrollment } from '../kicktodo-core/enrollmentService.js';
import { liveConsent, ConsentRequiredError } from './integrationService.js';
import { isCalendarTransportConfigured, CalendarUnavailableError } from './calendarWriteService.js';
import { KICKTODO_CALENDAR_SYNC_WORKFLOW_ID } from './builtinWorkflows.js';

const log = createLogger('kicktodo.calendar-sync');

/** Sync daily at 05:30 in the enrollment's timezone — just after the KTFULL-B5
 *  05:00 materialization slot, so the day's freshly-materialized occurrences are
 *  what gets upserted. */
const CALENDAR_SYNC_CRON = '30 5 * * *';

/** Deterministic calendar-sync job id — tenant-scoped (the ADR 0379 cross-tenant
 *  overwrite guard keys on this) and distinct from the daily-loop + reminder job
 *  ids so none is ever overwritten. */
export function calendarSyncJobId(tenantId: string, enrollmentId: string): string {
  return `kicktodo:${tenantId}:${enrollmentId}:calendar-sync`;
}

/**
 * Enable (arm) or disable the opt-in daily calendar-sync for one enrollment.
 * Owner-only. Returns `false` when the enrollment is missing or not the caller's.
 * Throws `ConsentRequiredError` / `CalendarUnavailableError` when arming without
 * the required consent / a configured transport (the route maps these to 409).
 */
export async function setCalendarSyncEnabled(
  tenantId: string,
  enrollmentId: string,
  ownerSubject: string,
  enabled: boolean,
): Promise<boolean> {
  const e = await getEnrollment(tenantId, enrollmentId);
  if (!e || e.ownerSubject !== ownerSubject) return false;

  const jobId = calendarSyncJobId(tenantId, enrollmentId);
  if (!enabled) {
    await setJobEnabled(jobId, false); // null when never armed — fine
    log.info('kicktodo_calendar_sync_disabled', { enrollmentId });
    return true;
  }

  // Arm-time gates — refuse to register a job that could never honestly run.
  if (!(await liveConsent(tenantId, ownerSubject, 'calendar-write'))) throw new ConsentRequiredError('calendar-write');
  if (!isCalendarTransportConfigured()) throw new CalendarUnavailableError();

  const res = await registerJob({
    jobId,
    tenantId,
    cronExpr: CALENDAR_SYNC_CRON,
    workflowId: KICKTODO_CALENDAR_SYNC_WORKFLOW_ID,
    enabled: true,
    timezone: e.timezone,
    inputs: { enrollmentId, ownerSubject },
    metadata: { enrollmentId, purpose: 'kicktodo-calendar-sync' },
  });
  if (!res.ok) {
    log.warn('kicktodo_calendar_sync_job_failed', { enrollmentId, error: res.error.message });
    return false;
  }
  log.info('kicktodo_calendar_sync_enabled', { enrollmentId });
  return true;
}
