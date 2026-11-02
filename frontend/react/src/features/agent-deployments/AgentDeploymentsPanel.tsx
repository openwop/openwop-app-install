/**
 * ADR 1005 P3c / ADR 1014 P4b — the agent's deployment console.
 *
 * Lists the agent's versions with their state, channels and canary share, offers
 * the transitions each state allows (RFC 0082 / RFC 0254), and edits the operator
 * promotion policy (ADR 1005 D12). A transition an approval gate holds (D13) comes
 * back `pending`, and the console says who must act. Every refusal the server sends
 * is shown as written; the console never assumes a transition applied.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { CheckboxField, TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { confirm } from '../../ui/confirm.js';
import { writeErrorMessage } from '../../agents/agentWriteAccess.js';
import {
  getPolicy, listDeployments, putPolicy, transitionDeployment,
  type DeploymentRecord, type DeploymentState, type DeploymentTransition, type PolicyView,
} from '../../client/agentDeploymentsClient.js';

const NEXT: Partial<Record<DeploymentState, DeploymentState>> = { draft: 'test', test: 'staged', staged: 'active' };

export function AgentDeploymentsPanel({ agentId, canWrite }: { agentId: string; persona: string; canWrite: boolean }): JSX.Element {
  const { t } = useTranslation(['agent-deployments', 'agents', 'common']);
  const headingId = useId();
  const [records, setRecords] = useState<DeploymentRecord[] | null | undefined>(undefined);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ variant: 'success' | 'info' | 'error'; text: string } | null>(null);
  const [canary, setCanary] = useState<Record<string, string>>({});
  const [draftPolicy, setDraftPolicy] = useState<{ eval: boolean; approval: boolean }>({ eval: false, approval: false });

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const list = await listDeployments(agentId);
      setRecords(list);
      if (list !== null) {
        const p = await getPolicy(agentId);
        setPolicy(p);
        setDraftPolicy({ eval: p.policy.requiredEval !== undefined, approval: p.policy.approval !== undefined });
      }
    } catch {
      setLoadFailed(true);
    }
  }, [agentId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (rec: DeploymentRecord, body: { transition: DeploymentTransition; toState?: DeploymentState; channel?: string; canaryPercent?: number }): Promise<void> => {
    setBusy(`${rec.version}:${body.transition}`);
    setNotice(null);
    try {
      const { record, pending } = await transitionDeployment(agentId, rec, body);
      setNotice(pending
        ? { variant: 'info', text: t('deployPending', { version: rec.version }) }
        : { variant: 'success', text: t('deployApplied', { version: record.version, state: t(`deployState_${record.state}`) }) });
      await load();
    } catch (err) {
      setNotice({ variant: 'error', text: writeErrorMessage(err, t('deployForbidden')) });
    } finally {
      setBusy(null);
    }
  };

  const danger = async (rec: DeploymentRecord, transition: 'rollback' | 'deprecate'): Promise<void> => {
    const ok = await confirm({
      title: t(transition === 'rollback' ? 'deployConfirmRollbackTitle' : 'deployConfirmDeprecateTitle', { version: rec.version }),
      body: t(transition === 'rollback' ? 'deployConfirmRollbackBody' : 'deployConfirmDeprecateBody'),
      confirmLabel: t(transition === 'rollback' ? 'deployRollback' : 'deployDeprecate'),
      danger: true,
    });
    if (ok) await run(rec, { transition });
  };

  const savePolicy = async (): Promise<void> => {
    if (!policy) return;
    setBusy('policy');
    setNotice(null);
    try {
      const next = await putPolicy(agentId, {
        ...(draftPolicy.eval ? { requiredEval: policy.policy.requiredEval ?? {} } : {}),
        ...(draftPolicy.approval ? { approval: { onActivate: true as const } } : {}),
      }, policy.revision);
      setPolicy(next);
      setNotice({ variant: 'success', text: t('deployPolicySaved') });
    } catch (err) {
      setNotice({ variant: 'error', text: writeErrorMessage(err, t('deployPolicyForbidden'), t('deployPolicyStale')) });
    } finally {
      setBusy(null);
    }
  };

  if (records === undefined && !loadFailed) return <StateCard title={t('deployLoading')} loading />;
  if (loadFailed) {
    return <StateCard announce title={t('deployLoadFailed')} action={<Button variant="secondary" onClick={() => void load()}>{t('common:retry')}</Button>} />;
  }
  if (records === null) return <StateCard title={t('deployNotServed')} />;

  return (
    <div className="u-flex u-flex-col u-gap-4">
      <section className="surface-card u-flex u-flex-col u-gap-3" aria-labelledby={headingId}>
        <h3 id={headingId} className="u-fs-14 u-fw-600 u-m-0">{t('deployTitle')}</h3>
        <p className="muted u-fs-13 u-m-0">{t('deployDesc')}</p>
        <p className="muted u-fs-12 u-m-0">{t('deployToolsShared')}</p>
        {!canWrite ? <p className="muted u-fs-13 u-m-0">{t('agents:viewerPanelReadOnly')}</p> : null}
        {notice ? <Notice variant={notice.variant} announce={notice.text}>{notice.text}</Notice> : null}
        {records!.length === 0 ? <p className="muted u-fs-13 u-m-0">{t('deployEmpty')}</p> : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('deployColVersion')}</th>
                <th scope="col">{t('deployColState')}</th>
                <th scope="col">{t('deployColChannels')}</th>
                <th scope="col">{t('deployColCanary')}</th>
                {canWrite ? <th scope="col"><span className="sr-only">{t('deployColActions')}</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {records!.map((rec) => {
                const next = NEXT[rec.state];
                const working = (tr: string): boolean => busy === `${rec.version}:${tr}`;
                return (
                  <tr key={rec.version}>
                    <td><code>{rec.version}</code></td>
                    <td><span className="chip">{t(`deployState_${rec.state}`)}</span></td>
                    <td>{(rec.channels ?? []).join(', ') || '—'}</td>
                    <td>{rec.state === 'active' ? `${rec.canaryPercent ?? 100}%` : '—'}</td>
                    {canWrite ? (
                      <td>
                        <div className="u-flex u-gap-2 u-flex-wrap u-items-end">
                          {next ? (
                            <Button size="sm" loading={working('promote')} disabled={busy !== null}
                              onClick={() => void run(rec, { transition: 'promote', toState: next, ...(next === 'active' ? { channel: 'stable' } : {}) })}>
                              {t('deployPromoteTo', { state: t(`deployState_${next}`) })}
                            </Button>
                          ) : null}
                          {rec.state === 'paused' ? (
                            <Button size="sm" loading={working('promote')} disabled={busy !== null} onClick={() => void run(rec, { transition: 'promote' })}>{t('deployResume')}</Button>
                          ) : null}
                          {rec.state === 'active' ? (
                            <>
                              <Button size="sm" variant="secondary" loading={working('pause')} disabled={busy !== null} onClick={() => void run(rec, { transition: 'pause' })}>{t('deployPause')}</Button>
                              {(rec.channels ?? []).length > 0 ? (
                                <Button size="sm" variant="danger" loading={working('rollback')} disabled={busy !== null} onClick={() => void danger(rec, 'rollback')}>{t('deployRollback')}</Button>
                              ) : null}
                              <Button size="sm" variant="quiet" loading={working('deprecate')} disabled={busy !== null} onClick={() => void danger(rec, 'deprecate')}>{t('deployDeprecate')}</Button>
                              <TextField label={t('deployCanaryLabel', { version: rec.version })} type="number" min={0} max={100} inputMode="numeric"
                                value={canary[rec.version] ?? ''} onChange={(e) => setCanary((c) => ({ ...c, [rec.version]: e.target.value }))} />
                              <Button size="sm" variant="secondary" loading={working('adjust-canary')}
                                disabled={busy !== null || !/^(100|[1-9]?\d)$/.test(canary[rec.version] ?? '')}
                                onClick={() => void run(rec, { transition: 'adjust-canary', canaryPercent: Number(canary[rec.version]) })}>
                                {t('deployCanaryApply')}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {policy ? (
        <section className="surface-card u-flex u-flex-col u-gap-3" aria-label={t('deployPolicyTitle')}>
          <h3 className="u-fs-14 u-fw-600 u-m-0">{t('deployPolicyTitle')}</h3>
          {policy.fixed ? <p className="muted u-fs-13 u-m-0">{t('deployPolicyFixed')}</p> : (
            <>
              <CheckboxField label={t('deployPolicyEval')} help={t('deployPolicyEvalHelp')} checked={draftPolicy.eval}
                disabled={!canWrite} onChange={(e) => setDraftPolicy((p) => ({ ...p, eval: e.target.checked }))} />
              <CheckboxField label={t('deployPolicyApproval')} help={t('deployPolicyApprovalHelp')} checked={draftPolicy.approval}
                disabled={!canWrite} onChange={(e) => setDraftPolicy((p) => ({ ...p, approval: e.target.checked }))} />
              {canWrite ? (
                <div className="action-bar">
                  <Button variant="primary" loading={busy === 'policy'} disabled={busy !== null} onClick={() => void savePolicy()}>{t('deployPolicySave')}</Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
