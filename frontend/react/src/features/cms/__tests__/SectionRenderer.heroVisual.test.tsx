import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function hero(data: Record<string, unknown>): Section {
  return { sectionId: 'hero', type: 'hero', data: { heading: 'Make progress', ...data } };
}

function view(data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={hero(data)} mode="public" /></MemoryRouter>);
}

describe('CMS hero visual treatments', () => {
  it('renders the journey motif without exposing decorative SVG to assistive technology', () => {
    const { container } = view({ visual: 'journey' });
    expect(container.querySelector('.fp-hero--journey')).toBeTruthy();
    expect(container.querySelector('.fp-hero__journey')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Make progress' })).toBeTruthy();
  });

  it('renders an authored image with its alt text', () => {
    const { container } = view({ visual: 'image', imageToken: 'media:hero', alt: 'A person walking at sunrise' });
    expect(screen.getByRole('img', { name: 'A person walking at sunrise' })).toBeTruthy();
    expect(container.querySelector('.fp-hero__product')).toBeNull(); // the default artwork is replaced
  });

  it('preserves the workflow motif for existing pages and supports no visual', () => {
    const first = view({});
    // The facelift (3080f2f24) rebuilt the default hero motif: HeroSchematic now renders
    // `.fp-hero__product`, and `.fp-hero__schematic` survives only on HeroJourney's svg —
    // it is in NO stylesheet at all. Assert the markup the default actually emits.
    expect(first.container.querySelector('.fp-hero--workflow .fp-hero__product')).toBeTruthy();
    cleanup();
    const second = view({ visual: 'none' });
    expect(second.container.querySelector('.fp-hero--none')).toBeTruthy();
    expect(second.container.querySelector('.fp-hero__product, .fp-hero__journey, .fp-hero__image')).toBeNull();
  });

  it('renders the run ledger IN the hero grid, decorative to AT, with the real event vocabulary', () => {
    const { container } = view({ visual: 'run', ctaLabel: 'Start', ctaUrl: '/chat' });
    const ledger = container.querySelector('.fp-hero--run .fp-hero__split .fp-run');
    expect(ledger).toBeTruthy();
    expect(ledger?.getAttribute('aria-hidden')).toBe('true');
    // Wire literals, untranslated — the protocol's own run-event types.
    const events = [...container.querySelectorAll('.fp-run__event')].map((e) => e.textContent);
    expect(events).toEqual(['run.started', 'agent.decided', 'node.completed', 'budget.consumed', 'approval.requested', 'approval.granted', 'run.completed']);
    expect(container.querySelectorAll('.fp-run__row--waits')).toHaveLength(1);
    // The heading and CTA stay real, reachable content beside it.
    expect(screen.getByRole('heading', { level: 1, name: 'Make progress' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start' })).toBeTruthy();
  });
});

describe('CMS columns layout: rows', () => {
  it('renders parallel statements as an unnumbered list of h3 + text', () => {
    const section: Section = { sectionId: 'r', type: 'columns', data: { heading: 'Open', layout: 'rows', columns: [{ title: 'You can leave.', text: 'Move hosts.' }, { title: 'You can see why.', text: 'Every event.' }] } };
    const { container } = render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
    expect(container.querySelector('ul.fp-rows__list')).toBeTruthy();
    expect(container.querySelector('.fp-step__num, ol')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['You can leave.', 'You can see why.']);
  });
});
