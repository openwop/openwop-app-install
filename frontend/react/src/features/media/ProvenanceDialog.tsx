/**
 * ADR 0945 P5 — the provenance drawer of a generated asset: how it was made
 * (mode, provider, model, operation, prompt hash, the render it came from), the
 * product photos it was built from beside the result, and its fidelity verdict —
 * every check with its measured value and threshold, and the vision judge's
 * answers with its evidence. Read-only. Loaded lazily from the Media Library.
 * Judge evidence is untrusted model text: rendered as plain text, never markup.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { formatDateTime, formatNumber } from '../../i18n/format.js';
import { absoluteServeUrl, getAssetProvenance, type AssetProvenance, type MediaAsset } from './mediaClient.js';
import { assetAlt } from './MediaViews.js';

const statusChip = (status: 'pass' | 'fail' | 'not_applicable'): string =>
  status === 'pass' ? 'chip chip--success' : status === 'fail' ? 'chip chip--danger' : 'chip chip--muted';
const answerChip = (answer: 'match' | 'mismatch' | 'not_visible'): string =>
  answer === 'match' ? 'chip chip--success' : answer === 'mismatch' ? 'chip chip--danger' : 'chip chip--muted';

export default function ProvenanceDialog({ orgId, asset, onClose }: { orgId: string; asset: MediaAsset; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('media');
  const [data, setData] = useState<AssetProvenance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getAssetProvenance(orgId, asset.assetId)
      .then((p) => { if (live) setData(p); })
      // Fallback copy is resolved at render (`t` is not an effect dependency).
      .catch((e: unknown) => { if (live) setError(e instanceof Error && e.message ? e.message : ''); });
    return () => { live = false; };
  }, [orgId, asset.assetId]);

  return (
    <Modal onClose={onClose} label={t('provenanceTitle', { name: asset.name })} loading={!data && error === null} error={error === null ? undefined : (error || t('provenanceLoadError'))} showClose>
      {data ? <ProvenanceEvidence asset={asset} data={data} /> : null}
    </Modal>
  );
}


/** The same read-only evidence on the Media Library drawer and approval card. */
export function ProvenanceEvidence({ asset, data }: { asset: MediaAsset; data: AssetProvenance }): JSX.Element {
  const { t } = useTranslation('media');
  const g = data.grounding;
  const v = data.verdict;
  const id = useId();
  return (
    g ? (
        <div className="u-grid u-gap-3">
          <h2 className="u-fs-16">{t('provenanceTitle', { name: asset.name })}</h2>

          <section className="u-grid u-gap-2" aria-labelledby={`${id}-compare`}>
            <h3 id={`${id}-compare`} className="u-fs-14">{t('provenanceCompare')}</h3>
            <div className="card-grid">
              {data.sources.map((s, i) => (
                <figure key={`${s.assetId}-${i}`} className="surface-card u-p-2 u-gap-1">
                  {s.present && s.serveUrl && s.contentType?.startsWith('image/') ? (
                    <div className="media-thumb"><img src={absoluteServeUrl(s.serveUrl)} alt="" className="media-thumb-img" /></div>
                  ) : null}
                  <figcaption className="u-label-sm">
                    {s.present ? t('provenanceSource', { name: s.name ?? s.assetId }) : t('provenanceSourceGone')}
                  </figcaption>
                </figure>
              ))}
              <figure className="surface-card u-p-2 u-gap-1">
                {asset.contentType.startsWith('image/') ? (
                  <div className="media-thumb"><img src={absoluteServeUrl(asset.serveUrl)} alt={assetAlt(asset)} className="media-thumb-img" /></div>
                ) : null}
                <figcaption className="u-label-sm"><span>{t('provenanceResult')}</span> · <a href={absoluteServeUrl(asset.serveUrl)} target="_blank" rel="noreferrer">{asset.name}</a></figcaption>
              </figure>
            </div>
          </section>

          <section className="u-grid u-gap-1" aria-labelledby={`${id}-made`}>
            <h3 id={`${id}-made`} className="u-fs-14">{t('provenanceHowMade')}</h3>
            <dl className="u-grid u-gap-1 u-fs-13">
              <div><dt className="u-label-sm">{t('provenanceMode')}</dt><dd>{t(`provenanceMode_${g.mode}`, { defaultValue: g.mode })}</dd></div>
              <div><dt className="u-label-sm">{t('provenanceModel')}</dt><dd>{`${g.provider} · ${g.model} · ${g.op}`}</dd></div>
              {g.promptHash ? <div><dt className="u-label-sm">{t('provenancePromptHash')}</dt><dd><code>{g.promptHash.slice(0, 12)}</code></dd></div> : null}
              {g.composedFrom ? <div><dt className="u-label-sm">{t('provenanceTemplate')}</dt><dd>{g.composedFrom.templateId}</dd></div> : null}
            </dl>
          </section>

          <section className="u-grid u-gap-2" aria-labelledby={`${id}-check`}>
            <h3 id={`${id}-check`} className="u-fs-14">{t('provenanceCheck')}</h3>
            {v ? (
              <>
                <p className="u-fs-13">
                  {t(`provenanceOutcome_${v.outcome}`)} · {t('provenanceCheckedAt', { when: formatDateTime(v.checkedAt), ruleset: v.rulesetVersion })}
                </p>
                <ul className="u-grid u-gap-1 u-fs-13">
                  {v.checks.map((c, i) => (
                    <li key={`${c.id}-${i}`} className="u-flex u-flex-wrap u-gap-2">
                      <span className={statusChip(c.status)}>{t(`provenanceStatus_${c.status}`)}</span>
                      <span>{t(`provenanceCheck_${c.id}`, { defaultValue: c.detail })}</span>
                      {c.value !== undefined && c.threshold !== undefined ? (
                        <span className="u-text-muted">{t('provenanceValue', { value: formatNumber(c.value), threshold: formatNumber(c.threshold) })}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {v.judge ? (
                  <div className="u-grid u-gap-1">
                    <h4 className="u-fs-13">{t('provenanceJudge', { model: v.judge.model ?? v.judge.provider })}</h4>
                    <ul className="u-grid u-gap-1 u-fs-13">
                      {v.judge.results.map((r) => (
                        <li key={r.attribute} className="u-flex u-flex-wrap u-gap-2">
                          <span className={answerChip(r.answer)}>{t(`provenanceAnswer_${r.answer}`)}</span>
                          <span>{t(`provenanceAttr_${r.attribute}`, { defaultValue: r.attribute })}</span>
                          <span className="u-text-muted">{r.evidence}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <Notice variant="info">{t('provenanceNotChecked')}</Notice>
            )}
          </section>
        </div>
      ) : (
        <Notice variant="info">{t('provenanceNone')}</Notice>
      )
  );
}
