/**
 * kicktodo-accountability built-in workflows (ADR 0459 P3).
 *
 * - `openwop-app.kicktodo.session-reminder` — the cohort-session T-minus reminder
 *   DELIVERY workflow. `sessionService.scheduleSession` arms a one-shot scheduler
 *   job ~1h before a scheduled session carrying { circleId, atIso, conversationId }
 *   in its inputs; stamping the job's `workflowId` (KT-PORT-3 fix) makes the daemon
 *   fire THIS workflow, seeding those inputs as variables. The single thin pack node
 *   delivers the reminder to the circle's live grantees via the notification owner,
 *   mute-respecting (ADR 0457), skipping the coach — all in the accountability
 *   session-notify surface op (`sendSessionReminder`).
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const input = (variableName: string) => ({ type: 'variable' as const, variableName });

export const kicktodoAccountabilityBuiltinWorkflows: readonly WorkflowDefinition[] = [
  {
    workflowId: 'openwop-app.kicktodo.session-reminder',
    variables: [{ name: 'circleId' }, { name: 'atIso' }, { name: 'conversationId' }],
    nodes: [
      {
        nodeId: 'remind',
        typeId: 'feature.kicktodo.nodes.session-reminder',
        inputs: {
          circleId: input('circleId'),
          atIso: input('atIso'),
          conversationId: input('conversationId'),
        },
      },
    ],
  },
];
