/**
 * Project Overview tab (ADR 0054 D1) — the project's charter as an editorial
 * "dossier": a serif goal lead, a status/timeline strip, and hairline-delimited
 * sections for objectives, brief, and a milestone checklist with a progress
 * meter. Read for everyone; edit for writers (a non-writer's save 403s with a
 * notice). Charter is a full-replace PATCH.
 *
 * `ui/` cohesion: surface-card / Field / TextField / SelectField / chip / Notice /
 * StateCard + the `proj-*` dossier primitives; tokens only.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUnsavedChangesWarning, useConfirmDiscardUnsaved } from '../../ui/useUnsavedChangesWarning.js';
import { formatDate, formatNumber } from '../../i18n/format.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Field, TextField, SelectField } from '../../ui/Field.js';
import { FolderIcon, PlusIcon, TrashIcon, PencilIcon, CheckIcon, FlagIcon } from '../../ui/icons/index.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { STATUS_CHIP, HEALTH_CHIP } from './ProjectViews.js';
import {
  updateCharter, CHARTER_LIMITS,
  type Project, type ProjectCharter, type ProjectStatus, type ProjectHealth, type ProjectMilestone,
} from './projectsClient.js';

const STATUS_OPTS: ProjectStatus[] = ['planning', 'active', 'paused', 'done', 'archived'];
const HEALTH_OPTS: ProjectHealth[] = ['on-track', 'at-risk', 'off-track'];

/** Persisted enum → its display-label key (kept literal so check-i18n resolves them). */
const STATUS_LABEL_KEYS: Record<ProjectStatus, string> = {
  planning: 'statusPlanning', active: 'statusActive', paused: 'statusPaused', done: 'statusDone', archived: 'statusArchived',
};
const HEALTH_LABEL_KEYS: Record<ProjectHealth, string> = {
  'on-track': 'healthOnTrack', 'at-risk': 'healthAtRisk', 'off-track': 'healthOffTrack',
};

/** ISO `YYYY-MM-DD` → a short, locale-aware display date (parsed as a local date). */
const fmtDate = (iso?: string): string => {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), { dateStyle: 'medium' });
};

/** Elapsed % between two ISO dates (clamped 0–100); null when not derivable. */
function timelinePct(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const s = Date.parse(start), e = Date.parse(end), now = Date.now();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return Math.max(0, Math.min(100, Math.round(((now - s) / (e - s)) * 100)));
}

