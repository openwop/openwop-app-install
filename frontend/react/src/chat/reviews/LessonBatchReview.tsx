/**
 * The typed `kicktodo.challenge-lesson-batch` approval body (XCH-GATE-1 /
 * XCH-LB-3): a Challenge Factory checkpoint shows each built lesson BESIDE the
 * plan row it was built from, so the approver can compare instruction and
 * lesson, plus the lesson's generated image when media was requested.
 *
 * Before this, the checkpoint gate's preview was the sub-workflow's
 * `{childRunId, childStatus}` — the approver signed a batch they never saw.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getArtifact, getArtifactRevision } from '../artifacts/artifactClient.js';
import { mediaSrc } from '../mediaSrc.js';
import type { ReviewAsset } from './reviewClient.js';

interface PlanRow { title: string; actionInstruction: string; userFacingWhy: string }
interface BatchLesson {
  day: number;
  title: string;
  body: string;
  steps: string[];
  claimRefs: string[];
  mediaAssetId?: string;
  plan?: PlanRow;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Parse defensively: a malformed row is dropped, never rendered as raw JSON.
 *  null = the batch itself could not be read, which an approver must be told
 *  apart from an empty batch. */
export function parseLessonBatch(content: string | undefined): BatchLesson[] | null {
  let raw: unknown;
  try { raw = JSON.parse(content ?? ''); } catch { return null; }
  const lessons = raw && typeof raw === 'object' ? (raw as { lessons?: unknown }).lessons : undefined;
  if (!Array.isArray(lessons)) return null;
  return lessons.flatMap((l): BatchLesson[] => {
    if (!l || typeof l !== 'object') return [];
    const r = l as Record<string, unknown>;
    if (typeof r.day !== 'number') return [];
    const plan = r.plan && typeof r.plan === 'object' ? (r.plan as Record<string, unknown>) : null;
    return [{
      day: r.day,
      title: str(r.title),
      body: str(r.body),
      steps: Array.isArray(r.steps) ? r.steps.filter((s): s is string => typeof s === 'string') : [],
      claimRefs: Array.isArray(r.claimRefs) ? r.claimRefs.filter((s): s is string => typeof s === 'string') : [],
      ...(typeof r.mediaAssetId === 'string' && r.mediaAssetId ? { mediaAssetId: r.mediaAssetId } : {}),
      ...(plan ? { plan: { title: str(plan.title), actionInstruction: str(plan.actionInstruction), userFacingWhy: str(plan.userFacingWhy) } } : {}),
    }];
  });
}

/** The lesson's generated image, read through the artifact projection (which
 *  enforces org access from the asset record) and passed through the shared
 *  `mediaSrc` allowlist. A failed read SAYS so — an approver must never take a
 *  missing image for "no image". */
function LessonImage({ assetId, alt }: { assetId: string; alt: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = `media:${assetId}`;
        const artifact = await getArtifact(id);
        if (!artifact.latestRevisionId) throw new Error('media artifact has no revision');
        const rev = await getArtifactRevision(id, artifact.latestRevisionId);
        const safe = rev.content && artifact.format?.startsWith('image/') ? mediaSrc(artifact.format, rev.content) : null;
        if (cancelled) return;
        if (safe) setSrc(safe); else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [assetId]);
  if (failed) return <p className="u-fs-12 u-text-muted u-m-0" role="status">{t('assetPreviewMediaFailed')}</p>;
  if (!src) return <p className="u-fs-12 u-text-muted u-m-0">{t('lessonBatchImageLoading')}</p>;
  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
       onError is a resource-load failure hook (the designed fallback above),
       not a user interaction on the image — the AssetPreview precedent. */
    <img src={src} alt={alt} className="msgrender-img" loading="lazy" onError={() => setFailed(true)} />
  );
}

export function LessonBatchReview({ asset }: { asset: ReviewAsset }): JSX.Element {
  const { t } = useTranslation('chat');
  const lessons = useMemo(() => parseLessonBatch(asset.content), [asset.content]);
  if (lessons === null) return <p className="u-fs-12 u-m-0" role="alert">{t('lessonBatchUnreadable')}</p>;
  if (lessons.length === 0) return <p className="u-fs-12 u-text-muted u-m-0">{t('lessonBatchEmpty')}</p>;
  return (
    <ol className="u-m-0 u-flex u-flex-col u-gap-3">
      {lessons.map((l) => (
        <li key={l.day} className="u-flex u-flex-col u-gap-1">
          <h4 className="u-fs-13 u-m-0">{t('lessonBatchDayTitle', { day: l.day, title: l.title })}</h4>
          {l.plan ? (
            <div className="u-fs-12 u-text-muted">
              <p className="u-m-0">{t('lessonBatchPlanRow', { instruction: l.plan.actionInstruction })}</p>
              {l.plan.userFacingWhy ? <p className="u-m-0">{t('lessonBatchPlanWhy', { why: l.plan.userFacingWhy })}</p> : null}
            </div>
          ) : null}
          <p className="u-fs-13 u-m-0">{l.body}</p>
          {l.steps.length > 0 ? (
            <ul className="u-m-0">
              {l.steps.map((s, i) => <li key={i} className="u-fs-13">{s}</li>)}
            </ul>
          ) : null}
          <p className="u-fs-11 u-text-muted u-m-0">
            {l.claimRefs.length > 0 ? t('lessonBatchCites', { ids: l.claimRefs.join(', ') }) : t('lessonBatchCitesNone')}
          </p>
          {l.mediaAssetId ? <LessonImage assetId={l.mediaAssetId} alt={t('lessonBatchImageAlt', { day: l.day })} /> : null}
        </li>
      ))}
    </ol>
  );
}
