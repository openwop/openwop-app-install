/**
 * Market-intel workspace (ADR 0403 Phase 4) — the per-brief Intel view inside
 * the Campaign Brief detail (no new top-level surface): the evidence browser
 * (verbatim quotes with source citations + sentiment/theme facets), the angle
 * list with its proof chain, the ORG hook bank (promote candidate → tested →
 * retire — the human gate), and the per-platform targeting packs. Research runs
 * through the one chat scoped to the Brief Strategist (ADR 0058) or the
 * campaign-studio.market-intel workflow — this surface curates, it never
 * generates.
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { Modal } from '../../ui/Modal.js';
import { TextField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { SparklesIcon, TrashIcon, CheckIcon, XIcon, MegaphoneIcon } from '../../ui/icons/index.js';
import {
  listVocEvidence, deleteVocEvidence, listAngles, deleteAngle,
  listHooks, promoteHook, listTargetingPacks, deleteTargetingPack,
  VOC_SENTIMENTS, HOOK_STATUSES,
  type VocEvidence, type AdAngle, type Hook, type TargetingPack, type VocSentiment, type HookStatus, type CampaignBrief,
} from './campaignBriefClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

const sentimentChipClass = (s: VocSentiment): string =>
  s === 'pain' || s === 'objection' ? 'chip--warning' : s === 'praise' ? 'chip--success' : 'chip--accent';

const hookChipClass = (s: HookStatus): string =>
  s === 'tested' ? 'chip--success' : s === 'retired' ? 'chip--muted' : 'chip--accent';

export function IntelWorkspace({ brief, onError, onOpenStrategist }: {
  brief: CampaignBrief; onError: (m: string) => void; onOpenStrategist: () => void;
}): JSX.Element {
  // The i18n gate resolves the namespace per file — own the hook here rather
  // than threading `t` from the page.
  const { t } = useTranslation('campaign-brief');
  return (
    <div>
      <EvidenceSection t={t} briefId={brief.id} onError={onError} onOpenStrategist={onOpenStrategist} />
      <AnglesSection t={t} briefId={brief.id} onError={onError} />
      <HookBankSection t={t} orgId={brief.orgId} onError={onError} />
      <TargetingSection t={t} briefId={brief.id} onError={onError} />
    </div>
  );
}

function EvidenceSection({ t, briefId, onError, onOpenStrategist }: { t: TFn; briefId: string; onError: (m: string) => void; onOpenStrategist: () => void }): JSX.Element {
  const [evidence, setEvidence] = useState<VocEvidence[] | null>(null);
  const [sentiment, setSentiment] = useState<'' | VocSentiment>('');
  const [confirmDelete, setConfirmDelete] = useState<VocEvidence | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  // R2 CB-SP-7 — flipping the sentiment facet re-runs refresh, and the SLOWER
  // earlier response could land last, filling the list with the wrong facet's
  // rows while the select shows the new one. Latest-wins.
  const seqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try { const rows = await listVocEvidence(briefId, sentiment ? { sentiment } : undefined); if (seq === seqRef.current) setEvidence(rows); }
    catch (e) { if (seq === seqRef.current) onError(e instanceof Error ? e.message : t('actionFailed')); }
  }, [briefId, sentiment, onError, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="surface-card u-mb-4">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <h3 className="u-m-0 u-flex-1">{t('intelEvidenceTitle')}</h3>
        <select className="ui-input filterbar-select" value={sentiment} onChange={(e) => setSentiment(e.target.value as '' | VocSentiment)} aria-label={t('intelSentimentFilter')}>
          <option value="">{t('intelAllSentiments')}</option>
          {VOC_SENTIMENTS.map((s) => <option key={s} value={s}>{t(`sentiment_${s}`)}</option>)}
        </select>
      </div>
      {conflict ? (
        <Notice variant="warning">
          <Button variant="link" className="u-fs-11" onClick={() => setConflict(null)} aria-label={t('common:close')}><XIcon size={12} /></Button>
          {conflict}
        </Notice>
      ) : null}
      {evidence === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('intelLoading')} loading />
      ) : evidence.length === 0 ? (
        <StateCard
          icon={<SparklesIcon size={22} />}
          title={sentiment ? t('noMatchTitle') : t('intelNoEvidenceTitle')}
          body={sentiment ? t('noMatchBody') : t('intelNoEvidenceBody')}
          action={sentiment ? undefined : <Button variant="primary" size="sm" onClick={onOpenStrategist}><SparklesIcon size={13} /> {t('intelRunResearch')}</Button>}
        />
      ) : (
        <ul className="u-list-none u-m-0 u-p-0">
          {evidence.map((e) => (
            <li key={e.id} className="list-row">
              <div className="list-row-name-wrap u-flex-1">
                <blockquote className="u-m-0 u-fs-13">&ldquo;{e.quote}&rdquo;</blockquote>
                <span className="list-row-name-line u-mt-1">
                  <span className={`chip ${sentimentChipClass(e.sentiment)}`}>{t(`sentiment_${e.sentiment}`)}</span>
                  <span className="chip chip--muted">{e.theme}</span>
                  <span className="u-fs-11 muted">{t('intelSource', { kind: t(`sourceKind_${e.sourceRef.sourceKind}`), locator: e.sourceRef.locator })}</span>
                </span>
              </div>
              <Button variant="quiet" size="sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(e)}><TrashIcon size={15} /></Button>
            </li>
          ))}
        </ul>
      )}
      {confirmDelete ? (
        <ConfirmDialog title={t('intelDeleteEvidenceTitle')} body={t('intelDeleteEvidenceBody')} confirmLabel={t('common:delete')} danger busy={deleting}
          onConfirm={async () => {
            setConflict(null); setDeleting(true);
            try { await deleteVocEvidence(briefId, confirmDelete.id); setConfirmDelete(null); await refresh(); }
            catch (e) {
              setConfirmDelete(null);
              // The 409 evidence_cited guard — surfaced as guidance, not a failure.
              setConflict(e instanceof Error && /cited/i.test(e.message) ? t('intelEvidenceCited') : (e instanceof Error ? e.message : t('actionFailed')));
            } finally { setDeleting(false); }
          }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </section>
  );
}

function AnglesSection({ t, briefId, onError }: { t: TFn; briefId: string; onError: (m: string) => void }): JSX.Element {
  const [angles, setAngles] = useState<AdAngle[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdAngle | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try { setAngles(await listAngles(briefId)); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
  }, [briefId, onError, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="surface-card u-mb-4">
      <h3 className="u-mt-0">{t('intelAnglesTitle')}</h3>
      {angles === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('intelLoading')} loading />
      ) : angles.length === 0 ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('intelNoAnglesTitle')} body={t('intelNoAnglesBody')} />
      ) : (
        <ul className="u-list-none u-m-0 u-p-0">
          {angles.map((a) => (
            <li key={a.id} className="list-row">
              <div className="list-row-name-wrap u-flex-1">
                <span className="list-row-name-line">
                  <span className="u-fw-600">{a.claim}</span>
                  <span className="chip chip--accent">{a.positioningLens}</span>
                  <span className="chip chip--muted">{t('intelProofCount', { count: a.proofRefs.length })}</span>
                </span>
                {a.hookVariants.length > 0 ? (
                  <ul className="u-fs-13 muted u-mt-1 u-mb-0">
                    {a.hookVariants.map((h, i) => <li key={i}>{h.text} <span className="u-fs-11">({h.format})</span></li>)}
                  </ul>
                ) : null}
              </div>
              <Button variant="quiet" size="sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(a)}><TrashIcon size={15} /></Button>
            </li>
          ))}
        </ul>
      )}
      {confirmDelete ? (
        <ConfirmDialog title={t('intelDeleteAngleTitle')} body={t('intelDeleteAngleBody')} confirmLabel={t('common:delete')} danger busy={deleting}
          onConfirm={async () => {
            setDeleting(true);
            try { await deleteAngle(briefId, confirmDelete.id); setConfirmDelete(null); await refresh(); }
            catch (e) { setConfirmDelete(null); onError(e instanceof Error ? e.message : t('actionFailed')); }
            finally { setDeleting(false); }
          }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </section>
  );
}

function HookBankSection({ t, orgId, onError }: { t: TFn; orgId: string; onError: (m: string) => void }): JSX.Element {
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [status, setStatus] = useState<'' | HookStatus>('');
  // INTEL-1 (UX pass): "Mark tested" captures the optional campaign-intel
  // metricRef so a tested hook keeps its attribution trail.
  const [promoting, setPromoting] = useState<Hook | null>(null);
  const [metricRef, setMetricRef] = useState('');

  // R2 CB-SP-7 — same latest-wins guard as the evidence facet.
  const seqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try { const rows = await listHooks(orgId, status || undefined); if (seq === seqRef.current) setHooks(rows); }
    catch (e) { if (seq === seqRef.current) onError(e instanceof Error ? e.message : t('actionFailed')); }
  }, [orgId, status, onError, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  const promote = async (hook: Hook, next: HookStatus, ref?: string): Promise<void> => {
    try { await promoteHook(hook.id, orgId, next, ref?.trim() || undefined); toast.success(t('intelHookPromoted', { status: t(`hookStatus_${next}`) })); await refresh(); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
  };

  return (
    <section className="surface-card u-mb-4">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <h3 className="u-m-0 u-flex-1">{t('intelHookBankTitle')}</h3>
        <select className="ui-input filterbar-select" value={status} onChange={(e) => setStatus(e.target.value as '' | HookStatus)} aria-label={t('intelHookStatusFilter')}>
          <option value="">{t('intelAllHookStatuses')}</option>
          {HOOK_STATUSES.map((s) => <option key={s} value={s}>{t(`hookStatus_${s}`)}</option>)}
        </select>
      </div>
      <p className="u-label-sm u-mt-0">{t('intelHookBankHint')}</p>
      {hooks === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('intelLoading')} loading />
      ) : hooks.length === 0 ? (
        <StateCard icon={<SparklesIcon size={22} />} title={status ? t('noMatchTitle') : t('intelNoHooksTitle')} body={status ? t('noMatchBody') : t('intelNoHooksBody')} />
      ) : (
        <ul className="u-list-none u-m-0 u-p-0">
          {hooks.map((h) => (
            <li key={h.id} className="list-row">
              <div className="list-row-name-wrap u-flex-1">
                <span className="list-row-name-line">
                  <span>{h.text}</span>
                  <span className={`chip ${hookChipClass(h.status)}`}>{t(`hookStatus_${h.status}`)}</span>
                  <span className="chip chip--muted">{h.format}</span>
                  {h.metricRef ? <span className="u-fs-11 muted">{h.metricRef}</span> : null}
                </span>
              </div>
              {h.status === 'candidate' ? (
                <Button variant="secondary" size="sm" onClick={() => { setMetricRef(''); setPromoting(h); }}><CheckIcon size={13} /> {t('intelMarkTested')}</Button>
              ) : null}
              {h.status !== 'retired' ? (
                <Button variant="quiet" size="sm" onClick={() => void promote(h, 'retired')}>{t('intelRetire')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {promoting ? (
        <Modal label={t('intelMarkTested')} onClose={() => setPromoting(null)} showClose>
          <h2 className="u-mt-0">{t('intelMarkTested')}</h2>
          <p className="u-fs-13 muted">&ldquo;{promoting.text}&rdquo;</p>
          <form onSubmit={(e) => { e.preventDefault(); const h = promoting; setPromoting(null); if (h) void promote(h, 'tested', metricRef); }}>
            <TextField label={t('intelMetricRefLabel')} help={t('intelMetricRefHelp')} value={metricRef} onChange={(e) => setMetricRef(e.target.value)} maxLength={200} />
            <div className="action-bar u-flex u-gap-2 u-justify-end">
              <Button variant="secondary" size="sm" onClick={() => setPromoting(null)}>{t('common:cancel')}</Button>
              <Button type="submit" variant="primary" size="sm"><CheckIcon size={13} /> {t('intelMarkTested')}</Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}

function TargetingSection({ t, briefId, onError }: { t: TFn; briefId: string; onError: (m: string) => void }): JSX.Element {
  const [packs, setPacks] = useState<TargetingPack[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TargetingPack | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try { setPacks(await listTargetingPacks(briefId)); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
  }, [briefId, onError, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="surface-card u-mb-4">
      <h3 className="u-mt-0">{t('intelTargetingTitle')}</h3>
      {packs === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('intelLoading')} loading />
      ) : packs.length === 0 ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('intelNoTargetingTitle')} body={t('intelNoTargetingBody')} />
      ) : (
        packs.map((p) => (
          <div key={p.platform} className="u-mb-3">
            <div className="u-flex u-items-center u-gap-2">
              <h4 className="u-m-0 u-flex-1">{t(`platform_${p.platform}`)}</h4>
              <span className="chip chip--muted">{t('intelProofCount', { count: p.evidenceRefs.length })}</span>
              <Button variant="quiet" size="sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(p)}><TrashIcon size={15} /></Button>
            </div>
            <div className="u-flex u-gap-2 u-wrap u-mt-1">
              {p.audiences.map((a, i) => <span key={`a${i}`} className="chip chip--accent">{a}</span>)}
              {p.interests.map((x, i) => <span key={`i${i}`} className="chip chip--muted">{x}</span>)}
              {p.keywords.map((k, i) => <span key={`k${i}`} className="chip chip--muted">{k}</span>)}
            </div>
            <p className="u-fs-13 muted u-mb-0">{p.rationale}</p>
          </div>
        ))
      )}
      {confirmDelete ? (
        <ConfirmDialog title={t('intelDeleteTargetingTitle')} body={t('intelDeleteTargetingBody')} confirmLabel={t('common:delete')} danger busy={deleting}
          onConfirm={async () => {
            setDeleting(true);
            try { await deleteTargetingPack(briefId, confirmDelete.platform); setConfirmDelete(null); await refresh(); }
            catch (e) { setConfirmDelete(null); onError(e instanceof Error ? e.message : t('actionFailed')); }
            finally { setDeleting(false); }
          }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </section>
  );
}
