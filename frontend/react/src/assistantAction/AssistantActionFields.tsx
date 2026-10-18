/**
 * ADR 0862 D3 — the fields an approver MUST see on an assistant action card.
 *
 * ADR 0662 D1 made the server project, per kind, every field the executor consumes
 * (`CARD_FIELDS`: the email `subject`, the invite's `event` body, the reschedule
 * `patch`, the ticket id). Both inbox cards rendered only `payload.to`, so a human
 * still approved a calendar invite without seeing its time, guests or place — the
 * defect 0662 opened with, surviving in the UI.
 *
 * ONE renderer, driven by whatever the projector sent (never a SPA copy of
 * `CARD_FIELDS` — a second list is the drift this exists to end), shared by the two
 * inbox cards and `ReviewCard`. Known keys get a label; an unknown key still renders
 * under its raw name, because hiding a field the executor will send is the defect.
 *
 * TEXT ONLY. Every value is provider- or model-derived (untrusted); nothing here
 * becomes an `href` — not `location`, not `htmlLink`, not a conference URI.
 *
 * Lazy by design: consumers `lazy(() => import(...))` it. The caller's Suspense
 * boundary includes its decision controls, so loading fields or their namespace
 * cannot leave a live Approve button beside an incomplete card.
 */
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MetadataRow } from '../ui/index.js';
import { formatDateTime, formatDate } from '../i18n/format.js';

type Payload = Record<string, unknown>;

const SCALAR_LABELS: Record<string, string> = { to: 'to', subject: 'subject', eventId: 'event', ticketId: 'ticket', replyChannel: 'replyVia' };
/** ADR 0878 (SD2UX-2) — a support reply's destination, in words; `none` says that
 *  approving sends nothing. */
const REPLY_VIA: Record<string, string> = { whatsapp: 'replyViaWhatsapp', widget: 'replyViaWidget', none: 'replyViaNone' };
const EVENT_LABELS: Record<string, string> = {
  summary: 'title', start: 'starts', end: 'ends', attendees: 'guests', location: 'location', description: 'details',
};
const PATCH_LABELS: Record<string, string> = { ...EVENT_LABELS, start: 'newStart', end: 'newEnd' };

function text(v: unknown): string {
  if (typeof v === 'string') return v || '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

/** Keep the familiar display without hiding any other provider-sent fields.
 * `optional` guests and an explicit `timeZone` affect the approved request;
 * unknown fields must remain visible too, even when their value clears data. */
function withExtras(label: string, record: Payload, displayedKey: string): string {
  const extras = Object.fromEntries(Object.entries(record).filter(([k, v]) => k !== displayedKey && v !== undefined));
  return Object.keys(extras).length ? `${label} · ${text(extras)}` : label;
}

function Fields({ payload }: { payload: Payload }): JSX.Element | null {
  const { t } = useTranslation('assistantAction');

  // Google Calendar time: `{dateTime}` (a moment) or `{date}` (an all-day CALENDAR date).
  // A calendar date is not a moment: `new Date('2026-10-09')` is UTC midnight, which every
  // negative-offset viewer would read as the 8th, so it is formatted IN UTC. And Google's
  // all-day `end.date` is EXCLUSIVE (a one-day event on the 9th ends on the 10th), so the
  // end is shown as the last day it covers — an approver must never see a wrong date.
  const when = (v: unknown, isEnd: boolean): string => {
    if (v && typeof v === 'object') {
      const o = v as Payload;
      if (typeof o.dateTime === 'string') {
        // Without an offset Google interprets the wall time in `timeZone`, not
        // the browser's zone. Keep that supplied time literal rather than invent
        // a different moment; an offset-bearing timestamp can be formatted.
        const label = /(?:Z|[+-]\d{2}:\d{2})$/i.test(o.dateTime) && Number.isFinite(Date.parse(o.dateTime))
          ? `${formatDateTime(o.dateTime)} (${o.dateTime})` : text(o.dateTime);
        return withExtras(label, o, 'dateTime');
      }
      if (typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) {
        const ms = Date.parse(`${o.date}T00:00:00Z`) - (isEnd ? 86_400_000 : 0);
        return withExtras(t('allDay', { date: formatDate(ms, { dateStyle: 'medium', timeZone: 'UTC' }) }), o, 'date');
      }
    }
    return text(v);
  };
  const people = (v: unknown): string => (Array.isArray(v)
    ? (v.length ? v.map((p) => (p && typeof p === 'object' && !Array.isArray(p) && (p as Payload).email !== undefined
      ? withExtras(text((p as Payload).email), p as Payload, 'email') : text(p))).join(', ') : '[]')
    : text(v));

  const rows: Array<{ key: string; label: string; value: string }> = [];
  const nested = (obj: unknown, labels: Record<string, string>, prefix: string): void => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { rows.push({ key: prefix, label: prefix, value: text(obj) }); return; }
    const entries = Object.entries(obj as Payload).filter(([, v]) => v !== undefined);
    if (entries.length === 0) { rows.push({ key: prefix, label: prefix, value: '{}' }); return; }
    for (const [k, v] of entries) {
      const value = k === 'start' || k === 'end' ? when(v, k === 'end') : k === 'attendees' ? people(v) : text(v);
      rows.push({ key: `${prefix}.${k}`, label: labels[k] ? t(labels[k]!) : k, value });
    }
  };
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    if (k === 'event') nested(v, EVENT_LABELS, k);
    else if (k === 'patch') nested(v, PATCH_LABELS, k);
    else if (k === 'replyChannel' && typeof v === 'string' && REPLY_VIA[v]) rows.push({ key: k, label: t('replyVia'), value: t(REPLY_VIA[v]!) });
    else rows.push({ key: k, label: SCALAR_LABELS[k] ? t(SCALAR_LABELS[k]!) : k, value: k === 'to' ? people(v) : text(v) });
  }
  if (rows.length === 0) return null;
  return (
    <div className="u-grid u-gap-1" role="group" aria-label={t('fieldsLabel')}>
      {rows.map((r) => <MetadataRow key={r.key} label={r.label}>{r.value}</MetadataRow>)}
    </div>
  );
}

export default function AssistantActionFields({ payload }: { payload: Payload | undefined }): JSX.Element | null {
  if (!payload) return null;
  return <Fields payload={payload} />;
}

function ReviewLinkInner({ approvalId }: { approvalId: string }): JSX.Element {
  const { t } = useTranslation('assistantAction');
  return (
    <Link className="btn btn-sm" to={`/inbox?approval=${encodeURIComponent(approvalId)}`} title={t('reviewInInboxHint')}>
      {t('reviewInInbox')}
    </Link>
  );
}

/** ADR 0862 (architect B1) — the agent drawer is too narrow to show what an approver must
 *  see, so for an assistant action it links to the inbox card instead of a blind Approve. */
export function ReviewInInboxLink({ approvalId }: { approvalId: string }): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ReviewLinkInner approvalId={approvalId} />
    </Suspense>
  );
}
