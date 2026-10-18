import { describe, it, expect } from 'vitest';
import { a2uiInterruptCard } from '../interruptBridge.js';
import { A2UI_CATALOG_VERSION, parseSurface } from '../catalog.js';
import type { OpenInterrupt } from '../../../client/interruptsClient.js';

/** A typed interrupt fixture: the bridge reads only `data`, but callers hand it a
 *  real interrupt, so the fixture carries its `kind` too. */
const interrupt = (kind: OpenInterrupt['kind'], data: unknown): Pick<OpenInterrupt, 'kind' | 'data'> => ({ kind, data });

/**
 * The interrupt→A2UI bridge (ADR 0051 Phase 3): a surface-bearing interrupt
 * renders as the ui.a2ui-surface card; everything else falls back to the
 * default interrupt.<kind> card (returns null). The bridge is kind-agnostic by
 * design — it keys on the data shape, never `kind`. Breaks if a surface-bearing
 * interrupt falls back to the free-text textarea, the carried surface is altered,
 * or a malformed one (no catalogVersion / no surface object) mounts the A2UI card.
 */

const surfaceInterrupt: Pick<OpenInterrupt, 'kind' | 'nodeId' | 'data'> = {
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
    // The payload is a union since ADR 0749 (0.9.1 tree | v0.9); this is the tree arm.
    // Pinned literally: the surface is carried unchanged and `question` is dropped.
    expect(card?.payload).toEqual({
      catalogVersion: '0.9.1',
      surface: {
        title: 'Schedule the kickoff',
        components: [
          { component: 'field.date', id: 'date', label: 'Date', required: true },
          { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
        ],
      },
    });
    // the extracted payload must validate against the host catalog
    expect(parseSurface(card?.payload).ok).toBe(true);
  });

  it('falls back (null) for a plain clarification with no surface', () => {
    expect(a2uiInterruptCard(interrupt('clarification', { question: 'Clarify?' }))).toBeNull();
  });

  it('falls back (null) when catalogVersion is present but surface is missing or not an object', () => {
    expect(a2uiInterruptCard(interrupt('approval', { prompt: 'OK?', catalogVersion: '0.9.1' }))).toBeNull();
    expect(a2uiInterruptCard(interrupt('clarification', { catalogVersion: '0.9.1', surface: [] }))).toBeNull();
    expect(a2uiInterruptCard(interrupt('refinement', { catalogVersion: '0.9.1', surface: 'x' }))).toBeNull();
  });

  it('falls back (null) when surface is present but catalogVersion is missing', () => {
    expect(a2uiInterruptCard(interrupt('clarification', { surface: { components: [] } }))).toBeNull();
  });

  it('tolerates null/undefined/empty interrupts', () => {
    expect(a2uiInterruptCard(null)).toBeNull();
    expect(a2uiInterruptCard(undefined)).toBeNull();
    expect(a2uiInterruptCard({ data: undefined })).toBeNull();
  });
});
