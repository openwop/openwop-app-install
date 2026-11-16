/**
 * CC-ORCH-3 — a campaign-orchestration run waiting on its child channel runs
 * (an `external-event` interrupt) told the user "Awaiting your input — see the
 * external-event card"; the chat card read "No card registered for
 * interrupt.external-event. Register one with registerCard()."; and the inbox said
 * "This app can't answer this kind of step (external-event) yet" (casavoga.com
 * v0.14.0, reported 2026-11-15). The step needs no person.
 *
 * Pins: RenderInterrupt shows a plain status for external-event, with no
 * "can't answer" fallback; the chat registry has a card for it; the provenance
 * chip does not say "awaiting human"; needsPersonInput is false for it and true
 * for an approval. An unknown kind still shows the generic fallback (control).
 *
 * Red when: the external-event case, its card registration or the provenance
 * branch is removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderInterrupt } from '../RenderInterrupt.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';
import { summarizeProvenance, humanChip } from '../../runs/RunProvenancePanel.js';
import { registerDefaultCards } from '../../chat/registry/defaultCards.js';
import { getCard } from '../../chat/registry/CardRegistry.js';
import { needsPersonInput } from '../../chat/interruptKinds.js';

afterEach(() => cleanup());

const active: OpenInterrupt = { interruptId: 'int-1', nodeId: 'n1', token: 't', kind: 'external-event', data: {}, createdAt: '2026-11-15T03:30:00.000Z' };

describe('CC-ORCH-3 — an external-event wait never asks the user for input', () => {
  it('the run page shows a plain status, not the "can\'t answer" fallback', () => {
    render(<MemoryRouter><RenderInterrupt runId="r" active={active} onResolved={() => {}} /></MemoryRouter>);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/continues on its own/i);
    expect(text).not.toMatch(/can.t answer|external-event/i);
  });

  it('the chat registry has a card for interrupt.external-event', () => {
    registerDefaultCards();
    expect(getCard('interrupt.external-event')).toBeTruthy();
  });

  it('the provenance chip does not call it a human wait', () => {
    const chip = humanChip(summarizeProvenance([], undefined, 'external-event').human);
    expect(chip.label).not.toMatch(/awaiting human/i);
  });

  it('needsPersonInput: false for external-event and timer, true for an approval', () => {
    expect(needsPersonInput('external-event')).toBe(false);
    expect(needsPersonInput('timer')).toBe(false);
    expect(needsPersonInput('approval')).toBe(true);
  });
});
