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

  if (!open) return null;

  const counts = {
    total: entries.length,
    rest: entries.filter((e) => e.kind === 'rest').length,
    sse: entries.filter((e) => e.kind === 'sse').length,
    errors: entries.filter((e) => e.ok === false || e.error !== undefined).length,
  };

  return (
    <>
      <div className="netpanel-backdrop" onClick={onClose} role="presentation" />
      <aside
        className="netpanel"
        role="dialog"
        aria-modal="true"
        aria-label={t('inspectorLabel')}
      >
        <header className="netpanel-head">
          <div className="netpanel-head-title">
            <strong>{t('network')}</strong>
            <span className="muted">{t('callCount', { count: counts.total })}</span>
          </div>
          <div className="netpanel-head-actions">
            <button className="secondary" onClick={clearNetworkEntries} title={t('clearTitle')}>
              {t('clear')}
            </button>
            <button className="secondary" onClick={onClose} aria-label={t('closePanel')}>
              <XIcon size={14} />
            </button>
          </div>
        </header>

        <div className="netpanel-toolbar">
          <select value={filter} onChange={(e) => setFilter(e.target.value as FilterKind)}>
            <option value="all">{t('filterAll', { count: counts.total })}</option>
            <option value="rest">{t('filterRest', { count: counts.rest })}</option>
            <option value="sse">{t('filterSse', { count: counts.sse })}</option>
            <option value="errors">{t('filterErrors', { count: counts.errors })}</option>
          </select>
          <input
            type="search"
            placeholder={t('filterByPath')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

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
      </aside>
    </>
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
            : '…'}
        </span>
      </button>
      {expanded && (
        <div className="netpanel-row-body">
          {entry.error && (
            <div className="alert error u-mb-1-5">{entry.error}</div>
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
              <div className="netpanel-field-label">{t('sseEventsLabel', { count: entry.sseEvents.length })}</div>
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
