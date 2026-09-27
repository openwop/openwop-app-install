/**
 * The shared template gallery (DESIGN.md §4.5 rule 14 / ADR 0521).
 *
 * It exists because the inline strip it replaced could not scale, so the
 * behaviours worth pinning are the ones that only matter AT SCALE — the search
 * and facet gating — plus the three states the strip had nowhere to put:
 * loading, FAILED, and genuinely-empty. A failed catalog read reading as "no
 * templates installed" is the exact dishonesty the failed-read canon exists to
 * stop (DESIGN.md §4.6), and it is invisible on a four-template catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateGalleryBody, type TemplateItem } from '../TemplateGallery.js';

const items = (n: number, category?: (i: number) => string): TemplateItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    label: `Template ${i}`,
    description: `Body ${i}`,
    ...(category ? { category: category(i) } : {}),
  }));

describe('states the inline strip could not express', () => {
  it('a FAILED read never reads as an empty catalog', () => {
    render(<TemplateGalleryBody items={null} failed onUse={vi.fn()} />);
    // The empty-state copy must NOT appear — that would claim the catalog is
    // empty when we could not read it. Something must be SAID instead.
    expect(screen.queryByText(/no templates installed/i)).toBeNull();
    // Title AND body both say so — assert presence, not uniqueness.
    expect(screen.getAllByText(/could not|couldn.t/i).length).toBeGreaterThan(0);
  });

  it('null (loading) is distinct from [] (genuinely none)', () => {
    const { rerender, container } = render(<TemplateGalleryBody items={null} onUse={vi.fn()} />);
    // Loading renders a skeleton, not the empty state.
    expect(screen.queryByText(/no templates installed/i)).toBeNull();
    expect(container.querySelector('.skeleton, [class*="skeleton"]')).toBeTruthy();

    rerender(<TemplateGalleryBody items={[]} onUse={vi.fn()} emptyTitle="No form templates installed" />);
    expect(screen.getByText('No form templates installed')).toBeTruthy();
  });
});

describe('scale behaviour — the reason this replaced a strip', () => {
  it('hides search below the floor and shows it above', () => {
    const { rerender } = render(<TemplateGalleryBody items={items(3)} onUse={vi.fn()} />);
    expect(screen.queryByRole('searchbox')).toBeNull();

    rerender(<TemplateGalleryBody items={items(40)} onUse={vi.fn()} />);
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('filters by name, and a zero-match offers a way back', () => {
    render(<TemplateGalleryBody items={items(40)} onUse={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz-nothing' } });
    // Never a blank region: a designed no-match with a clear action.
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeTruthy();
  });

  it('offers the category facet only when there is more than one category', () => {
    const { rerender } = render(<TemplateGalleryBody items={items(40, () => 'Only')} onUse={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();

    rerender(<TemplateGalleryBody items={items(40, (i) => (i % 2 ? 'A' : 'B'))} onUse={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeTruthy();
  });
});

describe('picking', () => {
  it('hands the feature the id it supplied — the gallery never learns the domain type', () => {
    const onUse = vi.fn();
    render(<TemplateGalleryBody items={items(2)} onUse={onUse} />);
    fireEvent.click(screen.getAllByRole('button', { name: /use template/i })[0]!);
    expect(onUse).toHaveBeenCalledWith('t0');
  });

  it('disables the CTA while a create is in flight, so one click cannot become two', () => {
    render(<TemplateGalleryBody items={items(2)} onUse={vi.fn()} busy />);
    // No jest-dom in this suite — assert the DOM property directly.
    expect((screen.getAllByRole('button', { name: /use template/i })[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
