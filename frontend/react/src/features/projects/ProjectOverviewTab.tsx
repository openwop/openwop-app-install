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
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../../i18n/format.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Field, TextField, SelectField } from '../../ui/Field.js';
import { FolderIcon, PlusIcon, TrashIcon, PencilIcon, CheckIcon, FlagIcon } from '../../ui/icons/index.js';
import {
  updateCharter, type Project, type ProjectCharter, type ProjectStatus, type ProjectHealth, type ProjectMilestone,
} from './projectsClient.js';

const STATUS_OPTS: ProjectStatus[] = ['planning', 'active', 'paused', 'done', 'archived'];
const HEALTH_OPTS: ProjectHealth[] = ['on-track', 'at-risk', 'off-track'];
const healthChip = (h?: ProjectHealth): string => h === 'on-track' ? 'chip--success' : h === 'at-risk' ? 'chip--warning' : h === 'off-track' ? 'chip--danger' : 'chip--muted';
const statusChip = (s?: ProjectStatus): string => s === 'active' ? 'chip--accent' : s === 'done' ? 'chip--success' : s === 'archived' ? 'chip--muted' : 'chip--muted';

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

export function ProjectOverviewTab({ project, canWrite, onSaved }: { project: Project; canWrite: boolean; onSaved: (p: Project) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const ch = project.charter;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const msDone = ch?.milestones?.filter((m) => m.done).length ?? 0;
  const msTotal = ch?.milestones?.length ?? 0;
  const tPct = timelinePct(ch?.startDate, ch?.endDate);

  if (editing) return <CharterEditor project={project} onCancel={() => setEditing(false)} onSaved={(p) => { onSaved(p); setEditing(false); }} />;

  if (!ch) {
    return (
      <>
        {error ? <Notice variant="error">{error}</Notice> : null}
        <StateCard
          icon={<FolderIcon size={22} />}
          title={t('noCharterTitle')}
          body={t('noCharterBody')}
          action={canWrite ? <button type="button" className="primary btn-sm" onClick={() => { setError(null); setEditing(true); }}><PlusIcon size={13} /> {t('addCharter')}</button> : undefined}
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
              {ch.status ? <span className={`chip ${statusChip(ch.status)}`}>{t(STATUS_LABEL_KEYS[ch.status])}</span> : null}
              {ch.health ? <span className={`chip ${healthChip(ch.health)}`}>{t(HEALTH_LABEL_KEYS[ch.health])}</span> : null}
            </div>
          )}
        </div>
        {canWrite ? <button type="button" className="secondary btn-sm" onClick={() => { setError(null); setEditing(true); }}><PencilIcon size={13} /> {t('common:edit')}</button> : null}
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
          <ol className="u-m-0 u-flex u-flex-col u-gap-1 u-fs-13" style={{ paddingInlineStart: 'var(--space-4)' }}>
            {ch.objectives.map((o, i) => <li key={i}>{o}</li>)}
          </ol>
        </div>
      ) : null}

      {/* ── Brief ── */}
      {ch.brief ? (
        <div className="proj-section">
          <span className="proj-eyebrow">{t('briefEyebrow')}</span>
          <p className="u-fs-13 u-m-0" style={{ whiteSpace: 'pre-wrap' }}>{ch.brief}</p>
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
          <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col">
            {(ch.milestones ?? []).map((m) => (
              <li key={m.id} className="proj-row">
                <span className="proj-row__main">
                  <span className={`proj-check ${m.done ? 'proj-check--done' : ''}`} aria-hidden="true">{m.done ? <CheckIcon size={12} /> : null}</span>
                  <span className="u-fs-13" style={{ textDecoration: m.done ? 'line-through' : 'none' }}>{m.title}</span>
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

function CharterEditor({ project, onCancel, onSaved }: { project: Project; onCancel: () => void; onSaved: (p: Project) => void }): JSX.Element {
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
    catch (e) { setError(e instanceof Error ? e.message : t('charterSaveError')); }
    finally { setBusy(false); }
  };

  return (
    <div className="surface-card u-flex u-flex-col u-gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* ── Definition ── */}
      <div className="proj-section">
        <span className="proj-eyebrow">{t('definitionEyebrow')}</span>
        <TextField label={t('goalLabel')} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('goalPlaceholder')} />
        <Field label={t('objectivesLabel')}>{(w) => <textarea {...w} rows={3} value={objectives} onChange={(e) => setObjectives(e.target.value)} placeholder={t('objectivesPlaceholder')} />}</Field>
        <Field label={t('briefLabel')}>{(w) => <textarea {...w} rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={t('briefPlaceholder')} />}</Field>
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
                <input aria-label={t('milestoneTitleAria')} value={m.title} onChange={(e) => patchMilestone(i, { title: e.target.value })} placeholder={t('milestonePlaceholder')} />
                <input aria-label={t('milestoneDueDateAria')} type="date" value={m.dueDate ?? ''} onChange={(e) => patchMilestone(i, { dueDate: e.target.value })} />
                <button type="button" className="ghost btn-sm" aria-label={t('removeMilestoneAria')} onClick={() => removeMilestone(i)}><TrashIcon size={13} /></button>
              </div>
            ))}
          </div>
        )}
        <div><button type="button" className="secondary btn-sm" onClick={addMilestone}><FlagIcon size={13} /> {t('addMilestone')}</button></div>
      </div>

      {/* ── Footer ── */}
      <div className="action-bar u-gap-2 u-justify-end" style={{ borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-3)' }}>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>{t('common:cancel')}</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void onSave()}>{busy ? t('common:saving') : t('saveCharter')}</button>
      </div>
    </div>
  );
}
