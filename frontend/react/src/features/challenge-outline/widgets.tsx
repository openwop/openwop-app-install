/**
 * Doc-level property widgets for the challenge-outline canvas type (ADR 0458
 * §2.3). `meta`, `outcomes`, and `achievements` are nested/array facets, so
 * each is edited by ONE widget that reads the whole facet from `docState` and
 * writes the whole facet back through the chassis doc-prop path (the
 * app-builder DataSourceRefWidget precedent — the widget owns the sub-structure,
 * the chassis owns the single history entry). Text edits ride `onChangeText`
 * (history.replace, so keystrokes never bury a structural op); discrete gestures
 * (add/remove row, select, checkbox) ride `onChange`.
 *
 * Referential integrity between outcomes ⇄ achievements ⇄ days is validated
 * server-side on Apply (validatePlan); these widgets surface the links, they do
 * not silently enforce them.
 */
import { Button } from '../../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveRegion } from '../../ui/announce.js';
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import type { PropertyWidgetProps } from '../../canvas/types.js';
import {
  coerceOutlineDoc, DEPTH_LEVELS, DURATION_MIN, DURATION_MAX, MINUTES_MIN, MINUTES_MAX,
  type DepthLevel, type OutlineAchievement, type OutlineMeta, type OutlineOutcome,
} from './types.js';

const metaFrom = (v: unknown): OutlineMeta => coerceOutlineDoc({ meta: v }).meta;
const outcomesFrom = (v: unknown): OutlineOutcome[] => coerceOutlineDoc({ outcomes: v }).outcomes;
const achievementsFrom = (v: unknown): OutlineAchievement[] => coerceOutlineDoc({ achievements: v }).achievements;

