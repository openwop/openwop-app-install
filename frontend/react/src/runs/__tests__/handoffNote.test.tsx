/**
 * ADR 0829 P3 — the structured handoff note in the run UI.
 *
 *   - `readHandoffNote` refuses anything that is not the bounded shape (the key
 *     is caller-writable on a root run), and an unknown producer reads as a person;
 *   - `HandoffNoteCard` renders every part as plain text — markup in the note
 *     stays text, never HTML;
 *   - `RunHandoffMap`: a chip that carries a note is a disclosure button that
 *     opens the card; a chip without one stays inert (the sabotage leg); an
 *     escalation's note, which rides `node.suspended`, attaches to its
 *     escalation chip.
 *
 * Sabotages that turn it red (probed w28): `readHandoffNote` keeping malformed
 * entries, an intent-less note, or an unknown producer claim; the intent rendered
 * via `dangerouslySetInnerHTML`; a section dropped; the heading levels flattened;
 * the chip losing its note, its toggle or its escalation attachment.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';
import { HANDOFF_KEY, readHandoffNote } from '../handoffNote.js';
import { HandoffNoteCard } from '../HandoffNoteCard.js';
import { RunHandoffMap } from '../RunHandoffMap.js';

afterEach(cleanup);

const NOTE = {
  v: 1,
  intent: 'Find three comparable launches',
  decisions: [{ summary: 'Budget capped at $5k', decidedBy: 'user:owner' }],
  openQuestions: ['Which regions?'],
  tried: [{ approach: 'Internal wiki search', droppedBecause: 'stale' }],
  confidence: { value: 0.8, basis: 'two sources agree' },
  producedBy: 'agent',
};

const ev = (sequence: number, type: string, payload: Record<string, unknown>): RunEventDoc =>
  ({ eventId: `e${sequence}`, runId: 'r', sequence, type, payload, timestamp: '2026-10-05T00:00:00Z', schemaVersion: 1 });

describe('readHandoffNote', () => {
  it('parses the bounded shape and drops malformed entries', () => {
    const n = readHandoffNote({ [HANDOFF_KEY]: { ...NOTE, openQuestions: ['ok', 7, ''], decisions: [{ nope: 1 }, ...NOTE.decisions] } })!;
    expect(n.intent).toBe('Find three comparable launches');
    expect(n.openQuestions).toEqual(['ok']);
    expect(n.decisions).toEqual(NOTE.decisions);
  });
  it('is null without an intent, a key, or an object', () => {
    expect(readHandoffNote({ [HANDOFF_KEY]: { decisions: [] } })).toBeNull();
    expect(readHandoffNote({})).toBeNull();
    expect(readHandoffNote(null)).toBeNull();
    expect(readHandoffNote({ [HANDOFF_KEY]: 'intent' })).toBeNull();
  });
  it('reads an unknown producer claim as a person', () => {
    expect(readHandoffNote({ [HANDOFF_KEY]: { intent: 'x', producedBy: 'root' } })!.producedBy).toBe('human');
  });
});

describe('HandoffNoteCard', () => {
  it('renders every part, and markup stays text', () => {
    const note = readHandoffNote({ [HANDOFF_KEY]: { ...NOTE, intent: '<img src=x onerror=alert(1)> plan' } })!;
    const { container } = render(<HandoffNoteCard note={note} title="Why this needs you" />);
    expect(screen.getByRole('heading', { name: 'Why this needs you' })).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)> plan')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Which regions?')).toBeTruthy();
    expect(screen.getByText(/Internal wiki search/)).toBeTruthy();
    expect(screen.getByText(/Budget capped at \$5k/)).toBeTruthy();
  });
});

describe('RunHandoffMap — notes', () => {
  it('a chip with a note is a disclosure button that opens the card', () => {
    render(<RunHandoffMap events={[
      ev(1, 'runOrchestrator.decided', { agentId: 'sup', decision: { kind: 'next-worker' } }),
      ev(2, 'agent.handoff', { fromAgentId: 'sup', toAgentId: 'researcher', [HANDOFF_KEY]: NOTE }),
    ]} />);
    const btn = screen.getByRole('button', { name: /sup → researcher/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Find three comparable launches')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Find three comparable launches')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByText('Find three comparable launches')).toBeNull();
  });

  it('a chip without a note stays inert (no button)', () => {
    render(<RunHandoffMap events={[ev(1, 'agent.handoff', { fromAgentId: 'sup', toAgentId: 'researcher' })]} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("an escalation's note (on node.suspended) attaches to its escalation chip", () => {
    render(<RunHandoffMap events={[
      ev(1, 'core.workflowChain.confidence-escalated', { confidence: 0.2, floor: 0.5, escalationKind: 'clarify' }),
      ev(2, 'node.suspended', { interruptId: 'i-1', kind: 'clarification', [HANDOFF_KEY]: { ...NOTE, intent: 'Draft the launch brief' } }),
    ]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Draft the launch brief')).toBeTruthy();
  });
});

describe('HandoffNoteCard — heading outline', () => {
  const note = readHandoffNote({ [HANDOFF_KEY]: NOTE })!;
  it('at headingLevel 2 the section labels are h3 (no skipped level)', () => {
    render(<HandoffNoteCard note={note} title="Why this needs you" headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Why this needs you' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0);
  });
  it('at the default level the labels are h4', () => {
    render(<HandoffNoteCard note={note} title="Note" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Note' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 4 }).length).toBeGreaterThan(0);
  });
});
