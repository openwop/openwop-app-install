/**
 * The client's campaign team (ADR 0943 P4) — the "Team" tab of Operations.
 *
 * One row per role: the agent it works as for THIS client (its client override,
 * else the default), the AI setup it uses, and its last quality check. A person
 * who may edit the client can pick another agent for a role or go back to the
 * default; everyone else sees the team read-only. `canEdit` comes from the
 * server (the same check the change routes make), never from the browser.
 *
 * Chat stays the ONE chat (CLAUDE.md), bound to the selected agent AND client. Quality
 * checks are workspace-wide (a check is not per client) and appear only when the
 * workspace has them; otherwise the panel says so instead of showing blanks.
 *
 * Lazy-loaded from OperationsPage so none of this reaches the entry chunk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { SelectField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { formatDate, formatPercent } from '../../i18n/format.js';
import { listAgents, type AgentEntry } from '../../client/agentsClient.js';
import { getTeam, bindRoleAgent, unbindRoleAgent, CampaignOpsError, type TeamMember, type TeamView, type TeamEvalScore } from './campaignOpsClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

function errorText(e: unknown, t: TFn): string {
  if (e instanceof CampaignOpsError && e.message) return e.message;
  return t('actionFailed');
}

function CheckCell({ score, available, t }: { score: TeamEvalScore | null; available: boolean; t: TFn }): JSX.Element {
  if (!available) return <span className="u-text-muted">{t('teamCheckOff')}</span>;
  if (!score) return <span className="u-text-muted">{t('teamCheckNone')}</span>;
  const ratio = typeof score.aggregateScore === 'number' ? formatPercent(score.aggregateScore) : null;
  return (
    <span className="u-grid">
      <span>
        <span className={`chip ${score.passed ? 'chip--success' : 'chip--danger'}`}>{score.passed ? t('teamCheckPassed') : t('teamCheckFailed')}</span>{' '}
        {typeof score.passedCount === 'number' && typeof score.taskCount === 'number'
          ? t('teamCheckCount', { passed: score.passedCount, total: score.taskCount })
          : ratio}
      </span>
      {score.completedAt ? <span className="u-text-muted u-fs-13">{t('teamCheckOn', { date: formatDate(score.completedAt) })}</span> : null}
    </span>
  );
}

interface TeamPanelProps { orgId: string; clientName: string; onStatus: (s: string) => void }
export function TeamPanel(props: TeamPanelProps): JSX.Element {
  return <TeamForClient key={props.orgId} {...props} />;
}
function TeamForClient({ orgId, clientName, onStatus }: TeamPanelProps): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [view, setView] = useState<TeamView | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(async () => {
    const ticket = ++request.current;
    setFailed(false);
    try { const next = await getTeam(orgId); if (mounted.current && ticket === request.current) setView(next); }
    catch { if (mounted.current && ticket === request.current) setFailed(true); }
  }, [orgId]);

  useEffect(() => { setView(null); void load(); }, [load]);

  const reset = useCallback(async (m: TeamMember) => {
    if (!m.binding) return;
    const ok = await confirm({
      title: t('teamResetTitle', { role: m.role.label }),
      body: t('teamResetBody', { client: clientName, agent: m.role.label }),
      confirmLabel: t('teamReset'),
    });
    if (!ok || !mounted.current) return;
    try {
      await unbindRoleAgent(orgId, m.binding.bindingId);
      if (!mounted.current) return;
      onStatus(t('teamResetDone', { role: m.role.label }));
    } catch (e) {
      if (mounted.current) onStatus(errorText(e, t));
    }
    if (mounted.current) await load();
  }, [orgId, clientName, load, onStatus, t]);

  const columns = useMemo<DataColumn<TeamMember>[]>(() => {
    const available = view?.evals.available === true;
    return [
      {
        key: 'role', header: t('teamColRole'), rowHeader: true,
        sortValue: (m) => m.role.label,
        render: (m) => (
          <span className="u-grid">
            <strong>{m.role.label}</strong>
            {m.role.description ? <span className="u-text-muted u-fs-13">{m.role.description}</span> : null}
            {!m.role.teamRole ? <span className="u-text-muted u-fs-13">{t('teamNotARole')}</span> : null}
          </span>
        ),
      },
      {
        key: 'agent', header: t('teamColAgent'),
        sortValue: (m) => m.binding?.agent.label ?? m.role.label,
        render: (m) => (
          <span className="u-grid">
            <span>
              {m.binding ? m.binding.agent.label : t('teamDefaultAgent')}{' '}
              {m.binding ? <span className="chip chip--accent">{t('teamChangedChip')}</span> : null}
            </span>
            {m.narrowerBindings > 0 ? <span className="u-text-muted u-fs-13">{t('teamNarrower', { count: m.narrowerBindings })}</span> : null}
          </span>
        ),
      },
      {
        key: 'ai', header: t('teamColAi'),
        render: (m) => (m.binding?.model
          ? <span>{t('teamAiPinned', { vendor: m.binding.model.provider, name: m.binding.model.model })}</span>
          : <span className="u-text-muted">{t('teamAiDefault')}</span>),
      },
      {
        key: 'check', header: t('teamColCheck'),
        sortValue: (m) => (m.binding ? m.binding.agent.eval : m.role.eval)?.aggregateScore ?? null,
        render: (m) => <CheckCell score={m.binding ? m.binding.agent.eval : m.role.eval} available={available} t={t} />,
      },
      {
        key: 'actions', header: <span className="sr-only">{t('teamColActions')}</span>, align: 'right',
        render: (m) => {
          const agentId = m.binding?.agent.agentId ?? m.role.agentId;
          return (
            <span className="u-flex u-flex-wrap u-gap-2 u-justify-end">
              <Link className="btn btn-ghost btn-sm" to={`/chat?agent=${encodeURIComponent(agentId)}&client=${encodeURIComponent(orgId)}`}
                aria-label={t('teamChatLabel', { agent: m.binding?.agent.label ?? m.role.label })}>
                {t('teamChat')}
              </Link>
              {view?.canEdit ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing(m)} aria-label={t('teamChangeLabel', { role: m.role.label })}>
                  {t('teamChange')}
                </Button>
              ) : null}
              {view?.canEdit && m.binding ? (
                <Button size="sm" variant="quiet" onClick={() => void reset(m)} aria-label={t('teamResetLabel', { role: m.role.label })}>
                  {t('teamReset')}
                </Button>
              ) : null}
            </span>
          );
        },
      },
    ];
  }, [view, reset, orgId, t]);

  if (failed) {
    return <StateCard announce title={t('teamLoadFailedTitle')} body={t('teamLoadFailedBody')} action={<Button onClick={() => void load()}>{t('retry')}</Button>} />;
  }
  if (view === null) return <StateCard loading title={t('loading')} />;

  return (
    <section className="u-grid u-gap-3" aria-labelledby="campaign-ops-team">
      <div className="u-grid u-gap-1">
        <h3 id="campaign-ops-team" className="u-m-0 u-fs-15">{t('teamHeading', { client: clientName })}</h3>
        <p className="u-text-muted u-m-0">{t('teamLede')}</p>
      </div>
      {!view.canEdit ? <Notice variant="info">{t('teamReadOnly')}</Notice> : null}
      {view.evals.available === false ? <Notice variant="info">{t(`teamChecksOff_${view.evals.reason}`)}</Notice> : null}
      {view.members.length === 0
        ? <StateCard title={t('teamEmptyTitle')} body={t('teamEmptyBody')} />
        : <DataTable columns={columns} rows={view.members} rowKey={(m) => m.role.agentId} caption={t('teamCaption', { client: clientName })} stack />}
      {editing ? (
        <ChangeAgentDialog
          orgId={orgId}
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={(label) => { if (!mounted.current) return; setEditing(null); onStatus(t('teamChangedDone', { role: editing.role.label, agent: label })); void load(); }}
        />
      ) : null}
    </section>
  );
}

function ChangeAgentDialog({ orgId, member, onClose, onSaved }: {
  orgId: string; member: TeamMember; onClose: () => void; onSaved: (agentLabel: string) => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [agents, setAgents] = useState<readonly AgentEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const current = member.binding?.agent.agentId ?? member.role.agentId;
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listAgents().then((a) => { if (!cancelled) setAgents(a); }).catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const options = useMemo(() => (agents ?? []).filter((a) => a.agentId !== current).sort((a, b) => a.label.localeCompare(b.label)), [agents, current]);

  const save = async (): Promise<void> => {
    if (!choice) { setError(t('teamPickAgent')); return; }
    setBusy(true); setError(null);
    try {
      await bindRoleAgent(orgId, member.role.agentId, choice);
      onSaved(options.find((a) => a.agentId === choice)?.label ?? choice);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t('teamChangeTitle', { role: member.role.label })} showClose loading={agents === null && !loadFailed} error={error ?? undefined} errorAnnounce={error ?? undefined}>
      <form className="u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2 className="u-m-0 u-fs-18">{t('teamChangeTitle', { role: member.role.label })}</h2>
        <p className="u-m-0 u-text-muted">{t('teamChangeBody')}</p>
        {loadFailed ? <Notice variant="error" announce={t('teamAgentsFailed')}>{t('teamAgentsFailed')}</Notice> : (
          <SelectField label={t('teamPickLabel')} help={t('teamPickHelp')} value={choice} onChange={(e) => setChoice(e.target.value)} required>
            <option value="">{t('teamPickPlaceholder')}</option>
            {options.map((a) => <option key={a.agentId} value={a.agentId}>{a.label}</option>)}
          </SelectField>
        )}
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('teamCancel')}</Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={loadFailed}>{t('teamSave')}</Button>
        </div>
      </form>
    </Modal>
  );
}
