/**
 * ADR 1092 D2 — memory an agent proposed, waiting for a person. A writer
 * approves (it becomes project memory) or dismisses each one. Shows nothing
 * when there is nothing pending; a failed read says so instead of hiding.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { toast } from '../../ui/toast.js';
import { listMemoryProposals, decideMemoryProposal, type MemoryProposal } from './projectsClient.js';

export function MemoryProposals({ projectId, canWrite, onApproved }: { projectId: string; canWrite: boolean; onApproved: () => void }): JSX.Element | null {
  const { t } = useTranslation('projects');
  const [rows, setRows] = useState<MemoryProposal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(false);
    listMemoryProposals(projectId).then(setRows, () => setFailed(true));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  const decide = async (p: MemoryProposal, decision: 'approve' | 'dismiss'): Promise<void> => {
    setBusy(p.proposalId);
    try {
      await decideMemoryProposal(projectId, p.proposalId, decision);
      toast.success(decision === 'approve' ? t('proposalApproved') : t('proposalDismissed'));
      if (decision === 'approve') onApproved();
      load();
    } catch {
      toast.error(t('proposalDecideFailed'));
    } finally { setBusy(null); }
  };
  if (failed) return <p className="muted" role="status">{t('proposalsLoadFailed')} <Button variant="link" onClick={load}>{t('common:retry')}</Button></p>;
  const pending = (rows ?? []).filter((r) => r.status === 'pending');
  if (!pending.length) return null;
  return (
    <section className="surface-card u-flex u-flex-col u-gap-2 u-mb-4" aria-labelledby="proj-proposals-h">
      <h3 id="proj-proposals-h" className="u-m-0">{t('proposalsTitle', { count: pending.length })}</h3>
      <p className="muted u-m-0">{t('proposalsLede')}</p>
      <ul className="u-flex u-flex-col u-gap-2">
        {pending.map((p) => (
          <li key={p.proposalId} className="u-flex u-justify-between u-items-start u-gap-3">
            <span id={`proj-proposal-${p.proposalId}`}>{p.text}</span>
            {canWrite ? (
              <span className="u-flex u-gap-2">
                <Button size="sm" variant="primary" aria-describedby={`proj-proposal-${p.proposalId}`} disabled={busy !== null} onClick={() => void decide(p, 'approve')}>{t('proposalApprove')}</Button>
                <Button size="sm" variant="quiet" aria-describedby={`proj-proposal-${p.proposalId}`} disabled={busy !== null} onClick={() => void decide(p, 'dismiss')}>{t('proposalDismiss')}</Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
