/**
 * Agent schedules panel (PRD §9 Schedules + §13) — agent-owned scheduled
 * workflows. A THIN wrapper over the shared <SubjectSchedulesPanel> (the same
 * renderer the profile + project schedule surfaces use), backed by the durable
 * scheduler with roster-owned jobs. The workflow picker is the agent's assigned
 * portfolio (`entry.workflows`).
 */
import { useMemo } from 'react';
import {
  SubjectSchedulesPanel, LOCAL_TZ, cadenceLabel,
  type SubjectSchedulesClient, type SubjectScheduleRow,
} from '../schedules/SubjectSchedulesPanel.js';
import { createJob, deleteJob, listJobs, updateJob, triggerJob, type ScheduledJob } from './scheduleClient.js';
import { workflowName } from './roleTemplates.js';
import type { RosterEntry } from './rosterClient.js';

const toRow = (j: ScheduledJob): SubjectScheduleRow => ({
  jobId: j.jobId, cronExpr: j.cronExpr, enabled: j.enabled,
  ...(j.workflowId !== undefined ? { workflowId: j.workflowId } : {}),
  ...(j.timezone !== undefined ? { timezone: j.timezone } : {}),
  ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
  ...(j.lastRunId !== undefined ? { lastRunId: j.lastRunId } : {}),
});
const labelFor = (wf: string, cron: string): string => `${workflowName(wf)} · ${cadenceLabel(cron)}`;

export function AgentSchedulesPanel({ entry }: { entry: RosterEntry }): JSX.Element {
  const { rosterId } = entry;
  const agentId = entry.agentRef.agentId;
  const client: SubjectSchedulesClient = useMemo(() => ({
    list: async () => (await listJobs(rosterId)).map(toRow),
    create: ({ workflowId, cronExpr, timezone }) =>
      createJob({ cronExpr, workflowId, rosterId, agentId, metadata: { label: labelFor(workflowId, cronExpr) }, timezone }).then(() => undefined),
    update: (jobId, patch) =>
      updateJob(jobId, patch.workflowId && patch.cronExpr ? { ...patch, metadata: { label: labelFor(patch.workflowId, patch.cronExpr) } } : patch).then(() => undefined),
    remove: (jobId) => deleteJob(jobId),
    trigger: (jobId) => triggerJob(jobId),
  }), [rosterId, agentId]);

  return (
    <SubjectSchedulesPanel
      client={client}
      workflows={entry.workflows}
      copy={{
        emptyBody: `Create one below so ${entry.persona} runs a workflow on a cadence.`,
        helper: `Cadence shown in ${LOCAL_TZ}. Schedules fire automatically on this cadence (a background daemon), or immediately with “Run now”.`,
        noWorkflowsHint: `Assign ${entry.persona} a workflow first (its Workflow portfolio), then schedule it here.`,
      }}
    />
  );
}
