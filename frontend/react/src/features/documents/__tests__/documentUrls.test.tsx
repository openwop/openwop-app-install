/**
 * ADR 0350 Phase 1 — per-document URLs. Two decisions are pinned here:
 *  1. Every markdown-document + canvas list cell is a real `<a>` Link pointing at
 *     the item's own URL — so native middle-click / ⌘-click / "open in new tab"
 *     work (the architect's HIGH finding; a prior `onClick`-button did not).
 *  2. A canvas whose editor feature is OFF (no `href`) renders as a
 *     non-interactive cell — still no link, matching DATA-CV-3.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DocumentCard, DocumentRow, CanvasDocCard, CanvasDocRow } from '../DocumentViews.js';
import { FileTextIcon } from '../../../ui/icons/index.js';
import type { DocumentRecord, CanvasSourceRow } from '../documentsClient.js';

const doc: DocumentRecord = {
  documentId: 'doc_1', orgId: 'org_1', kind: 'sow', format: 'markdown',
  title: 'My SOW', status: 'draft', createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
};
const canvas: CanvasSourceRow = {
  canvasId: 'cv_1', canvasTypeId: 'canvas.slides', name: 'Launch deck', version: 1, updatedAt: '2026-07-11T00:00:00Z',
};

function renderInRouter(node: React.ReactElement): void {
  render(<MemoryRouter>{node}</MemoryRouter>);
}

afterEach(cleanup);

describe('ADR 0350 — document + canvas cells are real links', () => {
  it('DocumentCard links to the per-document URL', () => {
    renderInRouter(<DocumentCard doc={doc} href="/documents/doc_1?org=org_1" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/documents/doc_1?org=org_1');
  });

  it('DocumentRow renders a title link AND an "Open" link to the same URL', () => {
    renderInRouter(<DocumentRow doc={doc} href="/documents/doc_1?org=org_1" onRemove={() => {}} />);
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/documents/doc_1?org=org_1');
    // The whole-row identity link + the explicit "Open" affordance.
    expect(links.length).toBeGreaterThanOrEqual(2);
    // The Open affordance is styled as a link-button (a.btn — inherits the focus ring).
    const openBtn = links.find((a) => a.className.includes('btn'));
    expect(openBtn).toBeTruthy();
  });

  it('CanvasDocCard links when a href is given', () => {
    renderInRouter(<CanvasDocCard canvas={canvas} typeName="Slide deck" Icon={FileTextIcon} href="/slides/cv_1" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/slides/cv_1');
  });

  it('CanvasDocRow with NO href (editor off) renders no navigation link', () => {
    renderInRouter(<CanvasDocRow canvas={canvas} typeName="Slide deck" Icon={FileTextIcon} onRemove={() => {}} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