export function ProjectOverviewTab({ project, canWrite, onSaved, onDirtyChange }: { project: Project; canWrite: boolean; onSaved: (p: Project) => void; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const ch = project.charter;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const msDone = ch?.milestones?.filter((m) => m.done).length ?? 0;
  const msTotal = ch?.milestones?.length ?? 0;
  const tPct = timelinePct(ch?.startDate, ch?.endDate);

  if (editing) return <CharterEditor project={project} onCancel={() => setEditing(false)} onSaved={(p) => { onSaved(p); setEditing(false); }} {...(onDirtyChange ? { onDirtyChange } : {})} />;

  if (!ch) {
    return (
      <>
        {error ? <Notice variant="error">{error}</Notice> : null}
        <StateCard
          icon={<FolderIcon size={22} />}
          title={t('noCharterTitle')}
          body={t('noCharterBody')}
          action={canWrite ? <Button variant="primary" size="sm" onClick={() => { setError(null); setEditing(true); }}><PlusIcon size={13} /> {t('addCharter')}</Button> : undefined}
        />
      </>
    );
  }

  return (
    <div className="surface-card u-flex u-flex-col u-gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* ── Lead: the goal + status, with a quiet edit action ── */}
      <div className="u-flex u-justify-between u-items-start u-gap-3">
        <div className="u-flex u-flex-col u-gap-2 u-minw-0">
          <span className="proj-eyebrow">{t('charterEyebrow')}</span>
          {ch.goal ? <p className="proj-lead">{ch.goal}</p> : <p className="muted u-m-0">{t('noGoalSet')}</p>}
          {(ch.status || ch.health) && (
            <div className="proj-lineup">
              {/* PROJ-UX-3 — the ONE chip mapping (ProjectViews), so a state
                  looks identical on the card and the detail it opens (§5.3). */}
              {ch.status ? <span className={`chip ${STATUS_CHIP[ch.status]}`}>{t(STATUS_LABEL_KEYS[ch.status])}</span> : null}
              {ch.health ? <span className={`chip ${HEALTH_CHIP[ch.health]}`}>{t(HEALTH_LABEL_KEYS[ch.health])}</span> : null}
            </div>
          )}
        </div>
        {canWrite ? <Button variant="secondary" size="sm" onClick={() => { setError(null); setEditing(true); }}><PencilIcon size={13} /> {t('common:edit')}</Button> : null}
      </div>

      {/* ── Timeline ── */}
      {(ch.startDate || ch.endDate) && (
        <div className="proj-section">
          <div className="u-flex u-justify-between u-items-baseline u-gap-2">
            <span className="proj-eyebrow">{t('timelineEyebrow')}</span>
            <span className="muted u-fs-12">{fmtDate(ch.startDate)} → {fmtDate(ch.endDate)}</span>
          </div>
          {tPct !== null && <div className="proj-meter" role="presentation"><div className="proj-meter__fill" style={{ width: `${tPct}%` }} /></div>}
        </div>
      )}

      {/* ── Objectives ── */}
      {ch.objectives?.length ? (
        <div className="proj-section">
          <span className="proj-eyebrow">{t('objectivesEyebrow')}</span>
          <ol className="u-m-0 u-flex u-flex-col u-gap-1 u-fs-13 proj-ol-indent">
            {ch.objectives.map((o, i) => <li key={i}>{o}</li>)}
          </ol>
        </div>
      ) : null}

      {/* ── Brief ── */}
      {ch.brief ? (
        <div className="proj-section">
          <span className="proj-eyebrow">{t('briefEyebrow')}</span>
          <p className="u-fs-13 u-m-0 u-prewrap">{ch.brief}</p>
        </div>
      ) : null}

      {/* ── Milestones ── */}
      {msTotal > 0 ? (
        <div className="proj-section">
          <div className="u-flex u-justify-between u-items-baseline u-gap-2">
            <span className="proj-eyebrow">{t('milestonesEyebrow')}</span>
            <span className="muted u-fs-12">{t('milestonesDone', { done: formatNumber(msDone), total: formatNumber(msTotal) })}</span>
          </div>
          <div className="proj-meter" role="presentation"><div className="proj-meter__fill" style={{ width: `${Math.round((msDone / msTotal) * 100)}%` }} /></div>
          {/* ADR 0608 D8 (`CPU-4`) — the done-state must be ANNOUNCED, not only
              drawn. The glyph is `aria-hidden` and the only other carrier was
              `proj-ms-title--done`, whose entire definition is
              `text-decoration: line-through` (`global.css:2704`) — so a
              screen-reader user heard every title and the "N of M done" summary and
              could map done-ness onto NONE of them, on the charter's primary
              progress read. (History worth keeping: `PROJ-UX-11` moved this from an
              inline `style={{textDecoration}}` to a class, which fixed the §10
              violation and left the a11y one untouched — a fix that made the defect
              harder to see.) `role="list"` + `aria-checked` on `role="checkbox"`-ish
              rows is the conventional shape, but these are not interactive; a
              per-row TEXT state is simpler and reads correctly everywhere. */}
          <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col" role="list">
            {(ch.milestones ?? []).map((m) => (
              <li key={m.id} className="proj-row">
                <span className="proj-row__main">
                  <span className={`proj-check ${m.done ? 'proj-check--done' : ''}`} aria-hidden="true">{m.done ? <CheckIcon size={12} /> : null}</span>
                  <span className={`u-fs-13 ${m.done ? 'proj-ms-title--done' : ''}`}>{m.title}</span>
                  <span className="sr-only">{t(m.done ? 'milestoneDone' : 'milestoneOpen')}</span>
                </span>
                {m.dueDate ? <span className="muted u-fs-12">{fmtDate(m.dueDate)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Serialize the editable charter form state for the dirty comparison —
 *  VALUE-based (a reverted edit reads clean again), never a "touched" flag. */
const charterSnapshot = (
  goal: string, status: string, health: string, startDate: string, endDate: string,
  objectives: string, brief: string, milestones: ProjectMilestone[],
): string => JSON.stringify([goal, status, health, startDate, endDate, objectives, brief,
  milestones.map((m) => [m.title, m.dueDate ?? '', m.done])]);

function CharterEditor({ project, onCancel, onSaved, onDirtyChange }: { project: Project; onCancel: () => void; onSaved: (p: Project) => void; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const c = project.charter ?? {};
  const [goal, setGoal] = useState(c.goal ?? '');
  const [status, setStatus] = useState<ProjectStatus | ''>(c.status ?? '');
  const [health, setHealth] = useState<ProjectHealth | ''>(c.health ?? '');
  const [startDate, setStartDate] = useState(c.startDate ?? '');
  const [endDate, setEndDate] = useState(c.endDate ?? '');
  const [objectives, setObjectives] = useState((c.objectives ?? []).join('\n'));
  const [brief, setBrief] = useState(c.brief ?? '');
  const [milestones, setMilestones] = useState<ProjectMilestone[]>(c.milestones ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editId = useMemo(() => Math.random().toString(36).slice(2), []); // stable-per-mount key seed

  // PROJ-UX-2 — this editor's state dies on unmount, and the always-visible tab
  // bar sits directly above it: any of 10 tab clicks — or Cancel — destroyed up
  // to an 8000-char brief + 20 objectives + 50 milestones with no prompt (the
  // FORM-UX-2 family). Guard all three exits: `beforeunload` (browser-level),
  // Cancel (confirmed below), and tab change (reported upward via
  // `onDirtyChange`; `ProjectDetailPage.setTab` intercepts).
  // Fixed at mount (state initializer — the editor full-replaces on save and unmounts).
  const [initialSnapshot] = useState(() => charterSnapshot(c.goal ?? '', c.status ?? '', c.health ?? '', c.startDate ?? '', c.endDate ?? '', (c.objectives ?? []).join('\n'), c.brief ?? '', c.milestones ?? []));
  const dirty = charterSnapshot(goal, status, health, startDate, endDate, objectives, brief, milestones) !== initialSnapshot;
  useUnsavedChangesWarning(dirty);
  const confirmDiscard = useConfirmDiscardUnsaved(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
    // On unmount the draft is gone either way — release the guard so a stale
    // dirty flag can't keep intercepting tab clicks after the editor closed.
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const onCancelGuarded = async (): Promise<void> => { if (await confirmDiscard()) onCancel(); };

  // PRJ2-M5 — what the backend would silently DROP from this form. `parseCharter`
  // truncates on a full-replace patch and answers 200, so the only place the loss
  // can still be prevented is before the write. Over-cap blocks Save and names
  // the exact overflow; the per-field caps below are enforced by `maxLength`.
  const overObjectives = objectives.split('\n').map((o) => o.trim()).filter(Boolean).length - CHARTER_LIMITS.objectives;
  const longObjectives = objectives.split('\n').filter((o) => o.trim().length > CHARTER_LIMITS.objectiveLength).length;
  const namedMilestones = milestones.filter((m) => m.title.trim()).length;
  const overMilestones = namedMilestones - CHARTER_LIMITS.milestones;
  // `maxLength` restricts TYPING; it does not shorten a value that arrived from
  // the server. A charter whose goal predates the cap (or survives a cap being
  // lowered) opens over-limit with Save enabled and is silently trimmed on
  // write — the exact defect this closes. So the length caps are checked here
  // too, and the gate covers all six rather than the three a keystroke can't
  // exceed.
  const overLength = ([
    ['capGoalLength', goal.length, CHARTER_LIMITS.goal],
    ['capBriefLength', brief.length, CHARTER_LIMITS.brief],
  ] as const).filter(([, len, max]) => len > max);
  const longMilestones = milestones.filter((m) => m.title.trim().length > CHARTER_LIMITS.milestoneTitle).length;
  const overflow = [
    // `lines`, not `count` — i18next treats `count` as the plural selector and
    // would demand `_one`/`_other` variants of every key that carries it.
    overObjectives > 0 ? t('capObjectives', { over: formatNumber(overObjectives), max: formatNumber(CHARTER_LIMITS.objectives) }) : null,
    longObjectives > 0 ? t('capObjectiveLength', { lines: formatNumber(longObjectives), max: formatNumber(CHARTER_LIMITS.objectiveLength) }) : null,
    overMilestones > 0 ? t('capMilestones', { over: formatNumber(overMilestones), max: formatNumber(CHARTER_LIMITS.milestones) }) : null,
    longMilestones > 0 ? t('capMilestoneTitleLength', { lines: formatNumber(longMilestones), max: formatNumber(CHARTER_LIMITS.milestoneTitle) }) : null,
    ...overLength.map(([key, , max]) => t(key, { max: formatNumber(max) })),
  ].filter((s): s is string => s !== null);

  const addMilestone = (): void => setMilestones((m) => [...m, { id: `${editId}-${m.length}`, title: '', done: false }]);
  const patchMilestone = (i: number, p: Partial<ProjectMilestone>): void => setMilestones((m) => m.map((x, j) => j === i ? { ...x, ...p } : x));
  const removeMilestone = (i: number): void => setMilestones((m) => m.filter((_, j) => j !== i));

  const onSave = async (): Promise<void> => {
    setBusy(true); setError(null);
    const charter: ProjectCharter = {
      ...(goal.trim() ? { goal: goal.trim() } : {}),
      ...(status ? { status } : {}),
      ...(health ? { health } : {}),
      ...(startDate.trim() ? { startDate: startDate.trim() } : {}),
      ...(endDate.trim() ? { endDate: endDate.trim() } : {}),
      ...(objectives.trim() ? { objectives: objectives.split('\n').map((o) => o.trim()).filter(Boolean) } : {}),
      ...(brief.trim() ? { brief: brief.trim() } : {}),
      ...(milestones.some((m) => m.title.trim()) ? { milestones: milestones.filter((m) => m.title.trim()).map((m) => ({ ...m, title: m.title.trim() })) } : {}),
    };
    try { onSaved(await updateCharter(project.id, Object.keys(charter).length ? charter : null)); }
    catch (e) { setError(`${t('charterSaveError')} ${loadErrorMessage(t, e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="surface-card u-flex u-flex-col u-gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* ── Definition ── */}
      <div className="proj-section">
        <span className="proj-eyebrow">{t('definitionEyebrow')}</span>
        <TextField label={t('goalLabel')} value={goal} maxLength={CHARTER_LIMITS.goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('goalPlaceholder')} help={t('goalHint', { max: formatNumber(CHARTER_LIMITS.goal) })} />
        <Field label={t('objectivesLabel')} help={t('objectivesHint', { max: formatNumber(CHARTER_LIMITS.objectives), chars: formatNumber(CHARTER_LIMITS.objectiveLength) })}>{(w) => <textarea {...w} rows={3} value={objectives} onChange={(e) => setObjectives(e.target.value)} placeholder={t('objectivesPlaceholder')} />}</Field>
        <Field label={t('briefLabel')}>{(w) => <textarea {...w} rows={4} maxLength={CHARTER_LIMITS.brief} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={t('briefPlaceholder')} />}</Field>
      </div>

      {/* ── Status & timeline ── */}
      <div className="proj-section">
        <span className="proj-eyebrow">{t('statusTimelineEyebrow')}</span>
        <div className="proj-grid proj-grid--4">
          <SelectField label={t('statusLabel')} value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | '')}>
            <option value="">—</option>{STATUS_OPTS.map((s) => <option key={s} value={s}>{t(STATUS_LABEL_KEYS[s])}</option>)}
          </SelectField>
          <SelectField label={t('healthLabel')} value={health} onChange={(e) => setHealth(e.target.value as ProjectHealth | '')}>
            <option value="">—</option>{HEALTH_OPTS.map((h) => <option key={h} value={h}>{t(HEALTH_LABEL_KEYS[h])}</option>)}
          </SelectField>
          <TextField label={t('startLabel')} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <TextField label={t('targetEndLabel')} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>

      {/* ── Milestones ── */}
      <div className="proj-section">
        <span className="proj-eyebrow">{t('milestonesEyebrow')}</span>
        {milestones.length === 0 ? (
          <p className="muted u-fs-12 u-m-0">{t('noMilestonesYet')}</p>
        ) : (
          <div className="u-flex u-flex-col u-gap-2">
            {milestones.map((m, i) => (
              <div key={m.id} className="proj-ms-edit">
                <label className="u-flex u-items-center u-gap-1 u-fs-12 muted"><input type="checkbox" checked={m.done} onChange={(e) => patchMilestone(i, { done: e.target.checked })} /> {t('doneLabel')}</label>
                <input aria-label={t('milestoneTitleAria')} maxLength={CHARTER_LIMITS.milestoneTitle} value={m.title} onChange={(e) => patchMilestone(i, { title: e.target.value })} placeholder={t('milestonePlaceholder')} />
                <input aria-label={t('milestoneDueDateAria')} type="date" value={m.dueDate ?? ''} onChange={(e) => patchMilestone(i, { dueDate: e.target.value })} />
                <Button variant="quiet" size="sm" aria-label={t('removeMilestoneAria')} onClick={() => removeMilestone(i)}><TrashIcon size={13} /></Button>
              </div>
            ))}
          </div>
        )}
        <div><Button variant="secondary" size="sm" onClick={addMilestone}><FlagIcon size={13} /> {t('addMilestone')}</Button></div>
      </div>

      {/* ── Footer ── */}
      {/* PRJ2-M5 — refuse the save rather than let the backend trim it and
          answer 200. The message names what would be lost, so the fix is
          obvious and nothing is destroyed to find out. */}
      {overflow.length > 0 ? (
        <Notice variant="warning" announce={overflow.join(' ')}>{overflow.join(' ')}</Notice>
      ) : null}

      <div className="action-bar u-gap-2 u-justify-end action-bar--divided">
        <Button variant="quiet" disabled={busy} onClick={() => void onCancelGuarded()}>{t('common:cancel')}</Button>
        <Button variant="primary" disabled={busy || overflow.length > 0} onClick={() => void onSave()}>{busy ? t('common:saving') : t('saveCharter')}</Button>
      </div>
    </div>
  );
}
