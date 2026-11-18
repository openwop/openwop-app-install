/**
 * CC-UI-2 — the run page renders timer and walkthrough-step interrupts honestly.
 *
 * MEASURED on app.openwop.dev (373d4863a, 2026-11-12): a run waiting on a
 * `core.flow.wait` timer, and one waiting on a `ui.walkthrough.step`, both showed
 * "This step can't be shown here (timer|walkthrough-step). Ask your administrator
 * to update the app." on the current app, and the provenance chip said
 * "Awaiting human" for the timer, which waits on the clock, not a person.
 *
 * Pins: a timer shows when it resumes (absolute `until`, or createdAt + seconds);
 * a walkthrough/tour step points to Guided walkthroughs; neither shows the
 * "update the app" fallback; an unknown kind gets the generic fallback, which
 * names no kind and links the activity log (control, ADR 1125 D1, #5843). Provenance
 * labels an open timer as waiting on a timer, an open approval as awaiting human.
 *
 * Red when: the two RenderInterrupt cases or the provenance timer branch are removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderInterrupt } from '../RenderInterrupt.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';
import { summarizeProvenance, humanChip } from '../../runs/RunProvenancePanel.js';
import { formatDateTime } from '../../i18n/format.js';

afterEach(() => cleanup());

function mk(kind: OpenInterrupt['kind'], data: unknown): OpenInterrupt {
  return { interruptId: 'int-1', nodeId: 'n1', token: 't', kind, data, createdAt: '2026-11-12T03:30:00.000Z' };
}
const renderIt = (active: OpenInterrupt) => render(<MemoryRouter><RenderInterrupt runId="r" active={active} onResolved={() => {}} /></MemoryRouter>);

describe('CC-UI-2 — timer and walkthrough-step interrupts', () => {
  it('an absolute timer says when the run resumes, without the update-the-app fallback', () => {
    renderIt(mk('timer', { kind: 'until', timestamp: '2026-11-13T09:00:00.000Z' }));
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain(formatDateTime('2026-11-13T09:00:00.000Z'));
    expect(text).not.toMatch(/administrator|update the app/i);
  });

  it('a duration timer resumes at createdAt + seconds', () => {
    renderIt(mk('timer', { kind: 'duration', seconds: 86400 }));
    expect(screen.getByRole('status').textContent).toContain(formatDateTime('2026-11-13T03:30:00.000Z'));
  });

  it('a walkthrough step links to Guided walkthroughs', () => {
    renderIt(mk('walkthrough-step', { checkpoint: 'x', hitl: false }));
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/walkthroughs');
    expect(screen.getByRole('status').textContent).not.toMatch(/administrator|update the app/i);
  });

  it('control: an unknown kind still shows the generic fallback', () => {
    renderIt(mk('something-new', {}));
    const text = screen.getByRole('status').textContent ?? '';
    // ADR 1125 D1 + #5843 — the fallback names no kind, gives no untrue "update
    // the app" advice, and offers the activity log as the action.
    expect(text).not.toMatch(/something-new/);
    expect(text).not.toMatch(/administrator|update the app/i);
    expect(screen.getByRole('link', { name: 'View the activity log' }).getAttribute('href')).toBe('/runs/r');
  });

  it('control: on the run page itself the fallback does not link to itself', () => {
    render(<MemoryRouter initialEntries={['/runs/r']}><RenderInterrupt runId="r" active={mk('something-new', {})} onResolved={() => {}} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: 'View the activity log' })).toBeNull();
  });
});

describe('CC-UI-2 — provenance does not call a timer a human wait', () => {
  it('an open timer is "waiting on a timer"; an open approval is "awaiting human"', () => {
    expect(humanChip(summarizeProvenance([], undefined, 'timer').human).label).toBe('Waiting on a timer');
    expect(humanChip(summarizeProvenance([], undefined, 'approval').human).label).toBe('Awaiting human');
  });
});
