/**
 * Coach console (ADR 0501, console) — the coach's desk over the EXISTING
 * accountability seams: the caseload (`GET /kicktodo/coach/caseload`), the dry
 * run (`POST /circles/:id/proposals/dry-run`) and propose
 * (`POST /circles/:id/proposals`). No new backend concept, no wire.
 *
 * Honesty devices, in order:
 *  - the coach PROPOSES, the participant DECIDES on their card — every action here
 *    says so and nothing here mutates a plan;
 *  - the composer offers only the lanes a coach can actually fill (`schedule`,
 *    `recovery`, `move`); `substitute` needs activity ids the participant sees and
 *    the coach does not, so the composer says that and points to the note;
 *  - the preview shows what the PARTICIPANT will read (server-humanized lines),
 *    never the participant's plan — that stays owner-only by design;
 *  - a refused command (off-lane, more than five) is shown with the server's
 *    message, never swallowed into a generic error.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextareaField, SelectField, TextField } from '../../ui/Field.js';
import { UserIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import {
  getCaseload,
  dryRunProposal,
  createProposal,
  type CaseloadRow,
  type RevisionCommand,
} from '../../client/kicktodoCirclesClient.js';

const MAX_COMMANDS = 5;
type Lane = 'schedule' | 'recovery' | 'move';
type Draft = { lane: Lane; daypart: 'morning' | 'afternoon' | 'evening' | 'clear'; day: string; toDate: string };

const blankDraft = (): Draft => ({ lane: 'schedule', daypart: 'morning', day: '1', toDate: '' });

/** The closed-world command the server validates, from one composer row. */
function toCommand(d: Draft): RevisionCommand {
  switch (d.lane) {
    case 'schedule': return { lane: 'schedule', daypart: d.daypart === 'clear' ? null : d.daypart };
    case 'recovery': return { lane: 'recovery' };
    case 'move': return { lane: 'move', day: Number(d.day), toDate: d.toDate };
  }
}

