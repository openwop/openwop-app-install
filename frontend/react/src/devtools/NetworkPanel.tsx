/**
 * Slide-out network inspector. Toggleable from the header so users
 * can see the actual REST + SSE wire-shape behind the AI chat,
 * builder runs, keys management — every backend call the app makes.
 *
 * Renders the `networkRecorder` buffer as a Chrome-DevTools-style
 * list with a row per request and an inline expansion showing
 * request body, response body, and (for SSE) the received event
 * timeline.
 */

import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  clearNetworkEntries,
  subscribeNetworkEntries,
  type NetworkEntry,
} from './networkRecorder.js';
import { formatNumber, formatTime } from '../i18n/format.js';
import { XIcon } from '../ui/icons/index.js';

type FilterKind = 'all' | 'rest' | 'sse' | 'errors';

interface Props {
  open: boolean;
  onClose(): void;
}

/** DTU-2 — how long a burst must settle before the polite status re-announces. */
const CAPTURE_STATUS_MS = 1500;

export function NetworkPanel({ open, onClose }: Props): JSX.Element | null {
  const { t } = useTranslation('devtools');
  const [entries, setEntries] = useState<readonly NetworkEntry[]>([]);
  const [filter, setFilter] = useState<FilterKind>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    return subscribeNetworkEntries(setEntries);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter === 'rest' && e.kind !== 'rest') return false;
      if (filter === 'sse' && e.kind !== 'sse') return false;
      if (filter === 'errors' && (e.ok === true || e.error === undefined && (e.status ?? 0) < 400)) return false;
      if (q && !`${e.method} ${e.path} ${e.status ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, search]);

  // DTU-2 — throttle the announced count so a burst of captures produces ONE
  // announcement, not twenty. `null` until the first tick so an empty panel
  // announces nothing at all (a live region that renders WITH content announces
  // nothing anyway — the value must CHANGE, which is what this effect gives it).
  const [announcedCount, setAnnouncedCount] = useState<number | null>(null);
  useEffect(() => {
    if (!open) { setAnnouncedCount(null); return; }
    const id = setTimeout(() => setAnnouncedCount(entries.length), CAPTURE_STATUS_MS);
    return () => clearTimeout(id);
  }, [open, entries.length]);

  if (!open) return null;

  const counts = {
    total: entries.length,
    rest: entries.filter((e) => e.kind === 'rest').length,
    sse: entries.filter((e) => e.kind === 'sse').length,
    errors: entries.filter((e) => e.ok === false || e.error !== undefined).length,
  };

  return (
    // ui/Modal composition (XC-7): inherits trap/Escape/restore/aria-modal.
    <Modal
      onClose={onClose}
      label={t('inspectorLabel')}
      scrimClassName="netpanel-backdrop"
      className="netpanel"
    >
      <>
        <header className="netpanel-head">
          <div className="netpanel-head-title">
            <strong>{t('network')}</strong>
            <span className="muted">{t('callCount', { count: counts.total })}</span>
            {/* DTU-2 — perception of a STREAMING list without a firehose. The filed row
                asked for `aria-live` on the capture list itself; that would announce every
                captured request, which on a network inspector is hostile (a single page
                load is 20+ calls). A screen-reader user needs to know activity is
                happening, not to hear each entry — so this is a THROTTLED polite summary
                (at most one announcement per `CAPTURE_STATUS_MS`), and the list stays
                silent. */}
            <span className="visually-hidden" role="status">
              {announcedCount === null ? '' : t('captureStatus', { count: announcedCount })}
            </span>
          </div>
          <div className="netpanel-head-actions">
            <Button variant="secondary" onClick={clearNetworkEntries} title={t('clearTitle')}>
              {t('clear')}
            </Button>
            <Button variant="secondary" onClick={onClose} aria-label={t('closePanel')}>
              <XIcon size={14} />
            </Button>
          </div>
        </header>

        <div className="netpanel-toolbar">
          <select aria-label={t('filterKindLabel')} value={filter} onChange={(e) => setFilter(e.target.value as FilterKind)}>
            <option value="all">{t('filterAll', { count: counts.total })}</option>
            <option value="rest">{t('filterRest', { count: counts.rest })}</option>
            <option value="sse">{t('filterSse', { count: counts.sse })}</option>
            <option value="errors">{t('filterErrors', { count: counts.errors })}</option>
          </select>
          <input
            type="search"
            aria-label={t('filterByPath')}
            placeholder={t('filterByPath')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* DTU-1 — column context. The list is a CSS-grid of disclosure buttons, not a
            table, and labelling it `role="table"` would promise row/column navigation the
            markup does not implement. Sighted users get a real header strip; screen-reader
            users get the same context from each row's composed `aria-label` (below), which
            is what the missing column headers actually cost them. */}
        {filtered.length > 0 && (
          <div className="netpanel-cols" aria-hidden="true">
            <span>{t('colMethod')}</span>
            <span>{t('colStatus')}</span>
            <span>{t('colPath')}</span>
            <span>{t('colDuration')}</span>
          </div>
        )}

        <div className="netpanel-list">
          {filtered.length === 0 ? (
            <p className="muted netpanel-empty">
              {entries.length === 0
                ? t('noActivity')
                : t('noMatch')}
            </p>
          ) : (
            filtered.slice().reverse().map((e) => (
              <NetworkRow
                key={e.id}
                entry={e}
                expanded={expandedId === e.id}
                onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
              />
            ))
          )}
        </div>

        <footer className="netpanel-foot muted">
          {t('bufferNote')}
        </footer>
      </>
    </Modal>
  );
}

function NetworkRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: NetworkEntry;
  expanded: boolean;
  onToggle(): void;
}): JSX.Element {
  const { t } = useTranslation('devtools');
  const statusCls = entry.error
    ? 'netpanel-row-status-err'
    : entry.ok === false
      ? 'netpanel-row-status-warn'
      : entry.ok === true
        ? 'netpanel-row-status-ok'
        : 'netpanel-row-status-pending';
  return (
    <div className={`netpanel-row ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="netpanel-row-head"
        onClick={onToggle}
        aria-expanded={expanded}
        // DTU-1 — without this the accessible name is the bare concatenation
        // "GET 200 /api/foo 34ms" with no field context, and a pending row reads as a
        // lone ellipsis. Naming the fields is what the absent column headers owed.
        aria-label={t('rowLabel', {
          method: entry.method,
          status: entry.error ? t('errShort') : entry.status ?? t('statusPending'),
          path: entry.path,
          duration: entry.durationMs !== undefined
            ? formatNumber(entry.durationMs, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' })
            : entry.unfinishedAtReload ? t('durationUnknownReload') : t('durationPending'),
        })}
      >
        <span className="netpanel-row-method">{entry.method}</span>
        <span className={`netpanel-row-status ${statusCls}`}>
          {entry.error ? t('errShort') : entry.status ?? '…'}
        </span>
        <span className="netpanel-row-path" title={entry.url}>{entry.path}</span>
        <span className="netpanel-row-meta">
          {entry.kind === 'sse' && <span className="netpanel-row-sse">SSE</span>}
          {entry.durationMs !== undefined
            ? formatNumber(entry.durationMs, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' })
            : entry.unfinishedAtReload ? '—' : '…'}
        </span>
      </button>
      {expanded && (
        <div className="netpanel-row-body">
          {entry.error && (
            <div className="u-mb-1-5"><Notice variant="error">{entry.error}</Notice></div>
          )}
          <Field label={t('urlLabel')} value={entry.url} mono />
          <Field
            label={t('startedLabel')}
            value={formatTime(entry.startedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          />
          {entry.requestBody && <Field label={t('requestBodyLabel')} value={prettyJson(entry.requestBody)} mono multiline />}
          {entry.responseBody && (
            <Field
              label={entry.responseTruncated ? t('responseBodyTruncatedLabel') : t('responseBodyLabel')}
              value={prettyJson(entry.responseBody)}
              mono
              multiline
            />
          )}
          {entry.sseEvents && entry.sseEvents.length > 0 && (
            <div className="netpanel-field">
              <div className="netpanel-field-label">
                {entry.sseEventsDropped
                  ? t('sseEventsSavedLabel', { count: entry.sseEvents.length, total: entry.sseEvents.length + entry.sseEventsDropped })
                  : t(entry.sseEventsTruncated ? 'sseEventsTruncatedLabel' : 'sseEventsLabel', { count: entry.sseEvents.length })}
              </div>
              <ol className="netpanel-sse-list">
                {entry.sseEvents.map((ev, i) => (
                  <li key={i}>
                    <span className="netpanel-sse-at">
                      +{formatNumber(ev.at - entry.startedAt, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' })}
                    </span>
                    <code>{ev.data.slice(0, 200)}{ev.data.length > 200 ? '…' : ''}</code>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono, multiline }: { label: string; value: string; mono?: boolean; multiline?: boolean }): JSX.Element {
  return (
    <div className="netpanel-field">
      <div className="netpanel-field-label">{label}</div>
      {multiline ? (
        <pre className={`netpanel-field-value ${mono ? 'is-mono' : ''}`}>{value}</pre>
      ) : (
        <div className={`netpanel-field-value ${mono ? 'is-mono' : ''}`}>{value}</div>
      )}
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
