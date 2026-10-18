/**
 * XCH-GATE-1 (outline half) — the Challenge Factory outline gate shows an
 * outline: title, promise, audience/length, outcomes, and per day the
 * instruction, why and citations. It used to render the plan as a JSON dump.
 * Sabotage: unregistering the renderer drops to the markdown path (the
 * "Day 1: …" heading disappears and the raw JSON keys show).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AssetPreview } from '../AssetPreview.js';

afterEach(cleanup);

const plan = {
  title: 'Sleep steadier', promise: 'Fall asleep faster.', audience: 'Adults', durationDays: 2, dailyMinutesBudget: 15,
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
    expect(screen.getByText('For Adults · 2 days · about 15 minutes a day')).toBeTruthy();
    expect(screen.getByText('Sleep onset under 20 minutes')).toBeTruthy();
    expect(screen.getByText('Day 1: Wind down')).toBeTruthy();
    expect(screen.getByText('Dim lights an hour before bed.')).toBeTruthy();
    expect(screen.getByText('Why: Melatonin.')).toBeTruthy();
    expect(screen.getByText('Cites evidence: c-1')).toBeTruthy();
    expect(screen.getByText('Cites no evidence (stays within the plan day).')).toBeTruthy();
    expect(screen.queryByText(/"stableActivityId"/)).toBeNull();
  });

  it('an unreadable plan is an alert telling the approver not to approve', () => {
    render(<AssetPreview asset={{ content: '{"title":"x"}', artifactTypeId: 'kicktodo.challenge-plan' }} hideLabel />);
    expect(screen.getByRole('alert').textContent).toMatch(/could not be read\. Do not approve it/);
  });
});