const nextId = (existing: readonly string[], prefix: string): string => {
  let n = existing.length + 1;
  while (existing.includes(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
};

/** Buffered numeric input (grade-ux fix): committing on every keystroke snapped
 *  an emptied field to its min mid-edit, so backspace-to-retype jumped the
 *  value. The buffer holds the raw string while focused and clamps on blur. */
function BufferedNumber({ id, label, value, min, max, onCommit }: {
  id: string; label: string; value: number; min: number; max: number; onCommit: (n: number) => void;
}): JSX.Element {
  const [buf, setBuf] = useState<string | null>(null);
  // Screen-polish: the clamp is VISIBLE — typing 400 into a 60-max field says
  // so (aria-live), instead of silently committing 60.
  //
  // ANN-UX-2 — via `useLiveRegion`, not a bare `useState`. Clamping the SAME
  // field to the same bound twice in a row (type 400, blur, type 999, blur)
  // produces a word-for-word identical note, and a polite region only speaks on
  // mutation: `Object.is`-equal state never reaches the DOM, so the second clamp
  // would be silent — precisely when the user is re-testing whether the field
  // took their value. `''` is the cleared state (the hook is string-typed).
  const [clamped, setClamped] = useLiveRegion();
  const { t } = useTranslation('challenge-outline');
  return (
    <>
      <label htmlFor={id} className="cv-editor__field-label">{label}</label>
      <input id={id} type="number" className="cv-editor__input" min={min} max={max}
        value={buf ?? String(value)}
        onChange={(e) => { setBuf(e.target.value); setClamped(''); }}
        onBlur={() => {
          const n = Number(buf);
          if (buf === null || buf === '' || !Number.isFinite(n)) { onCommit(value); setBuf(null); return; }
          const committed = Math.min(max, Math.max(min, Math.round(n)));
          if (committed !== n) setClamped(t('clampedNote', { min, max, value: committed }));
          onCommit(committed);
          setBuf(null);
        }} />
      {/* `aria-atomic` is load-bearing with `useLiveRegion`: the repeat mechanism
          is an invisible TRAILING marker, and without atomic some assistive tech
          reads only the changed portion — the marker alone, i.e. silence. The
          node stays CONDITIONAL because an always-mounted `<p>` would reserve its
          default block margins in the property editor; every clamp is preceded by
          a keystroke that clears the note, so the text never has to change in
          place except on the repeat this hook exists to make audible. */}
      {clamped ? <p className="muted u-fs-13" aria-live="polite" aria-atomic="true">{clamped}</p> : null}
    </>
  );
}

export function OutlineMetaWidget({ id, value, onChange, onChangeText }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('challenge-outline');
  const m = metaFrom(value);
  const setText = (patch: Partial<OutlineMeta>): void => onChangeText({ ...m, ...patch });
  const setNum = (patch: Partial<OutlineMeta>): void => onChange({ ...m, ...patch });
  const setDepth = (v: string): void => {
    const next = { ...m };
    if (v && (DEPTH_LEVELS as readonly string[]).includes(v)) next.depthLevel = v as DepthLevel;
    else delete next.depthLevel;
    onChange(next);
  };
  return (
    <div className="co-meta-widget">
      <label htmlFor={`${id}-title`} className="cv-editor__field-label">{t('meta_title')}</label>
      <input id={`${id}-title`} className="cv-editor__input" value={m.title} onChange={(e) => setText({ title: e.target.value })} />
      <label htmlFor={`${id}-promise`} className="cv-editor__field-label">{t('meta_promise')}</label>
      <textarea id={`${id}-promise`} className="cv-editor__input cv-editor__textarea" value={m.promise} onChange={(e) => setText({ promise: e.target.value })} />
      <label htmlFor={`${id}-audience`} className="cv-editor__field-label">{t('meta_audience')}</label>
      <input id={`${id}-audience`} className="cv-editor__input" value={m.audience} onChange={(e) => setText({ audience: e.target.value })} />
      <BufferedNumber id={`${id}-duration`} label={t('meta_durationDays')} value={m.durationDays}
        min={DURATION_MIN} max={DURATION_MAX} onCommit={(n) => setNum({ durationDays: n })} />
      <BufferedNumber id={`${id}-minutes`} label={t('meta_dailyMinutesBudget')} value={m.dailyMinutesBudget}
        min={MINUTES_MIN} max={MINUTES_MAX} onCommit={(n) => setNum({ dailyMinutesBudget: n })} />
      <label htmlFor={`${id}-depth`} className="cv-editor__field-label">{t('meta_depthLevel')}</label>
      <select id={`${id}-depth`} className="cv-editor__input" value={m.depthLevel ?? ''} onChange={(e) => setDepth(e.target.value)}>
        <option value="">{t('depth_unlabeled')}</option>
        {DEPTH_LEVELS.map((d) => <option key={d} value={d}>{t(`depth_${d}`)}</option>)}
      </select>
    </div>
  );
}

export function OutlineOutcomesWidget({ id, value, onChange, onChangeText }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('challenge-outline');
  const rows = outcomesFrom(value);
  const write = (next: OutlineOutcome[], text = false): void => (text ? onChangeText : onChange)(next);
  const patch = (i: number, p: Partial<OutlineOutcome>): void => write(rows.map((r, j) => (j === i ? { ...r, ...p } : r)), true);
  const add = (): void => write([...rows, { outcomeId: nextId(rows.map((r) => r.outcomeId), 'outcome'), measurableOutcome: '', method: '' }]);
  const remove = (i: number): void => write(rows.filter((_, j) => j !== i));
  return (
    <div className="co-list-widget">
      {rows.map((r, i) => (
        <div key={r.outcomeId} className="co-list-widget__row surface-card">
          <div className="action-bar co-list-widget__rowhead">
            <span className="chip chip--muted">{r.outcomeId}</span>
            <Button variant="quiet" size="sm" aria-label={t('removeOutcome')} onClick={() => remove(i)}><TrashIcon size={13} /></Button>
          </div>
          <label htmlFor={`${id}-${i}-o`} className="cv-editor__field-label">{t('outcome_measurable')}</label>
          <input id={`${id}-${i}-o`} className="cv-editor__input" value={r.measurableOutcome} onChange={(e) => patch(i, { measurableOutcome: e.target.value })} />
          <label htmlFor={`${id}-${i}-m`} className="cv-editor__field-label">{t('outcome_method')}</label>
          <input id={`${id}-${i}-m`} className="cv-editor__input" value={r.method} onChange={(e) => patch(i, { method: e.target.value })} />
        </div>
      ))}
      <Button variant="quiet" size="sm" onClick={add}><PlusIcon size={13} /> {t('addOutcome')}</Button>
    </div>
  );
}

export function OutlineAchievementsWidget({ id, value, docState, onChange, onChangeText }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('challenge-outline');
  const rows = achievementsFrom(value);
  const outcomes = outcomesFrom(docState.outcomes);
  const write = (next: OutlineAchievement[], text = false): void => (text ? onChangeText : onChange)(next);
  const patchText = (i: number, p: Partial<OutlineAchievement>): void => write(rows.map((r, j) => (j === i ? { ...r, ...p } : r)), true);
  const toggleOutcome = (i: number, outcomeId: string): void => write(rows.map((r, j) => {
    if (j !== i) return r;
    const has = r.outcomeIds.includes(outcomeId);
    return { ...r, outcomeIds: has ? r.outcomeIds.filter((o) => o !== outcomeId) : [...r.outcomeIds, outcomeId] };
  }));
  const add = (): void => write([...rows, { achievementId: nextId(rows.map((r) => r.achievementId), 'achievement'), observableEvidence: '', outcomeIds: [] }]);
  const remove = (i: number): void => write(rows.filter((_, j) => j !== i));
  return (
    <div className="co-list-widget">
      {rows.map((r, i) => (
        <div key={r.achievementId} className="co-list-widget__row surface-card">
          <div className="action-bar co-list-widget__rowhead">
            <span className="chip chip--muted">{r.achievementId}</span>
            <Button variant="quiet" size="sm" aria-label={t('removeAchievement')} onClick={() => remove(i)}><TrashIcon size={13} /></Button>
          </div>
          <label htmlFor={`${id}-${i}-e`} className="cv-editor__field-label">{t('achievement_evidence')}</label>
          <input id={`${id}-${i}-e`} className="cv-editor__input" value={r.observableEvidence} onChange={(e) => patchText(i, { observableEvidence: e.target.value })} />
          <span className="cv-editor__field-label">{t('achievement_links')}</span>
          {/* CO-G1 — an outcome can be deleted while achievements still link to
              it. This module deliberately does NOT enforce referential integrity
              (validatePlan owns that on Apply), but the checkbox list only
              renders outcomes that still EXIST, so a broken link vanished from
              the UI entirely and surfaced as a validation error later, on a
              screen that showed nothing wrong. Surfacing the dangling ids is
              the same posture as surfacing the links. */}
          {r.outcomeIds.filter((o) => !outcomes.some((x) => x.outcomeId === o)).map((o) => (
            <p key={o} className="u-fs-13 u-text-danger" role="status">
              {t('achievement_danglingLink', { id: o })}{' '}
              <Button variant="quiet" size="sm" onClick={() => toggleOutcome(i, o)}>{t('achievement_dropLink')}</Button>
            </p>
          ))}
          {outcomes.length === 0 ? (
            <p className="muted u-fs-13">{t('achievement_noOutcomes')}</p>
          ) : (
            <ul role="list" className="list-plain co-checklist">
              {outcomes.map((o) => (
                <li key={o.outcomeId}>
                  <label className="co-checklist__item">
                    <input type="checkbox" checked={r.outcomeIds.includes(o.outcomeId)} onChange={() => toggleOutcome(i, o.outcomeId)} />
                    <span>{o.measurableOutcome || o.outcomeId}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <Button variant="quiet" size="sm" onClick={add}><PlusIcon size={13} /> {t('addAchievement')}</Button>
    </div>
  );
}
