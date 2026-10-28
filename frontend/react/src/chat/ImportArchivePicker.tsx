/**
 * ImportArchivePicker (ADR 0992 D9): choose one conversation from a ChatGPT data
 * export.
 *
 * A ChatGPT export's `conversations.json` is an ARRAY of every conversation the
 * account ever had, often tens of MB. Before this, the chat sent the whole array as
 * one "openwop" import. The parser refused it and the person saw a generic
 * "Couldn't import". The list is built client-side (`listArchiveConversations`),
 * and only the chosen conversation is sent, so every request stays small.
 *
 * It is lazy-loaded by both chat surfaces, so it adds nothing to the entry chunk.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { Button } from '../ui/Button.js';
import { TextField } from '../ui/Field.js';
import type { ArchiveEntry } from '../client/chatExportClient.js';
import { formatDate } from '../i18n/format.js';

/** Rows shown at once; the filter narrows a large archive. */
const MAX_ROWS = 200;

export function ImportArchivePicker({ entries, onPick, onClose }: {
  entries: readonly ArchiveEntry[];
  onPick: (index: number) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const untitled = t('importArchiveUntitled');
  const hits = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? entries.filter((e) => (e.title || untitled).toLocaleLowerCase().includes(q)) : entries;
  }, [entries, query, untitled]);
  const shown = hits.slice(0, MAX_ROWS);
  const date = (iso: string | undefined): string => (iso ? formatDate(iso, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

  return (
    <Modal onClose={onClose} label={t('importArchiveTitle')} showClose>
      <h2 className="u-mt-0">{t('importArchiveTitle')}</h2>
      <p className="muted">{t('importArchiveHint', { count: entries.length })}</p>
      <TextField
        label={t('importArchiveFilter')}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {/* One always-mounted status region, so a filter result is announced. */}
      <p className="muted u-fs-12" role="status">
        {hits.length === 0 ? t('importArchiveNoMatch') : t('importArchiveMatches', { count: hits.length })}
      </p>
      {shown.length > 0 && (
        <ul className="import-archive-list">
          {shown.map((e) => (
            <li key={e.index}>
              <button type="button" className="import-archive-row" onClick={() => onPick(e.index)}>
                <span className="import-archive-title">{e.title || untitled}</span>
                <span className="muted u-fs-12">
                  {[date(e.createdAt), t('importArchiveMessages', { count: e.messageCount })].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hits.length > MAX_ROWS && (
        <p className="muted u-fs-12">{t('importArchiveMore', { count: MAX_ROWS })}</p>
      )}
      <div className="u-flex u-justify-end u-mt-3">
        <Button variant="quiet" onClick={onClose}>{t('importArchiveCancel')}</Button>
      </div>
    </Modal>
  );
}
