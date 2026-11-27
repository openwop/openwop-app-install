/**
 * ADR 1099 D7 (P3c) — the firm's side of a project's client threads, under the
 * Client access tab: one thread per outside collaborator, and a reply box for each.
 *
 * A collaborator's message reaches this list only after a member approves it in the
 * approvals inbox (it arrives as a proposal from the Project Guide). A member's
 * reply joins at once. The server holds the rules: read access to see, write access
 * to reply, and the `projects.client-portal` switch (a 404 renders nothing).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { TextareaField } from '../../ui/Field.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { formatDate } from '../../i18n/format.js';
import type { Project } from './projectsClient.js';
import { ClientAccessError, listClientThreads, replyToClient, type ClientThread } from './projectClientAccessClient.js';

type Load = { kind: 'loading' } | { kind: 'hidden' } | { kind: 'failed' } | { kind: 'ready'; threads: ClientThread[] };

export function ProjectClientMessages({ project, canWrite }: { project: Project; canWrite: boolean }): JSX.Element | null {
  const { t } = useTranslation('projects');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', threads: await listClientThreads(project.id) });
    } catch (err) {
      // A 404 is the switch off or no access: this section is not shown.
      setLoad(err instanceof ClientAccessError && err.status === 404 ? { kind: 'hidden' } : { kind: 'failed' });
    }
  }, [project.id]);
  useEffect(() => { setLoad({ kind: 'loading' }); void refresh(); }, [refresh]);

  if (load.kind === 'hidden') return null;
  return (
    <section className="surface-card u-grid u-gap-3" aria-labelledby="project-client-messages" data-testid="project-client-messages">
      <div>
        <h3 id="project-client-messages" className="u-mt-0 u-mb-1 u-fs-15">{t('clientMessagesHeading')}</h3>
        <p className="muted u-fs-13 u-m-0">{t('clientMessagesIntro')}</p>
      </div>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('clientMessagesLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('clientMessagesLoadFailed')} announcePolite message={t('clientMessagesLoadFailed')}
          action={<Button size="sm" variant="secondary" onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>{t('clientMessagesRetry')}</Button>} />
      ) : null}
      {load.kind === 'ready' && load.threads.length === 0 ? <InlineState kind="empty" message={t('clientMessagesEmpty')} /> : null}
      {load.kind === 'ready'
        ? load.threads.map((th) => <ThreadCard key={th.collaboratorId} projectId={project.id} thread={th} canWrite={canWrite} onSent={refresh} />)
        : null}
    </section>
  );
}

function ThreadCard({ projectId, thread, canWrite, onSent }: { projectId: string; thread: ClientThread; canWrite: boolean; onSent: () => Promise<void> }): JSX.Element {
  const { t } = useTranslation('projects');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      await replyToClient(projectId, thread.collaboratorId, text.trim());
      setText('');
      await onSent();
    } catch (err) {
      setError(err instanceof ClientAccessError && err.message ? err.message : t('clientMessagesReplyFailed'));
    } finally { setBusy(false); }
  };
  const headingId = `client-thread-${thread.collaboratorId}`;
  return (
    <div className="u-grid u-gap-2" role="group" aria-labelledby={headingId}>
      <h4 id={headingId} className="u-m-0 u-fs-14">{thread.label}</h4>
      <ol className="u-grid u-gap-2 u-m-0 u-p-0" aria-label={t('clientMessagesListLabel', { name: thread.label })}>
        {thread.entries.map((e) => (
          <li key={e.entryId} className="u-list-none">
            <div className="muted u-fs-12">
              {e.author.kind === 'collaborator' ? e.author.label : t('clientMessagesFromFirm')} · {formatDate(e.createdAt)}
            </div>
            <p className="u-m-0 u-fs-13 u-prewrap">{e.text}</p>
          </li>
        ))}
      </ol>
      {canWrite ? (
        <div className="u-grid u-gap-2">
          <TextareaField label={t('clientMessagesReplyLabel', { name: thread.label })} value={text} maxLength={2000} rows={2}
            onChange={(e) => setText(e.target.value)} className="u-mb-0" />
          {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
          <div className="action-bar">
            <Button size="sm" onClick={() => void send()} disabled={busy || !text.trim()}>{t('clientMessagesReplySend')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
