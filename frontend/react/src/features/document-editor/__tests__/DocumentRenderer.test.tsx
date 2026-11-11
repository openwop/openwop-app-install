/**
 * ADR 1055 D2 — the read-only renderer shows a stored document's good content,
 * and says that part of it could not be shown, instead of an empty page.
 *
 * RED on `13fb94b5d`: the renderer handed the stored JSON to TipTap verbatim, so
 * one unknown node rendered the whole document as nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { DocumentRenderer } from '../DocumentRenderer.js';

afterEach(() => { cleanup(); });

const state = (content: unknown[]) => JSON.stringify({ title: 'T', content: { type: 'doc', content } });
const keep = { type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] };

describe('DocumentRenderer (ADR 1055 D2)', () => {
  it('renders the good content of a document holding an unknown node, with a notice', async () => {
    render(<DocumentRenderer content={state([keep, { type: 'notARealNode' }])} />);
    expect(await screen.findByText('keep me')).toBeTruthy();
    expect(screen.getByText('renderPartial')).toBeTruthy();
  });

  it('shows no notice for a valid document (control)', async () => {
    render(<DocumentRenderer content={state([keep])} />);
    expect(await screen.findByText('keep me')).toBeTruthy();
    expect(screen.queryByText('renderPartial')).toBeNull();
  });
});
