/**
 * Agent schedules panel (PRD §9 Schedules + §13) — agent-owned scheduled
 * workflows. A THIN wrapper over the shared <SubjectSchedulesPanel> (the same
 * renderer the profile + project schedule surfaces use), backed by the durable
 * scheduler with roster-owned jobs. The workflow picker is the agent's assigned
 * portfolio (`entry.workflows`).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SubjectSchedulesPanel, LOCAL_TZ, cadenceLabel,
  type SubjectSchedulesClient, type SubjectScheduleRow,
} from '../schedules/SubjectSchedulesPanel.js';
import { createJob, deleteJob, listJobs, updateJob, triggerJob, type ScheduledJob } from './scheduleClient.js';
import { workflowName } from './roleTemplates.js';
import { useScopeWriteAccess } from '../lib/writeAccess.js';
import type { RosterEntry } from './rosterClient.js';

const toRow = (j: ScheduledJob): SubjectScheduleRow => ({
  jobId: j.jobId, cronExpr: j.cronExpr, enabled: j.enabled,
  ...(j.workflowId !== undefined ? { workflowId: j.workflowId } : {}),
  ...(j.timezone !== undefined ? { timezone: j.timezone } : {}),
  ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
  ...(j.lastRunId !== undefined ? { lastRunId: j.lastRunId } : {}),
  // GEN-PRJ-1 — surface the daemon's skip record (dead schedules must be visible).
  ...(j.lastSkippedAt !== undefined ? { lastSkippedAt: j.lastSkippedAt } : {}),
  ...(j.lastSkipReason !== undefined ? { lastSkipReason: j.lastSkipReason } : {}),
  ...(j.nextFireAt !== undefined ? { nextFireAt: j.nextFireAt } : {}),
  ...(j.planLapsed !== undefined ? { planLapsed: j.planLapsed } : {}),
  // ADR 0815 D4 — paused by the server because its member left the workspace.
  ...(j.metadata?.disabledReason === 'acting_member_removed' ? { pausedReason: 'acting_member_removed' as const } : {}),
});
const labelFor = (wf: string, cron: string): string => `${workflowName(wf)} · ${cadenceLabel(cron)}`;

export function AgentSchedulesPanel({ entry }: { entry: RosterEntry }): JSX.Element {
  const { t } = useTranslation('agents');
  // ADR 0787 D3 — every schedule write needs `workspace:write`; a Viewer was
  // offered Edit/Pause/Run now/Delete and got a raw 403 for each (`SCTUX-1`).
  const canWrite = useScopeWriteAccess('workspace:write');
  const { rosterId } = entry;
  const agentId = entry.agentRef.agentId;
  const client: SubjectSchedulesClient = useMemo(() => ({
    list: async () => (await listJobs(rosterId)).map(toRow),
    create: ({ workflowId, cronExpr, timezone }) =>
      createJob({ cronExpr, workflowId, rosterId, agentId, metadata: { label: labelFor(workflowId, cronExpr) }, timezone }).then(() => undefined),
    // The patch carries only what changed; relabel from the row for the rest.
    update: (jobId, patch, row) => {
      const wf = patch.workflowId ?? row?.workflowId;
      const cron = patch.cronExpr ?? row?.cronExpr;
      const relabel = (patch.workflowId !== undefined || patch.cronExpr !== undefined) && wf && cron;
      return updateJob(jobId, relabel ? { ...patch, metadata: { label: labelFor(wf, cron) } } : patch).then(() => undefined);
    },
    remove: (jobId) => deleteJob(jobId),
    trigger: (jobId) => triggerJob(jobId),
  }), [rosterId, agentId]);

  return (
    <SubjectSchedulesPanel
      client={client}
      workflows={entry.workflows}
      readOnly={!canWrite}
      copy={{
        emptyBody: t('schedulesEmptyBody', { persona: entry.persona }),
        helper: t('schedulesHelper', { tz: LOCAL_TZ }),
        noWorkflowsHint: t('schedulesNoWorkflowsHint', { persona: entry.persona }),
      }}
    />
  );
}
