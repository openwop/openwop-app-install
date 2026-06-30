/**
 * Project schedules tab (ADR 0046 follow-on) — a project's scheduled workflows.
 * A THIN wrapper over the shared <SubjectSchedulesPanel> (the same renderer the
 * profile + agent schedule surfaces use), backed by the durable scheduler with
 * jobs owned by the `project:<id>` subject. No "Run now" — the project surface
 * exposes no manual trigger route, so the client omits `trigger`.
 */
import { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  SubjectSchedulesPanel,
  type SubjectSchedulesClient, type SubjectScheduleRow,
} from '../../schedules/SubjectSchedulesPanel.js';
import { listSchedules, createSchedule, updateSchedule, deleteSchedule, type ProjectSchedule } from './projectScheduleClient.js';

const toRow = (s: ProjectSchedule): SubjectScheduleRow => ({
  jobId: s.jobId, cronExpr: s.cronExpr, enabled: s.enabled,
  ...(s.workflowId !== undefined ? { workflowId: s.workflowId } : {}),
  ...(s.timezone !== undefined ? { timezone: s.timezone } : {}),
  ...(s.lastRunAt !== undefined ? { lastRunAt: s.lastRunAt } : {}),
});

export function ProjectSchedulesTab({ projectId, workflows, canWrite }: { projectId: string; workflows: string[]; canWrite: boolean }): JSX.Element {
  const { t } = useTranslation('projects');
  const client: SubjectSchedulesClient = useMemo(() => ({
    list: async () => (await listSchedules(projectId)).map(toRow),
    create: ({ workflowId, cronExpr, timezone }) => createSchedule(projectId, { workflowId, cronExpr, timezone }).then(() => undefined),
    update: (jobId, patch) => updateSchedule(projectId, jobId, patch).then(() => undefined),
    remove: (jobId) => deleteSchedule(projectId, jobId),
    // no `trigger` — projects expose no manual run-now.
  }), [projectId]);

  return (
    <SubjectSchedulesPanel
      client={client}
      workflows={workflows}
      readOnly={!canWrite}
      copy={{
        emptyBody: t('schedulesEmptyBody'),
        helper: t('schedulesHelper'),
        noWorkflowsHint: <Trans i18nKey="schedulesNoWorkflowsHint" ns="projects" components={{ 0: <Link to={`/projects/${projectId}?tab=workflows`} /> }} />,
      }}
    />
  );
}
