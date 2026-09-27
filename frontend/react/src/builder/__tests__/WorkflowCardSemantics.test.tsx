/**
 * DSA-019 (ADR 0510 Phase 1) — the workflow grid card's open action is a REAL
 * <button> (the stretched title), not a focusable aria-labelled generic <div>.
 * Pins that (a) the only focus stop for "open" is a button with a meaningful
 * accessible name, (b) the card container itself is NOT focusable and carries
 * no ARIA name (prohibited on generics), (c) activating the kebab menu never
 * also opens the workflow (the old bubbling hazard), and (d) the embedded
 * runs-link stays independently clickable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkflowCard, WorkflowRow, type WorkflowListItem } from '../WorkflowCardViews.js';

afterEach(cleanup);

const wf: WorkflowListItem = {
  id: 'wf-1',
  name: 'Lead enrichment',
  nodeCount: 4,
  updatedAt: new Date().toISOString(),
};

function renderCard(
  overrides: Partial<Parameters<typeof WorkflowCard>[0]> = {},
  View: typeof WorkflowCard = WorkflowCard,
) {
  const onOpen = vi.fn();
  const onMenuToggle = vi.fn();
  const utils = render(
    <MemoryRouter>
      <View
        wf={wf}
        menuOpen={false}
        renaming={false}
        onMenuToggle={onMenuToggle}
        onRenameStart={vi.fn()}
        onRenameCommit={vi.fn()}
        onRenameCancel={vi.fn()}
        onOpen={onOpen}
        onAssign={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onSetBudget={vi.fn()}
        archived={false}
        onArchiveToggle={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onOpen, onMenuToggle, ...utils };
}

describe('WorkflowCard semantics (DSA-019)', () => {
  it('opens via a real named button, and the container is a plain div', () => {
    const { onOpen, container } = renderCard();
    const open = screen.getByRole('button', { name: /Lead enrichment/ });
    expect(open.tagName).toBe('BUTTON');
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);

    const card = container.querySelector('.workflow-card');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('tabindex')).toBeNull();
    expect(card!.getAttribute('aria-label')).toBeNull();
    expect(card!.getAttribute('role')).toBeNull();
  });

  it('menu toggle does not open the workflow', () => {
    const { onOpen, onMenuToggle, container } = renderCard();
    const kebab = container.querySelector<HTMLButtonElement>('.workflow-card-menu button');
    expect(kebab).not.toBeNull();
    fireEvent.click(kebab!);
    expect(onMenuToggle).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('the runs link stays independently clickable without opening the card', () => {
    const { onOpen, container } = renderCard();
    const link = container.querySelector<HTMLAnchorElement>('.workflow-card-meta a');
    expect(link).not.toBeNull();
    fireEvent.click(link!);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('rename mode swaps the title button for the rename input', () => {
    renderCard({ renaming: true });
    expect(screen.queryByRole('button', { name: /Lead enrichment/ })).toBeNull();
    expect(document.querySelector('.workflow-card-rename-input')).not.toBeNull();
  });
});

/**
 * ADR 0596 §Correction 4 (`WFAU-2`) — the RENDER hop of "made readable".
 *
 * ADR 0596 §5 claims model provenance was "made readable". The three witnesses
 * it cites all stop at the ownership row; nothing asserted a pixel. A repo-wide
 * `grep -rn "authoredVia|aiAuthoredChip" src --include=*.test.tsx` returned
 * ZERO before this block, so the chip could be deleted from both views with CI
 * green and an ADR claiming the defect fixed. BOTH views render it (grid card +
 * list row) — a witness on only one of them leaves half the surface unguarded.
 */
describe('WFAU-2 — the AI-provenance chip actually renders', () => {
  const views: Array<[string, typeof WorkflowCard]> = [['grid card', WorkflowCard], ['list row', WorkflowRow]];

  it.each(views)('%s renders chip--ai with its own TEXT label when authoredVia is set', (_label, View) => {
    const { container } = renderCard({ wf: { ...wf, authoredVia: 'workflow-author' } }, View);
    const chip = container.querySelector('.chip--ai');
    expect(chip, 'DESIGN.md §5.3 model-provenance token').not.toBeNull();
    // Colour is never the only signal — the chip carries readable text, and the
    // tooltip carries the "review it before you run it" guidance.
    expect(chip!.textContent?.trim()).toBe('AI-authored');
    expect(chip!.getAttribute('title')).toBe('A model authored this workflow. Review it before you run it.');
  });

  it.each(views)('%s renders NO chip for a hand-built workflow (the chip is a claim, not decoration)', (_label, View) => {
    const { container } = renderCard({}, View);
    expect(container.querySelector('.chip--ai')).toBeNull();
  });
});
