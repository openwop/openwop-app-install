import { describe, it, expect } from 'vitest';
import { a2uiInterruptCard } from '../interruptBridge.js';
import { A2UI_CATALOG_VERSION, parseSurface } from '../catalog.js';

/**
 * The interrupt→A2UI bridge (ADR 0051 Phase 3): a surface-bearing interrupt
 * renders as the ui.a2ui-surface card; everything else falls back to the
 * default interrupt.<kind> card (returns null).
 */

const surfaceInterrupt = {
  kind: 'clarification',
  nodeId: 'n1',
  data: {
    question: 'When should the kickoff be?',
    catalogVersion: A2UI_CATALOG_VERSION,
    surface: {
      title: 'Schedule the kickoff',
      components: [
        { component: 'field.date', id: 'date', label: 'Date', required: true },
        { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
      ],
    },
  },
};

describe('a2uiInterruptCard', () => {
  it('returns ui.a2ui-surface card props for a surface-bearing interrupt', () => {
    const card = a2uiInterruptCard(surfaceInterrupt);
    expect(card).not.toBeNull();
    expect(card?.cardType).toBe('ui.a2ui-surface');
    expect(card?.payload.catalogVersion).toBe(A2UI_CATALOG_VERSION);
    // the extracted payload must validate against the host catalog
    expect(parseSurface(card?.payload).ok).toBe(true);
  });

  it('falls back (null) for a plain clarification with no surface', () => {
    expect(a2uiInterruptCard({ kind: 'clarification', data: { question: 'Clarify?' } })).toBeNull();
  });

  it('falls back (null) for approval/refinement/cancellation interrupts', () => {
    expect(a2uiInterruptCard({ kind: 'approval', data: { prompt: 'OK?' } })).toBeNull();
    expect(a2uiInterruptCard({ kind: 'refinement', data: { current: 'x' } })).toBeNull();
  });

  it('falls back (null) when surface is present but catalogVersion is missing', () => {
    expect(a2uiInterruptCard({ kind: 'clarification', data: { surface: { components: [] } } })).toBeNull();
  });

  it('tolerates null/undefined/empty interrupts', () => {
    expect(a2uiInterruptCard(null)).toBeNull();
    expect(a2uiInterruptCard(undefined)).toBeNull();
    expect(a2uiInterruptCard({})).toBeNull();
  });
});
