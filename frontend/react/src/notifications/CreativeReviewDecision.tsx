/** ADR 0945 × 0942 — review the actual asset and the exact immutable check.
 * Both inboxes share this component. No asset/evidence read runs until opened;
 * missing, changed or unreadable evidence leaves Approve disabled, Reject usable.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingApproval } from '../agents/approvalsClient.js';
import { getMediaAsset, getAssetProvenance, type MediaAsset, type AssetProvenance } from '../features/media/mediaClient.js';
import { ProvenanceEvidence } from '../features/media/ProvenanceDialog.js';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/Notice.js';
import { ApprovalDecideBar } from './ContentReviewContext.js';

interface Props {
  approval: PendingApproval;
  busy: boolean;
  onApprove: () => void;
  onReject: (note?: string) => void | boolean | Promise<void | boolean>;
}
export default function CreativeReviewDecision(props: Props): JSX.Element {
  const a = props.approval;
  return <Review key={JSON.stringify([a.approvalId, a.orgId, a.assetId, a.verdictId])} {...props} />;
}
function Review({ approval: a, busy, onApprove, onReject }: Props): JSX.Element {
  const { t } = useTranslation('notifications');
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ asset: MediaAsset; evidence: AssetProvenance } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attempt === 0) return;
    let live = true;
    setLoading(true); setView(null); setFailed(false);
    const orgId = a.orgId; const assetId = a.assetId; const verdictId = a.verdictId;
    const load = async (): Promise<void> => {
      if (!orgId || !assetId || !verdictId) throw new Error('Unbound creative review');
      const [asset, evidence] = await Promise.all([getMediaAsset(orgId, assetId), getAssetProvenance(orgId, assetId)]);
      if (asset.orgId !== orgId || asset.assetId !== assetId || evidence.assetId !== assetId
        || !asset.contentHash || evidence.verdict?.assetSha256 !== asset.contentHash
        || evidence.verdict.verdictId !== verdictId || evidence.verdict.outcome !== 'needs_review'
        || evidence.grounding?.fidelity?.verdictId !== verdictId || evidence.sources.some((source) => !source.present)) {
        throw new Error('Creative review evidence changed');
      }
      if (live) setView({ asset, evidence });
    };
    void load().catch(() => { if (live) setFailed(true); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [attempt, a.orgId, a.assetId, a.verdictId]);
  return (
    <div className="u-grid u-gap-2">
      <p className="muted u-fs-12 u-m-0">{t('approvalsCreativeReviewHelp')}</p>
      {view ? <ProvenanceEvidence asset={view.asset} data={view.evidence} /> : (
        <Button variant="secondary" size="sm" loading={loading} disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
          {failed ? t('common:retry') : t('media:provenanceLabel')}
        </Button>
      )}
      {failed ? <Notice variant="warning" announce={t('approvalsCreativeReviewUnavailable')}>{t('approvalsCreativeReviewUnavailable')}</Notice> : null}
      <ApprovalDecideBar busy={busy} approveDisabled={!view || loading} onApprove={() => { if (view) onApprove(); }} onReject={onReject} />
    </div>
  );
}
