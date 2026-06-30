/**
 * Profile schedules tab (ADR 0025) — the human's own scheduled workflows. A THIN
 * wrapper over the shared <SubjectSchedulesPanel> (the same renderer the agent +
 * project schedule surfaces use), backed by the durable scheduler with
 * `owner: 'me'` jobs (reachable from any workspace). The workflow picker is the
 * user's assigned-workflow portfolio (the Assigned workflows tab).
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  SubjectSchedulesPanel, LOCAL_TZ, cadenceLabel,
  type SubjectSchedulesClient, type SubjectScheduleRow,
} from '../../schedules/SubjectSchedulesPanel.js';
import { createJob, deleteJob, listMyJobs, updateJob, triggerJob, type ScheduledJob } from '../../agents/scheduleClient.js';
import { workflowName } from '../../agents/roleTemplates.js';

const toRow = (j: ScheduledJob): SubjectScheduleRow => ({
  jobId: j.jobId, cronExpr: j.cronExpr, enabled: j.enabled,
  ...(j.workflowId !== undefined ? { workflowId: j.workflowId } : {}),
  ...(j.timezone !== undefined ? { timezone: j.timezone } : {}),
  ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
  ...(j.lastRunId !== undefined ? { lastRunId: j.lastRunId } : {}),
});
const labelFor = (wf: string, cron: string): string => `${workflowName(wf)} · ${cadenceLabel(cron)}`;

export function ProfileSchedulesTab({ workflows }: { workflows: string[] }): JSX.Element {
  const { t } = useTranslation('profiles');
  const client: SubjectSchedulesClient = useMemo(() => ({
    list: async () => (await listMyJobs()).map(toRow),
    create: ({ workflowId, cronExpr, timezone }) =>
      createJob({ cronExpr, workflowId, owner: 'me', metadata: { label: labelFor(workflowId, cronExpr) }, timezone }).then(() => undefined),
    update: (jobId, patch) =>
      updateJob(jobId, patch.workflowId && patch.cronExpr ? { ...patch, metadata: { label: labelFor(patch.workflowId, patch.cronExpr) } } : patch).then(() => undefined),
    remove: (jobId) => deleteJob(jobId),
    trigger: (jobId) => triggerJob(jobId),
  }), []);

  return (
    <SubjectSchedulesPanel
      client={client}
      workflows={workflows}
      copy={{
        emptyBody: t('schedulesEmptyBody'),
        helper: t('schedulesHelper', { tz: LOCAL_TZ }),
        noWorkflowsHint: (
          <Trans
            t={t}
            i18nKey="schedulesNoWorkflowsHint"
            components={{ 0: <Link to="/profile?tab=workflows" /> }}
          />
        ),
      }}
    />
  );
}
