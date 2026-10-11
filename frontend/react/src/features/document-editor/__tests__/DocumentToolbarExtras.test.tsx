/**
 * DocumentToolbarExtras tests (ADR 0334 Phase 5) — the AI-assist deep-link pins
 * the chat-drive target (the document-author agent), the single-chat pattern.
 *
 * Sabotage (wave 14): navigate to '/' → the deep-link case red; scope comments to
 * another resourceType → the comments case red; rename an export button → the
 * export-set case red; DOC-G3 sabotages are listed on that block.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';

const navSpy = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navSpy }));
// The t() stub echoes the key AND its interpolation params, so a message that
// drops the format or the HTTP status is visible to the assertions.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      (o ? `${k}(${Object.entries(o).map(([a, b]) => `${a}=${String(b)}`).join(',')})` : k),
  }),
}));
// Stub the shared CommentsPanel (it self-loads a thread over the network).
vi.mock('../../comments/CommentsPanel.js', () => ({
  CommentsPanel: ({ resourceType, resourceId }: { resourceType: string; resourceId: string }) =>
    <div data-testid="comments-panel">{`${resourceType}:${resourceId}`}</div>,
}));

import { DocumentToolbarExtras } from '../DocumentToolbarExtras.js';

afterEach(() => {
  cleanup(); navSpy.mockReset(); vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('DocumentToolbarExtras — AI assist deep-link', () => {
  it('navigates to the document-author agent in the existing chat', () => {
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'aiAssist' }));
    expect(navSpy).toHaveBeenCalledWith('/?agent=vendor.openwop-app.documents.agents.document-author');
  });

  // aiAssist / comments / copyMarkdown are each driven by their own case below;
  // this case owns the export set (Markdown / PDF / DOCX downloads).
  it('renders AI + Comments + Copy + Download actions', () => {
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    for (const name of ['downloadMarkdown', 'downloadPdf', 'downloadDocx']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('opens the comments panel scoped to the canvas_document resource', () => {
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    expect(screen.queryByTestId('comments-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'comments' }));
    expect(screen.getByTestId('comments-panel').textContent).toBe('canvas_document:c1');
  });
});

/**
 * UX_UPGRADE-document-editor DOC-G3 — one failure message for every failure.
 *
 * A denied clipboard on "Copy markdown", a 403 on PDF and a 413 on a large DOCX
 * all collapsed into "Export failed", so the message sent the user to retry the
 * wrong thing. The status the export path already composes is now kept, and the
 * copy path names itself.
 *
 * Sabotage (wave 14): copy path throws exportFailed → copy case red; the canvas
 * read (not the clipboard) failing → copy case red (writeText never reached);
 * drop the status message / its format+status params → 413 case red.
 */
describe('DOC-G3 — failures say which action failed', () => {
  const okCanvas = { canvasId: 'c1', canvasTypeId: 'canvas.document', version: 1, state: { content: { type: 'doc', content: [] } } };

  it('a refused clipboard reports the COPY, not the export', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(okCanvas), { status: 200, headers: { 'content-type': 'application/json' } })));
    const writeText = vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'copyMarkdown' })); });
    // The CLIPBOARD refused (the saved doc was read + serialized and handed over)
    // — a failed canvas read would also render copyFailed, so pin the path.
    expect(writeText).toHaveBeenCalledWith('\n');
    expect(screen.getByRole('alert').textContent).toContain('copyFailed');
    expect(document.body.textContent).not.toContain('exportFailed');
  });

  it('a server export failure keeps the format and the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) =>
      (String(url).endsWith('/export')
        ? new Response('nope', { status: 413 })
        : new Response(JSON.stringify(okCanvas), { status: 200, headers: { 'content-type': 'application/json' } }))));
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'downloadPdf' })); });
    // The t() stub echoes the key + params: the status-bearing message replaced
    // the generic one AND carries the format and the HTTP status.
    expect(screen.getByRole('alert').textContent).toContain('exportFailedStatus(format=PDF,status=413)');
  });
});
