/**
 * ADR 0946 P5 — the campaign's Variants section: its variant sets, each as a
 * concept board (columns are concepts, rows within a concept are channels),
 * the diversity score and pre-flight findings when they exist, and the
 * version history. Read-only: sets are made by the variant-factory chain or
 * the API, and every edit is a new version.
 *
 * Lazy-loaded from the campaign detail (it has its own chunk). The section
 * renders nothing when the variant factory is off for the workspace, says so
 * when a read fails (never "no sets"), and labels what has not run yet
 * (diversity, pre-flight) instead of hiding it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { formatDateTime } from '../../i18n/format.js';
import { FeatureDisabledError } from './campaignStudioClient.js';
import { listVariantSets, listVariantSetVersions, type VariantMember, type VariantSet, type VariantSetStatus } from './variantsClient.js';

type Load = { kind: 'loading' } | { kind: 'off' } | { kind: 'failed' } | { kind: 'ready'; sets: VariantSet[] };
type TFn = ReturnType<typeof useTranslation>['t'];

const STATUS_CHIP: Record<VariantSetStatus, string> = {
  draft: 'chip--muted', preflight: 'chip--accent', in_review: 'chip--warning', approved: 'chip--success', superseded: 'chip--muted',
};
const shortHash = (h: string): string => h.slice(0, 10);

function memberPreview(m: VariantMember, t: TFn): string {
  const ref = m.ref;
  if ('copy' in ref) return ref.copy.headline ?? Object.values(ref.copy)[0] ?? '';
  if ('pageId' in ref) return t('variantsRefPage', { version: ref.pageVersion });
  if ('emailTemplateId' in ref) return t('variantsRefEmail', { version: ref.version });
  return t('variantsRefMedia');
}

function ConceptBoard({ set, t }: { set: VariantSet; t: TFn }): JSX.Element {
  const findingsFor = (memberId: string): { block: number; review: number } => {
    const own = (set.preflight?.findings ?? []).filter((f) => f.assetId === memberId);
    return { block: own.filter((f) => f.action === 'block').length, review: own.filter((f) => f.action === 'needs_review').length };
  };
  return (
    <div className="card-grid">
      {set.concepts.map((c) => {
        const members = set.members.filter((m) => m.conceptId === c.conceptId);
        const channels = [...new Set(members.map((m) => m.channel))].sort();
        return (
          <article key={c.conceptId} className="surface-card" aria-label={t('variantsConceptAria', { angle: c.axes.angle })}>
            <h4 className="u-mt-0 u-mb-1">{c.axes.angle}</h4>
            <div className="list-row-name-line u-mb-2">
              <span className="chip chip--muted">{t(`variantsHook_${c.axes.hook}`, { defaultValue: c.axes.hook })}</span>
              <span className="chip chip--muted">{t(`variantsVisual_${c.axes.visual}`, { defaultValue: c.axes.visual })}</span>
              <span className="chip chip--muted">{t(`variantsFormat_${c.axes.format}`, { defaultValue: c.axes.format })}</span>
            </div>
            <p className="muted u-fs-13 u-mt-0">{c.rationale}</p>
            {channels.length === 0 ? <p className="muted u-fs-13">{t('variantsNoMembers')}</p> : channels.map((ch) => (
              <div key={ch} className="u-mb-2">
                <p className="u-fs-13 u-fw-600 u-mb-1">{ch}</p>
                <ul className="u-m-0">
                  {members.filter((m) => m.channel === ch).map((m) => {
                    const f = findingsFor(m.memberId);
                    return (
                      <li key={m.memberId} className="u-fs-13">
                        <span className="chip chip--muted">{t(`variantsKind_${m.kind}`)}</span>{' '}
                        {memberPreview(m, t)}
                        {f.block > 0 ? <> <span className="chip chip--danger">{t('variantsBlocks', { count: f.block })}</span></> : null}
                        {f.review > 0 ? <> <span className="chip chip--warning">{t('variantsReviews', { count: f.review })}</span></> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </article>
        );
      })}
    </div>
  );
}

function SetDetail({ campaignId, head, t }: { campaignId: string; head: VariantSet; t: TFn }): JSX.Element {
  const [versions, setVersions] = useState<VariantSet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState<number>(head.version);
  const load = useCallback(async () => {
    setFailed(false);
    try { setVersions(await listVariantSetVersions(campaignId, head.setId)); } catch { setVersions(null); setFailed(true); }
  }, [campaignId, head.setId]);
  useEffect(() => { void load(); }, [load]);
  const set = versions?.find((v) => v.version === shown) ?? head;

  return (
    <div className="u-mt-3">
      <div className="action-bar u-flex u-items-center u-gap-2 u-mb-2">
        <span className="chip chip--muted">{t('variantsVersion', { version: set.version })}</span>
        <span className={`chip ${STATUS_CHIP[set.status]}`}>{t(`variantsStatus_${set.status}`)}</span>
        <code className="u-fs-13" title={set.hash}>{shortHash(set.hash)}</code>
      </div>

      <ConceptBoard set={set} t={t} />

      <h4>{t('variantsDiversityTitle')}</h4>
      {set.diversity ? (
        <>
          <p className="u-fs-13 u-mt-0">{t('variantsDiversitySummary', { mean: set.diversity.conceptDistance.mean, min: set.diversity.conceptDistance.min, clusters: set.diversity.clusters.length })}</p>
          <p className="muted u-fs-13">{t('variantsDiversityProxy')}</p>
        </>
      ) : <p className="muted u-fs-13 u-mt-0">{t('variantsDiversityNotRun')}</p>}

      <h4>{t('variantsPreflightTitle')}</h4>
      {set.preflight
        ? <p className="u-fs-13 u-mt-0">{t('variantsPreflightSummary', { count: set.preflight.findings.length, version: set.preflight.rulesetVersion })}</p>
        : <p className="muted u-fs-13 u-mt-0">{t('variantsPreflightNotRun')}</p>}

      <h4>{t('variantsHistoryTitle')}</h4>
      {failed ? (
        <InlineState kind="failed" announce={t('variantsHistoryFailed')} announcePolite message={t('variantsHistoryFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void load()}>{t('variantsRetry')}</Button>} />
      ) : versions === null ? <InlineState kind="loading" message={t('variantsLoading')} /> : (
        <ol className="u-m-0" aria-label={t('variantsHistoryTitle')}>
          {versions.map((v) => (
            <li key={v.version} className="u-fs-13 u-mb-1">
              <Button variant="link" aria-current={v.version === shown ? 'true' : undefined} onClick={() => setShown(v.version)}>
                {t('variantsVersion', { version: v.version })}
              </Button>{' '}
              <span className={`chip ${STATUS_CHIP[v.status]}`}>{t(`variantsStatus_${v.status}`)}</span>{' '}
              <span className="muted">{formatDateTime(v.createdAt)} · <code title={v.hash}>{shortHash(v.hash)}</code></span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function CampaignVariantsSection({ campaignId }: { campaignId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-orchestration');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [openSet, setOpenSet] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try { setLoad({ kind: 'ready', sets: await listVariantSets(campaignId) }); }
    catch (e) { setLoad(e instanceof FeatureDisabledError ? { kind: 'off' } : { kind: 'failed' }); }
  }, [campaignId]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (load.kind === 'off') return null;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-variants">
      <h3 id="campaign-variants" className="u-mt-0">{t('variantsTitle')}</h3>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('variantsLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('variantsLoadFailed')} announcePolite message={t('variantsLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('variantsRetry')}</Button>} />
      ) : null}
      {load.kind === 'ready' && load.sets.length === 0 ? <p className="muted u-mb-0">{t('variantsEmpty')}</p> : null}
      {load.kind === 'ready' && load.sets.length > 0 ? (
        <ul className="u-m-0">
          {load.sets.map((s) => (
            <li key={s.setId} className="u-mb-2">
              <Button variant="link" aria-expanded={openSet === s.setId} onClick={() => setOpenSet(openSet === s.setId ? null : s.setId)}>
                {t('variantsSetLabel', { concepts: t('variantsConcepts', { count: s.concepts.length }), members: t('variantsMembers', { count: s.members.length }) })}
              </Button>{' '}
              <span className="chip chip--muted">{t('variantsVersion', { version: s.version })}</span>{' '}
              <span className={`chip ${STATUS_CHIP[s.status]}`}>{t(`variantsStatus_${s.status}`)}</span>{' '}
              <span className="muted u-fs-13">{formatDateTime(s.createdAt)}</span>
              {openSet === s.setId ? <SetDetail campaignId={campaignId} head={s} t={t} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
