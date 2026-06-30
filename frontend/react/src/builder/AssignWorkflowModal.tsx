/**
 * Assign-workflow shortcut modal (ADR 0163 follow-on).
 *
 * A convenience over the EXISTING assignment surfaces — it does NOT introduce a
 * new assignment model. Picking an agent or project simply appends the workflow
 * id to that target's `workflows: string[]` and PATCHes via the same endpoints
 * the agent-portfolio panel (`updateRosterEntry`) and project-workflows tab
 * (`updateWorkflows`) already use. Append is deduped (idempotent): a workflow
 * already assigned to the target succeeds as a no-op.
 *
 * @see agents/AgentWorkflowPortfolioPanel.tsx, features/projects/ProjectWorkflowsTab.tsx
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { SelectField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { listRoster, updateRosterEntry, type RosterEntry } from '../agents/rosterClient.js';
import { listProjects, updateWorkflows, type Project } from '../features/projects/projectsClient.js';

interface Props {
  /** The workflow to assign (already owned by the caller). */
  workflow: { id: string; name: string };
  onClose(): void;
}

/** Encodes the picked target as `agent:<rosterId>` / `project:<projectId>` so a
 *  single <select> spans both kinds without a separate radio. */
type Target = { kind: 'agent'; entry: RosterEntry } | { kind: 'project'; project: Project };

export function AssignWorkflowModal({ workflow, onClose }: Props): JSX.Element {
  const { t } = useTranslation('builder');
  const [agents, setAgents] = useState<RosterEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [r, p] = await Promise.all([listRoster(), listProjects()]);
        if (cancelled) return;
        setAgents(r);
        setProjects(p);
        setError(undefined);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const targets = useMemo(() => {
    const map = new Map<string, Target>();
    for (const entry of agents) map.set(`agent:${entry.rosterId}`, { kind: 'agent', entry });
    for (const project of projects) map.set(`project:${project.id}`, { kind: 'project', project });
    return map;
  }, [agents, projects]);

  const hasTargets = targets.size > 0;

  async function assign(): Promise<void> {
    const target = targets.get(selected);
    if (!target) return;
    setSubmitting(true);
    setError(undefined);
    try {
      if (target.kind === 'agent') {
        const { entry } = target;
        const targetName = entry.label ?? entry.persona;
        if (entry.workflows.includes(workflow.id)) {
          toast.info(t('assignAlready', { name: workflow.name, target: targetName }));
        } else {
          await updateRosterEntry(entry.rosterId, { workflows: [...entry.workflows, workflow.id] });
          toast.success(t('assignSuccess', { name: workflow.name, target: targetName }));
        }
      } else {
        const { project } = target;
        if (project.workflows.includes(workflow.id)) {
          toast.info(t('assignAlready', { name: workflow.name, target: project.name }));
        } else {
          await updateWorkflows(project.id, [...project.workflows, workflow.id]);
          toast.success(t('assignSuccess', { name: workflow.name, target: project.name }));
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onClose} label={t('assignTo', { name: workflow.name })} loading={submitting || loading} {...(error ? { error } : {})}>
      <h2 className="u-fs-16 u-mb-2">{t('assignTo', { name: workflow.name })}</h2>
      <p className="muted u-mb-3">{t('assignToHint')}</p>
      {!loading && !hasTargets ? (
        <p className="muted">{t('assignNoTargets')}</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void assign(); }} className="u-flex u-flex-col u-gap-3">
          <SelectField
            label={t('assignTarget')}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">{t('assignSelectPlaceholder')}</option>
            {agents.length > 0 && (
              <optgroup label={t('assignAgentsGroup')}>
                {agents.map((a) => <option key={a.rosterId} value={`agent:${a.rosterId}`}>{a.label ?? a.persona}</option>)}
              </optgroup>
            )}
            {projects.length > 0 && (
              <optgroup label={t('assignProjectsGroup')}>
                {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
              </optgroup>
            )}
          </SelectField>
          <div className="u-flex u-gap-2 u-justify-end u-mt-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              {t('common:cancel')}
            </button>
            <button type="submit" className="btn-accent-solid" disabled={submitting || !selected}>
              {t('assignButton')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
