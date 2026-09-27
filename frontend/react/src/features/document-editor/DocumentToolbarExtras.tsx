/**
 * Document editor toolbar slot (ADR 0334 Phases 4 + 5) — a `ToolbarExtras`
 * consumer with two concerns:
 *  - AI assist (Phase 5 v1): deep-links to the EXISTING chat scoped to the
 *    document-author agent (the ADR 0058 chat-drive pattern — no bespoke panel,
 *    no in-route LLM; the AI runs in the real run-scoped chat). Inline
 *    improve-selection + scoped diffs (RFC 0130) are Phase 5b.
 *  - Markdown export (Phase 4): serialize the SAVED canvas → Copy / Download.
 * The slot owns its own client + i18n + a `role="status"` live region.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ToolbarExtrasProps } from '../../canvas/types.js';
import { createCanvasClient } from '../../canvas/canvasClient.js';
import { config, authedHeaders, fetchOpts } from '../../client/config.js';
import { IconButton, Modal, Notice } from '../../ui/index.js';
import { CopyIcon, DownloadIcon, FileTextIcon, MessageSquareIcon, SparklesIcon } from '../../ui/icons/index.js';
import { CommentsPanel } from '../comments/CommentsPanel.js';
import { coerceDocument } from './documentDoc.js';
import { pmToMarkdown } from './pmToMarkdown.js';
import { DOCUMENT_AUTHOR_AGENT } from './documentAgents.js';

export function DocumentToolbarExtras({ orgId, canvasId, docName, dirty }: ToolbarExtrasProps): JSX.Element {
  const { t } = useTranslation('document-editor');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const client = useMemo(() => createCanvasClient({ basePath: '/host/openwop-app/document-editor' }), []);

  const askAi = useCallback(() => {
    void navigate(`/?agent=${encodeURIComponent(DOCUMENT_AUTHOR_AGENT)}`);
  }, [navigate]);

  const markdown = useCallback(async (): Promise<string> => {
    const rec = await client.getCanvas(orgId, canvasId);
    return pmToMarkdown(coerceDocument(rec.state).content);
  }, [client, orgId, canvasId]);

  // DOC-G3 — `fallback` names what THIS action was, and a thrown Error's message
  // (the HTTP status the export path already composes) survives. Before, every
  // failure in this toolbar — a denied clipboard on "Copy markdown", a 403 on
  // PDF, a 413 on a large DOCX — collapsed to the same "Export failed", which
  // sends the user to retry the wrong thing.
  const withGuard = useCallback(async (fn: () => Promise<void>, okMsg: string, fallback?: string) => {
    setBusy(true); setError(false);
    try { await fn(); setStatus(dirty ? t('exportedSavedOnly') : okMsg); }
    catch (e) { setError(true); setStatus(e instanceof Error && e.message ? e.message : (fallback ?? t('exportFailed'))); }
    finally { setBusy(false); }
  }, [dirty, t]);

  const onCopy = useCallback(() => withGuard(async () => {
    // A refused clipboard rejects with a DOMException whose message is often
    // empty or browser-jargon, so this path names itself rather than leaning on
    // the thrown text.
    try { await navigator.clipboard.writeText(await markdown()); }
    catch { throw new Error(t('copyFailed')); }
  }, t('copied'), t('copyFailed')), [withGuard, markdown, t]);

  const onDownload = useCallback(() => withGuard(async () => {
    const md = await markdown();
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${docName || 'document'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, t('downloaded')), [withGuard, markdown, docName, t]);

  // ADR 0334 4b — PDF export is server-authoritative (the backend serializes the
  // SAVED canvas and renders it via the ADR-0057 pdfkit path), streamed as bytes.
  // Server-authoritative binary export (PDF / DOCX): the backend serializes the
  // SAVED canvas; the blob is streamed and downloaded.
  const download = useCallback((format: string, ext: string) => withGuard(async () => {
    const exportUrl = `${config.baseUrl}/host/openwop-app/document-editor/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/export`;
    const res = await fetch(exportUrl, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ format }) }));
    if (!res.ok) throw new Error(t('exportFailedStatus', { format: format.toUpperCase(), status: res.status }));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `${docName || 'document'}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, t('downloaded')), [withGuard, orgId, canvasId, docName, t]);

  return (
    <span className="cv-editor__tools" role="group" aria-label={t('exportGroup')}>
      <IconButton label={t('aiAssist')} icon={<SparklesIcon size={13} />} onClick={askAi} title={t('aiAssistHint')} />
      <IconButton label={t('comments')} icon={<MessageSquareIcon size={13} />} onClick={() => setCommentsOpen(true)} title={t('comments')} />
      <IconButton label={t('copyMarkdown')} icon={<CopyIcon size={13} />} onClick={onCopy} disabled={busy} title={t('copyMarkdown')} />
      <IconButton label={t('downloadMarkdown')} icon={<DownloadIcon size={13} />} onClick={onDownload} disabled={busy} title={t('downloadMarkdown')} />
      <IconButton label={t('downloadPdf')} icon={<FileTextIcon size={13} />} onClick={() => download('pdf', 'pdf')} disabled={busy} title={t('downloadPdf')} />
      <IconButton label={t('downloadDocx')} icon={<FileTextIcon size={13} />} onClick={() => download('docx', 'docx')} disabled={busy} title={t('downloadDocx')} />
      {status ? (error
        ? <Notice variant="error">{status}</Notice>
        : <span className="chip chip--muted" role="status">{status}</span>
      ) : null}
      {commentsOpen ? (
        <Modal onClose={() => setCommentsOpen(false)} label={t('comments')} showClose>
          <CommentsPanel orgId={orgId} resourceType="canvas_document" resourceId={canvasId} />
        </Modal>
      ) : null}
    </span>
  );
}
