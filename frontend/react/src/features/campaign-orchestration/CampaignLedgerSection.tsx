/**
 * ADR 0852 D6 — the campaign's team ledger, on the campaign itself.
 *
 * A campaign's ledger lives on its linked project (ADR 0852 D1), so this renders
 * the SAME Ledger UI the project page uses (`ProjectLedgerTab`) for that project —
 * no second ledger surface. A campaign finalized before the link existed has no
 * project yet: a writer can set it up here (create-or-return); a reader is told
 * there is none. A failed read is said, never shown as "no ledger".
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { ProjectLedgerTab } from '../projects/ProjectLedgerTab.js';
import { getProject, type Project } from '../projects/projectsClient.js';
import { ensureCampaignProject, getCampaign } from './campaignStudioClient.js';

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'none' } | { kind: 'ready'; project: Project };

export function CampaignLedgerSection({ campaignId }: { campaignId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-orchestration');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const c = await getCampaign(campaignId);
      setLoad(c.projectId ? { kind: 'ready', project: await getProject(c.projectId) } : { kind: 'none' });
    } catch {
      setLoad({ kind: 'failed' });
    }
  }, [campaignId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const setUp = async (): Promise<void> => {
    setBusy(true); setSetupFailed(false);
    try { await ensureCampaignProject(campaignId); await refresh(); } catch { setSetupFailed(true); } finally { setBusy(false); }
  };

  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-ledger">
      <h3 id="campaign-ledger" className="u-mt-0">{t('ledgerTitle')}</h3>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('ledgerLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('ledgerLoadFailed')} announcePolite message={t('ledgerLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('ledgerRetry')}</Button>} />
      ) : null}
      {load.kind === 'none' ? (
        <>
          <p className="muted">{t('ledgerNoneBody')}</p>
          {setupFailed ? <Notice variant="error" announce={t('ledgerSetupFailed')}>{t('ledgerSetupFailed')}</Notice> : null}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void setUp()}>{t('ledgerSetUp')}</Button>
        </>
      ) : null}
      {load.kind === 'ready' ? <ProjectLedgerTab project={load.project} canWrite={load.project.canWrite === true} /> : null}
    </section>
  );
}
