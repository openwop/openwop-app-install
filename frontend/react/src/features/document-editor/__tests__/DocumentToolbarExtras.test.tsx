/**
 * DocumentToolbarExtras tests (ADR 0334 Phase 5) — the AI-assist deep-link pins
 * the chat-drive target (the document-author agent), the single-chat pattern.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';

const navSpy = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navSpy }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// Stub the shared CommentsPanel (it self-loads a thread over the network).
vi.mock('../../comments/CommentsPanel.js', () => ({
  CommentsPanel: ({ resourceType, resourceId }: { resourceType: string; resourceId: string }) =>
    <div data-testid="comments-panel">{`${resourceType}:${resourceId}`}</div>,
}));

import { DocumentToolbarExtras } from '../DocumentToolbarExtras.js';

afterEach(() => { cleanup(); navSpy.mockReset(); vi.unstubAllGlobals(); });

describe('DocumentToolbarExtras — AI assist deep-link', () => {
  it('navigates to the document-author agent in the existing chat', () => {
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'aiAssist' }));
    expect(navSpy).toHaveBeenCalledWith('/?agent=feature.documents.agents.document-author');
  });

  it('renders AI + Comments + Copy + Download actions', () => {
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    expect(screen.getByRole('button', { name: 'aiAssist' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'comments' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'copyMarkdown' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'downloadMarkdown' })).toBeTruthy();
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
 */
describe('DOC-G3 — failures say which action failed', () => {
  const okCanvas = { canvasId: 'c1', canvasTypeId: 'canvas.document', version: 1, state: { content: { type: 'doc', content: [] } } };

  it('a refused clipboard reports the COPY, not the export', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(okCanvas), { status: 200, headers: { 'content-type': 'application/json' } })));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError')) },
    });
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'copyMarkdown' })); });
    expect(document.body.textContent).toContain('copyFailed');
    expect(document.body.textContent).not.toContain('exportFailed');
  });

  it('a server export failure keeps the format and the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) =>
      (String(url).endsWith('/export')
        ? new Response('nope', { status: 413 })
        : new Response(JSON.stringify(okCanvas), { status: 200, headers: { 'content-type': 'application/json' } }))));
    render(<DocumentToolbarExtras orgId="o1" canvasId="c1" docName="Doc" dirty={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'downloadPdf' })); });
    // The t() stub echoes the key, so the interpolated key is what proves the
    // status-bearing message replaced the generic one.
    expect(document.body.textContent).toContain('exportFailedStatus');
  });
});
