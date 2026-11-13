/**
 * ADR 1112 P6 — rewriting a large schedule goes in parts and can take up to a minute; the AI
 * bar says so while a scheduleSim is being rewritten, and only then.
 *
 * Sabotage (restored, red): drop the hint line from SectionAiBar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const pending = vi.hoisted(() => ({ resolve: (_v: Record<string, unknown>) => undefined as void }));
vi.mock('../cmsClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cmsClient.js')>();
  return { ...actual, rewriteSection: vi.fn(() => new Promise<Record<string, unknown>>((r) => { pending.resolve = r; })) };
});

import { SectionAiBar } from '../SectionAiBar.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const bar = (section: Section) => render(<SectionAiBar orgId="o1" section={section} onApply={() => undefined} errorMessage={() => 'failed'} />);

describe('SectionAiBar — the long-wait hint (ADR 1112 P6)', () => {
  it('shows while a scheduleSim is rewritten, and goes when it ends', async () => {
    bar({ sectionId: 's1', type: 'scheduleSim', data: { milestones: [{ id: 'm1', label: 'Start' }], decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }] } } as Section);
    expect(screen.queryByText(/can take up to a minute/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /improve/i }));
    await waitFor(() => expect(screen.getByText(/can take up to a minute/)).toBeTruthy());
    pending.resolve({});
    await waitFor(() => expect(screen.queryByText(/can take up to a minute/)).toBeNull());
  });
  it('does not show for other section types', async () => {
    bar({ sectionId: 's2', type: 'hero', data: { heading: 'Hi' } } as Section);
    fireEvent.click(screen.getByRole('button', { name: /improve/i }));
    await waitFor(() => expect(screen.getAllByRole('button').some((b) => b.getAttribute('aria-busy') === 'true')).toBe(true));
    expect(screen.queryByText(/can take up to a minute/)).toBeNull();
  });
});