export function CoachConsolePage() {
  const { t } = useTranslation('kicktodo-circles');
  const [rows, setRows] = useState<CaseloadRow[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setError(false);
      setRows(await getCaseload());
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const current = useMemo(() => rows?.find((r) => r.circleId === selected) ?? null, [rows, selected]);

  const select = (circleId: string) => {
    setSelected(circleId);
    setNote(''); setDrafts([]); setPreview(null); setPreviewError(null); setSendError(null); setSent(false);
  };

  const onPreview = async () => {
    if (!current) return;
    setBusy(true); setPreviewError(null); setPreview(null);
    try {
      const out = await dryRunProposal(current.circleId, drafts.map(toCommand));
      setPreview(out.lines);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSend = async () => {
    if (!current || !note.trim()) return;
    setBusy(true); setSendError(null); setSent(false);
    try {
      await createProposal(current.circleId, note.trim(), drafts.length > 0 ? drafts.map(toCommand) : undefined);
      setSent(true);
      setNote(''); setDrafts([]); setPreview(null);
      await reload();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: DataColumn<CaseloadRow>[] = [
    { key: 'circle', header: t('coachColParticipant'), render: (r) => <strong>{r.circleName}</strong>, sortValue: (r) => r.circleName },
    {
      key: 'progress', header: t('coachColProgress'),
      render: (r) => r.summary
        ? <span>{t('coachDayOf', { day: r.summary.currentDay, total: r.summary.durationDays })} · {t('coachCompleted', { done: r.summary.completedActivities, total: r.summary.totalRequiredActivities })}</span>
        : <span className="muted">{t('coachNoProgressYet')}</span>,
      sortValue: (r) => r.summary ? r.summary.currentDay : null,
    },
    {
      key: 'status', header: t('coachColStatus'),
      render: (r) => <span className={r.flagged ? 'chip chip--warning' : 'chip chip--success'}>{r.flagged ? t('coachFlagged') : t('coachOnTrack')}</span>,
      sortValue: (r) => (r.flagged ? 1 : 0),
    },
    { key: 'proposals', header: t('coachColProposals'), render: (r) => <span>{r.proposals.length}</span>, sortValue: (r) => r.proposals.length, align: 'right' },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('coachTitle')}
        lede={t('coachLede')}
        actions={<Link className="btn-ghost btn-sm" to="/circles">{t('coachBackToCircles')}</Link>}
      />
      {error && <Notice variant="error" announce={t('coachLoadError')}>{t('coachLoadError')}</Notice>}
      {!error && rows === null && <StateCard loading title={t('coachTitle')} />}
      {!error && rows !== null && rows.length === 0 && (
        <StateCard icon={<UserIcon />} title={t('coachEmptyTitle')} body={t('coachEmptyBody')} />
      )}
      {!error && rows !== null && rows.length > 0 && (
        <DataTable<CaseloadRow>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.circleId}
          onRowClick={(r) => select(r.circleId)}
          caption={t('coachTitle')}
          rowClassName={(r) => (r.circleId === selected ? 'is-selected' : '')}
        />
      )}

      {current && (
        <section className="surface-card" aria-label={t('coachComposeFor', { circle: current.circleName })}>
          <h2 className="u-fs-13 muted">{t('coachComposeFor', { circle: current.circleName })}</h2>

          {current.proposals.length > 0 ? (
            <ul className="list-plain">
              {current.proposals.map((p) => (
                <li key={p.id} className="list-row">
                  <span className={p.state === 'applied' ? 'chip chip--success' : p.state === 'dismissed' ? 'chip chip--muted' : 'chip'}>
                    {p.state === 'applied' ? t('coachStateApplied') : p.state === 'dismissed' ? t('coachStateDismissed') : t('coachStateProposed')}
                  </span>
                  <span className="chip chip--muted">{p.hasCommands ? t('coachExecutable') : t('coachAdviceOnly')}</span>
                  <span>{p.note}</span>
                  <span className="muted u-fs-13">{formatDate(p.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted u-fs-13">{t('coachNoProposalsYet')}</p>
          )}

          <TextareaField
            label={t('coachNoteLabel')}
            help={t('coachNoteHelp')}
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />

          <h3 className="u-fs-13 muted">{t('coachCommandsHeading')}</h3>
          {drafts.map((d, i) => (
            <div key={i} className="action-bar">
              <SelectField
                label={t('coachCommandsHeading')}
                value={d.lane}
                onChange={(e) => setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, lane: e.target.value as Lane } : x)))}
              >
                <option value="schedule">{t('coachLaneSchedule')}</option>
                <option value="recovery">{t('coachLaneRecovery')}</option>
                <option value="move">{t('coachLaneMove')}</option>
              </SelectField>
              {d.lane === 'schedule' && (
                <SelectField
                  label={t('coachLaneSchedule')}
                  value={d.daypart}
                  onChange={(e) => setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, daypart: e.target.value as Draft['daypart'] } : x)))}
                >
                  <option value="morning">{t('coachDaypartMorning')}</option>
                  <option value="afternoon">{t('coachDaypartAfternoon')}</option>
                  <option value="evening">{t('coachDaypartEvening')}</option>
                  <option value="clear">{t('coachDaypartClear')}</option>
                </SelectField>
              )}
              {d.lane === 'move' && (
                <>
                  <TextField label={t('coachMoveDay')} type="number" min={1} value={d.day}
                    onChange={(e) => setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, day: e.target.value } : x)))} />
                  <TextField label={t('coachMoveToDate')} type="date" value={d.toDate}
                    onChange={(e) => setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, toDate: e.target.value } : x)))} />
                </>
              )}
              <Button variant="quiet" size="sm" onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}>{t('coachRemoveCommand')}</Button>
            </div>
          ))}
          <div className="action-bar">
            <Button variant="quiet" size="sm" disabled={drafts.length >= MAX_COMMANDS} onClick={() => setDrafts((ds) => [...ds, blankDraft()])}>
              {t('coachAddCommand')}
            </Button>
            {drafts.length >= MAX_COMMANDS && <span className="muted u-fs-13">{t('coachMaxCommands')}</span>}
          </div>
          <p className="muted u-fs-13">{t('coachSubstituteNote')}</p>

          <div className="action-bar">
            <Button variant="quiet" size="sm" disabled={busy || drafts.length === 0} onClick={() => void onPreview()}>{t('coachPreviewCta')}</Button>
            <Button size="sm" disabled={busy || !note.trim()} onClick={() => void onSend()}>{t('coachSendCta')}</Button>
          </div>
          {previewError && <Notice variant="error" announce={t('coachPreviewError', { message: previewError })}>{t('coachPreviewError', { message: previewError })}</Notice>}
          {preview && (
            <div>
              <h3 className="u-fs-13 muted">{t('coachPreviewHeading')}</h3>
              <ul className="list-plain">{preview.map((line, i) => <li key={i}>{line}</li>)}</ul>
            </div>
          )}
          {sendError && <Notice variant="error" announce={t('coachSendError', { message: sendError })}>{t('coachSendError', { message: sendError })}</Notice>}
          {sent && <Notice variant="success" announce={t('coachSent')}>{t('coachSent')}</Notice>}
        </section>
      )}
    </div>
  );
}
