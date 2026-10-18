/**
 * The typed `kicktodo.challenge-plan` approval body (XCH-GATE-1, outline half):
 * the Challenge Factory's outline gate shows the plan as an outline — promise,
 * outcomes, and each day's instruction, why and citations — instead of a JSON
 * dump of it. (No link to the outline canvas yet: the review asset carries no
 * candidate id, and inventing one would be a guess.)
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewAsset } from './reviewClient.js';

interface PlanDay { day: number; title: string; actionInstruction: string; userFacingWhy: string; estimatedMinutes?: number; claimRefs: string[] }
interface Plan { title: string; promise: string; audience: string; durationDays?: number; dailyMinutesBudget?: number; outcomes: string[]; days: PlanDay[] }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** Parse defensively; null = the plan itself could not be read (the approver is
 *  told so, never shown an empty outline as if it were the plan). */
export function parseChallengePlan(content: string | undefined): Plan | null {
  let raw: unknown;
  try { raw = JSON.parse(content ?? ''); } catch { return null; }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { days?: unknown }).days)) return null;
  const r = raw as Record<string, unknown>;
  const days = (r.days as unknown[]).flatMap((d): PlanDay[] => {
    if (!d || typeof d !== 'object') return [];
    const x = d as Record<string, unknown>;
    if (typeof x.day !== 'number') return [];
    const minutes = num(x.estimatedMinutes);
    return [{ day: x.day, title: str(x.title), actionInstruction: str(x.actionInstruction), userFacingWhy: str(x.userFacingWhy), claimRefs: strs(x.claimRefs), ...(minutes !== undefined ? { estimatedMinutes: minutes } : {}) }];
  });
  const outcomes = Array.isArray(r.outcomes)
    ? r.outcomes.flatMap((o) => (o && typeof o === 'object' && str((o as Record<string, unknown>).measurableOutcome) ? [str((o as Record<string, unknown>).measurableOutcome)] : []))
    : [];
  const durationDays = num(r.durationDays);
  const dailyMinutesBudget = num(r.dailyMinutesBudget);
  return {
    title: str(r.title), promise: str(r.promise), audience: str(r.audience), outcomes, days,
    ...(durationDays !== undefined ? { durationDays } : {}),
    ...(dailyMinutesBudget !== undefined ? { dailyMinutesBudget } : {}),
  };
}

export function ChallengePlanReview({ asset }: { asset: ReviewAsset }): JSX.Element {
  const { t } = useTranslation('chat');
  const plan = useMemo(() => parseChallengePlan(asset.content), [asset.content]);
  if (!plan) return <p className="u-fs-12 u-m-0" role="alert">{t('challengePlanUnreadable')}</p>;
  return (
    <div className="u-flex u-flex-col u-gap-2">
      <div className="u-flex u-flex-col u-gap-1">
        <h4 className="u-fs-13 u-m-0">{plan.title}</h4>
        {plan.promise ? <p className="u-fs-13 u-m-0">{plan.promise}</p> : null}
        <p className="u-fs-12 u-text-muted u-m-0">
          {t('challengePlanShape', { audience: plan.audience, days: plan.durationDays ?? plan.days.length, minutes: plan.dailyMinutesBudget ?? 0 })}
        </p>
      </div>
      {plan.outcomes.length > 0 ? (
        <div>
          <p className="u-fs-11 u-text-muted u-m-0">{t('challengePlanOutcomesHeading')}</p>
          <ul className="u-m-0">{plan.outcomes.map((o, i) => <li key={i} className="u-fs-13">{o}</li>)}</ul>
        </div>
      ) : null}
      <ol className="u-m-0 u-flex u-flex-col u-gap-1-5">
        {plan.days.map((d) => (
          <li key={d.day} className="u-fs-13">
            <span>{t('challengePlanDayTitle', { day: d.day, title: d.title })}</span>
            <p className="u-m-0">{d.actionInstruction}</p>
            {d.userFacingWhy ? <p className="u-fs-12 u-text-muted u-m-0">{t('lessonBatchPlanWhy', { why: d.userFacingWhy })}</p> : null}
            <p className="u-fs-11 u-text-muted u-m-0">
              {d.claimRefs.length > 0 ? t('lessonBatchCites', { ids: d.claimRefs.join(', ') }) : t('lessonBatchCitesNone')}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
