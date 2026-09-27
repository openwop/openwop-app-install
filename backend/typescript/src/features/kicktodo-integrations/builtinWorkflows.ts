/**
 * kicktodo-integrations built-in workflow (ADR 0421 P2 / ADR 0466) — the
 * calendar-write lane's IGNITION.
 *
 * The `calendar-sync` node + the `calendarSync` surface op + the transport
 * (REST or Google Calendar MCP, ADR 0466) were authored end-to-end, but NOTHING
 * ever created a calendar-sync run — the lane was un-ignitable. This tiny
 * one-node builtin is the workflow the opt-in scheduler job fires (see
 * `calendarSyncService.ts`): it composes the SHARED `feature.kicktodo.nodes`
 * pack's `calendar-sync` adapter, which calls
 * `ctx.features['kicktodo-integrations'].calendarSync`. Consent + transport fail
 * closed INSIDE that surface op, so a fired run that lacks either simply errors
 * — nothing external is written without the participant's live `calendar-write`
 * consent and a configured transport.
 *
 * Registered from `kicktodoIntegrationsFeature.builtinWorkflows` (NOT
 * kicktodo-core's set) — the calendar lane is this feature's concern even though
 * the node adapter lives in the shared family pack.
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const input = (variableName: string) => ({ type: 'variable' as const, variableName });

/** The opt-in calendar-sync builtin id (the scheduler job's `workflowId`). */
export const KICKTODO_CALENDAR_SYNC_WORKFLOW_ID = 'openwop-app.kicktodo.calendar-sync';

export const kicktodoIntegrationsBuiltinWorkflows: readonly WorkflowDefinition[] = [
  {
    workflowId: KICKTODO_CALENDAR_SYNC_WORKFLOW_ID,
    // Declared so `seedRunVariables` seeds them from the job's `inputs` (an
    // undeclared variable resolves to `undefined` and the sync runs against no
    // enrollment — the KTFULL-B4 lesson).
    variables: [{ name: 'enrollmentId' }, { name: 'ownerSubject' }],
    nodes: [
      {
        nodeId: 'calendar-sync',
        typeId: 'feature.kicktodo.nodes.calendar-sync',
        inputs: { enrollmentId: input('enrollmentId'), ownerSubject: input('ownerSubject') },
      },
    ],
  },
];
