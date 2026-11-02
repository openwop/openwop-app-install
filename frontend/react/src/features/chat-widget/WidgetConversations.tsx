/**
 * ADR 1018 D3 — what visitors asked one widget, and what it answered.
 *
 * A READ-ONLY record, not a chat panel: no composer, and the operator cannot reply
 * from here (CLAUDE.md "one AI chat"). Visitor text is attacker-controlled, so every
 * message renders as plain React text — no markdown renderer, no
 * `dangerouslySetInnerHTML`. Threads expire 7 days after their last message; the
 * operator can delete one sooner when a visitor asks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { formatDateTime, formatRelativeTime } from '../../i18n/format.js';
import { deleteConversation, getConversation, listConversations, type Conversation, type ConversationSummary, type Widget } from '../../client/chatWidgetClient.js';

interface Props { orgId: string; widget: Widget; onClose: () => void }

export function WidgetConversations({ orgId, widget, onClose }: Props): JSX.Element {
  const { t } = useTranslation('chat-widget');
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const transcriptRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(() => {
    setRows(null); setError(null);
    // grade-code CW68C-12 — a viewer is refused (workspace:write); say so, not "could not load".
    void listConversations(orgId, widget.widgetId).then(setRows).catch((err: unknown) => setError(t(err instanceof Error && err.message.startsWith('forbidden') ? 'conversationsForbidden' : 'conversationsLoadError')));
  }, [orgId, widget.widgetId, t]);
  useEffect(() => { load(); setOpen(null); }, [load]);
  useEffect(() => { headingRef.current?.focus(); }, [widget.widgetId]);
  useEffect(() => { if (open) transcriptRef.current?.focus(); }, [open]);

  const onOpen = useCallback(async (threadId: string) => {
    setOpening(threadId); setError(null);
    try { setOpen(await getConversation(orgId, widget.widgetId, threadId)); }
    catch { setError(t('conversationsLoadError')); }
    finally { setOpening(null); }
  }, [orgId, widget.widgetId, t]);

  const onDelete = useCallback(async (threadId: string) => {
    if (!(await confirm({ title: t('conversationDeleteTitle'), body: t('conversationDeleteBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteConversation(orgId, widget.widgetId, threadId);
      toast.success(t('conversationDeleted'));
      setOpen((o) => (o?.threadId === threadId ? null : o));
      load();
    } catch { setError(t('conversationDeleteError')); }
  }, [orgId, widget.widgetId, load, t]);

  return (
    <section className="surface-card u-p-3 u-mt-2" aria-label={t('conversationsAria', { agent: widget.agentId })}>
      <div className="u-flex u-items-center u-justify-between u-mb-1">
        <h2 ref={headingRef} tabIndex={-1} className="u-fs-12 u-fw-600">{t('conversationsTitle', { agent: widget.agentId })}</h2>
        <Button variant="quiet" size="sm" onClick={onClose}>{t('common:close')}</Button>
      </div>
      <p className="muted u-fs-11 u-mb-2">{t('conversationsHint')}</p>
      <div className="u-flex u-gap-1 u-mb-2">
        <Button variant="secondary" size="sm" onClick={load}>{t('conversationsRefresh')}</Button>
        {rows && rows.length >= 50 ? <span className="muted u-fs-11">{t('conversationsLatest50')}</span> : null}
      </div>
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      {rows === null && !error ? (
        <SkeletonRows rows={3} columns={['1fr', '160px', '160px']} />
      ) : rows && rows.length === 0 ? (
        <StateCard icon={<ActivityIcon />} title={t('conversationsEmpty')} body={t('conversationsEmptyHint')} />
      ) : rows ? (
        <ul className="u-list-none u-p-0 u-m-0 u-grid u-gap-1" aria-label={t('conversationsListAria')}>
          {rows.map((r) => (
            <li key={r.threadId} className="u-flex u-items-center u-justify-between u-gap-2">
              <span className="u-grid">
                <span className="u-fs-12 u-break-anywhere">{r.preview || t('conversationNoPreview')}</span>
                <span className="muted u-fs-11">
                  {t('conversationMeta', { count: r.messageCount, when: formatRelativeTime(r.updatedAt) })}
                </span>
              </span>
              <span className="u-flex u-gap-1">
                <Button variant="secondary" size="sm" disabled={opening === r.threadId} aria-label={t('conversationOpenAria', { when: formatDateTime(r.updatedAt) })} onClick={() => void onOpen(r.threadId)}>{t('conversationOpen')}</Button>
                <Button variant="quiet" size="sm" aria-label={t('conversationDeleteAria', { when: formatDateTime(r.updatedAt) })} onClick={() => void onDelete(r.threadId)}>{t('common:delete')}</Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {open && (
        // A static record, not a live region (grade-ux CW68U-11): a labelled section whose
        // heading takes focus when it opens.
        <section className="u-mt-2" aria-labelledby={`cw-transcript-${open.threadId}`}>
          <div className="u-flex u-items-center u-justify-between u-mb-1">
            <h3 id={`cw-transcript-${open.threadId}`} ref={transcriptRef} tabIndex={-1} className="u-fs-12 u-fw-600">{t('conversationTranscriptAria', { when: formatDateTime(open.startedAt) })}</h3>
            <Button variant="quiet" size="sm" onClick={() => setOpen(null)}>{t('conversationBack')}</Button>
          </div>
          {open.messages.map((m, i) => (
            <p key={`${open.threadId}-${i}`} className="u-mb-1">
              <span className="u-fw-600">{m.role === 'visitor' ? t('roleVisitor') : t('roleAgent')}: </span>
              <span className="u-prewrap u-break-anywhere">{m.text}</span>
            </p>
          ))}
        </section>
      )}
    </section>
  );
}
