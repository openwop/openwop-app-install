/**
 * `ctx.features.kicktodo-core` (ADR 0414 P4; ADR 0014) — the typed workflow
 * surface the `feature.kicktodo.nodes` pack calls. Thin adapters over the
 * feature services: authorization posture is the run's tenant trust (CTI-1);
 * participant-owned operations take an explicit `ownerSubject` the CALLING
 * workflow resolved (run metadata / trigger context) — pack nodes never invent
 * identity.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr, surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listPublished, listPublishedForLocale } from './challengeService.js';
import { enroll, materializeOccurrences, getEnrollment, listEnrollmentsFor, substituteOccurrence, setSchedulePreference } from './enrollmentService.js';
import { todayFor, submitCheckIn, applyMissedWindowPolicy } from './todayService.js';
import { evaluateEnrollment, freezeProgressEvidence, progressFor } from './progressService.js';
import { applyRevisionCommands, buildPlanRevisionDisplay } from './replanService.js';
import { enqueueKickbotCoachTurn } from './kickbotCoachTurnService.js';

export function buildKicktodoCoreSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    listChallenges: async () => ({ challenges: await listPublished(tenant) }),
    // ADR 0689 — KickBot speaks first: enqueue ONE proactive guide turn into the
    // participant's own 1:1 (gated, idempotent per enrollment per local day /
    // per award). The reminder-loop's second node composes this.
    kickbotCoachTurn: async (args) => await enqueueKickbotCoachTurn(tenant, {
      ownerSubject: surfaceStr(args.ownerSubject),
      enrollmentId: surfaceStr(args.enrollmentId),
      occasion: surfaceOptStr(args.occasion) === 'award' ? 'award' : 'reminder',
      ...(surfaceOptStr(args.awardKind) ? { awardKind: surfaceOptStr(args.awardKind) } : {}),
    }) as unknown as Record<string, unknown>,
    /** ADR 0430 P5 — the catalog negotiated for a CONTENT locale (independent
     *  of any UI locale); the served locale is returned so a caller can
     *  disclose a fallback rather than pretend it was exact. */
    catalogForLocale: async (args) => ({
      challenges: await listPublishedForLocale(tenant, surfaceStr(args.contentLocale) || 'en'),
    }),
    enroll: async (args) => {
      const result = await enroll({
        tenantId: tenant,
        ownerSubject: surfaceStr(args.ownerSubject),
        challengeId: surfaceStr(args.challengeId),
        challengeVersion: typeof args.challengeVersion === 'number' ? args.challengeVersion : 1,
        ...(surfaceOptStr(args.timezone) ? { timezone: surfaceOptStr(args.timezone) } : {}),
      });
      return { enrollment: result.enrollment };
    },
    getEnrollment: async (args) => ({ enrollment: await getEnrollment(tenant, surfaceStr(args.enrollmentId)) }),
    // ADR 0443 R1 — chat-drivable ("remind me in the evenings"): owner-checked in
    // the service; a null/absent daypart clears the preference + disables the job.
    setSchedulePreference: async (args) => ({
      enrollment: await setSchedulePreference(
        tenant,
        surfaceStr(args.enrollmentId),
        surfaceStr(args.ownerSubject),
        args.daypart === 'morning' || args.daypart === 'afternoon' || args.daypart === 'evening' ? args.daypart : null,
      ),
    }),
    materializeToday: async (args) => ({
      occurrences: await materializeOccurrences(tenant, surfaceStr(args.enrollmentId)),
    }),
    today: async (args) => await todayFor(tenant, surfaceStr(args.ownerSubject)) as unknown as Record<string, unknown>,
    checkIn: async (args) => ({
      checkIn: await submitCheckIn(tenant, surfaceStr(args.ownerSubject), surfaceStr(args.cardId), {
        ...(surfaceOptStr(args.note) ? { note: surfaceOptStr(args.note) } : {}),
      }),
    }),
    progress: async (args) => ({ progress: await progressFor(tenant, surfaceStr(args.enrollmentId)) }),
    /** ADR 0456 P4 — a LIGHTWEIGHT lifecycle read for automation authors: is the
     *  participant enrolled in a challenge, and how far along — WITHOUT the
     *  heavyweight freeze/judge `evaluate` does. Finds the enrollment by
     *  (subject, challenge) so a workflow needn't know the enrollmentId. */
    lifecycleStatus: async (args) => {
      const challengeId = surfaceStr(args.challengeId);
      const version = typeof args.challengeVersion === 'number' ? args.challengeVersion : undefined;
      const e = (await listEnrollmentsFor(tenant, surfaceStr(args.ownerSubject)))
        .find((x) => x.challengeId === challengeId && (version === undefined || x.challengeVersion === version));
      if (!e) return { status: { enrolled: false } };
      const prog = await progressFor(tenant, e.id);
      return {
        status: {
          enrolled: true,
          state: e.state,
          completedActivities: prog?.completedActivities ?? 0,
          totalActivities: prog?.totalRequiredActivities ?? 0,
          completed: prog ? prog.completedActivities >= prog.totalRequiredActivities : false,
        },
      };
    },
    /** ADR 0429 P5 — swap today's action for a PUBLISHER-DECLARED alternative.
     *  The workflow/agent may PROPOSE; the acting subject is required, so an
     *  automated run without a user fails closed at the owner check. */
    substitute: async (args) => ({
      occurrence: await substituteOccurrence(
        tenant,
        surfaceStr(args.ownerSubject),
        surfaceStr(args.cardId),
        surfaceStr(args.alternativeId),
      ),
    }),
    /** ADR 0459 P1 — apply a participant's CLOSED-WORLD revision command list (the
     *  three ADR 0429 lanes only) to their own enrollment. Owner-checked in the
     *  service FIRST (applyPlanRevision has no owner check); each lane re-checks.
     *  The `apply-revision-commands` pack node forwards { enrollmentId, subject,
     *  commands } here after the participant approved the revision at their gate. */
    applyRevisionCommands: async (args) => {
      const r = await applyRevisionCommands(tenant, {
        enrollmentId: surfaceStr(args.enrollmentId),
        subject: surfaceStr(args.subject),
        commands: Array.isArray(args.commands) ? args.commands : [],
      });
      // Explicit field mapping (no cast) — the sibling-op pattern; a new
      // RevisionResult field must be surfaced here deliberately.
      return { applied: r.applied, results: r.results };
    },
    /** ADR 0459 grade-fix — HUMANIZE a proposed plan revision for the approval card.
     *  Resolves each command's opaque ids to real activity/alternative titles from the
     *  participant's own state (the card must never show an id), and returns the revision
     *  with an additive `display: { summary, lines }`. `commands` is untouched — the apply
     *  path reads the raw revision off the compose→apply edge, not this artifact. */
    enrichPlanRevision: async (args) => {
      const revision = args.revision && typeof args.revision === 'object'
        ? (args.revision as { commands?: unknown; rationale?: unknown })
        : {};
      const display = await buildPlanRevisionDisplay(tenant, surfaceStr(args.enrollmentId), {
        commands: Array.isArray(revision.commands) ? revision.commands : [],
        rationale: revision.rationale,
      });
      return { revision: { ...revision, display } };
    },
    /** ADR 0429 P5 — apply the challenge's missed-window policy (daily loop). */
    applyMissedWindow: async (args) => ({
      result: await applyMissedWindowPolicy(tenant, surfaceStr(args.enrollmentId)),
    }),
    freezeEvidence: async (args) => ({
      snapshot: await freezeProgressEvidence(tenant, surfaceStr(args.enrollmentId)),
    }),
    evaluate: async (args) => {
      const result = await evaluateEnrollment(tenant, surfaceStr(args.enrollmentId), surfaceStr(args.ownerSubject));
      return result ? { ...result } : { enrollment: null };
    },
  };
}
