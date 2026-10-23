/**
 * XCH-GATE-1 (outline half) — the Challenge Factory outline gate shows an
 * outline: title, promise, audience/length, outcomes, and per day the
 * instruction, why and citations. It used to render the plan as a JSON dump.
 * An unreadable plan (not JSON, or JSON with no `days`) is an alert telling the
 * approver not to approve — never an empty outline presented as the plan.
 *
 * Sabotage that turns it red: unregistering the renderer (the markdown path
 * shows raw JSON keys, no "Day 1: …" heading, no alert); reading the length from
 * the day count instead of `durationDays` (the fixture's 21 ≠ its 2 days);
 * rendering an empty "Why:" line for a day with no why; dropping the citations
 * line; treating a plan without `days` as an empty outline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AssetPreview } from '../AssetPreview.js';

afterEach(cleanup);

const plan = {
  // durationDays (21) deliberately differs from the number of days listed (2),
  // so the length line proves which one it reads.
  title: 'Sleep steadier', promise: 'Fall asleep faster.', audience: 'Adults', durationDays: 21, dailyMinutesBudget: 15,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Sleep onset under 20 minutes', method: 'log' }],
  achievements: [],
  days: [
    { day: 1, stableActivityId: 'a', title: 'Wind down', actionInstruction: 'Dim lights an hour before bed.', userFacingWhy: 'Melatonin.', estimatedMinutes: 10, achievementIds: [], evidencePolicy: 'note', claimRefs: ['c-1'] },
    { day: 2, stableActivityId: 'b', title: 'Wake steady', actionInstruction: 'Wake at 7.', userFacingWhy: '', estimatedMinutes: 5, achievementIds: [], evidencePolicy: 'note' },
  ],
};

describe('kicktodo.challenge-plan review renderer', () => {
  it('shows the plan as an outline, never as raw JSON', () => {
    render(<AssetPreview asset={{ content: JSON.stringify(plan), artifactTypeId: 'kicktodo.challenge-plan' }} hideLabel />);
    expect(screen.getByRole('heading', { name: 'Sleep steadier' })).toBeTruthy();
    expect(screen.getByText('Fall asleep faster.')).toBeTruthy();
    expect(screen.getByText('For Adults · 21 days · about 15 minutes a day')).toBeTruthy();
    expect(screen.getByText('Sleep onset under 20 minutes')).toBeTruthy();
    expect(screen.getByText('Day 1: Wind down')).toBeTruthy();
    expect(screen.getByText('Dim lights an hour before bed.')).toBeTruthy();
    expect(screen.getByText('Why: Melatonin.')).toBeTruthy();
    // Day 2 has no why: its line is left out, not rendered as an empty "Why:".
    expect(screen.getByText('Day 2: Wake steady')).toBeTruthy();
    expect(screen.getAllByText(/^Why:/)).toHaveLength(1);
    expect(screen.getByText('Cites evidence: c-1')).toBeTruthy();
    expect(screen.getByText('Cites no evidence (stays within the plan day).')).toBeTruthy();
    expect(screen.queryByText(/"stableActivityId"/)).toBeNull();
  });

  it('an unreadable plan is an alert telling the approver not to approve', () => {
    // Valid JSON without `days`, and content that is not JSON at all.
    for (const content of ['{"title":"x"}', '{not json']) {
      render(<AssetPreview asset={{ content, artifactTypeId: 'kicktodo.challenge-plan' }} hideLabel />);
      expect(screen.getByRole('alert').textContent).toMatch(/could not be read\. Do not approve it/);
      // No outline is drawn beside the alert (an empty one would read as the plan).
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.queryByText(/^For /)).toBeNull();
      cleanup();
    }
  });
});
