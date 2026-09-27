/**
 * UX_UPGRADE-challenge-outline CO-G1 — a link to a deleted outcome is visible.
 *
 * This module deliberately does NOT enforce referential integrity (validatePlan
 * owns that on Apply). But the checkbox list only renders outcomes that still
 * EXIST, so deleting an outcome made every achievement that referenced it look
 * *fine* — the broken link vanished from the UI and reappeared as a validation
 * error later, on a screen that showed nothing wrong. Surfacing the dangling id
 * is the same posture as surfacing the links; it is not enforcement.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { OutlineAchievementsWidget } from '../widgets.js';

afterEach(cleanup);

const OUTCOMES = [{ outcomeId: 'outcome-1', measurableOutcome: 'Run 5k', method: 'watch' }];

const view = (achievements: unknown, onChange = vi.fn()): ReturnType<typeof vi.fn> => {
  render(
    <OutlineAchievementsWidget
      id="ach"
      def={{ name: 'achievements', type: 'outline-achievements', label: 'Achievements' }}
      value={achievements}
      frames={[]}
      docState={{ outcomes: OUTCOMES }}
      orgId="o1"
      onChange={onChange}
      onChangeText={vi.fn()}
    />,
  );
  return onChange;
};

describe('CO-G1 — a dangling outcome link is surfaced', () => {
  it('names the missing outcome instead of silently dropping it from view', () => {
    view([{ achievementId: 'achievement-1', observableEvidence: 'ran it', outcomeIds: ['outcome-1', 'outcome-deleted'] }]);
    expect(document.body.textContent).toContain('outcome-deleted');
    // The link that still resolves stays an ordinary, checked checkbox.
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('offers to drop the broken link, and dropping it writes the pruned list', () => {
    const onChange = view([{ achievementId: 'achievement-1', observableEvidence: 'ran it', outcomeIds: ['outcome-1', 'outcome-deleted'] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the link' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const written = onChange.mock.calls[0]![0] as { outcomeIds: string[] }[];
    // Pruned, not cascaded: the surviving link is untouched.
    expect(written[0]!.outcomeIds).toEqual(['outcome-1']);
  });

  it('says nothing when every link resolves', () => {
    // The failure mode of this fix is warning on healthy data.
    view([{ achievementId: 'achievement-1', observableEvidence: 'ran it', outcomeIds: ['outcome-1'] }]);
    expect(screen.queryByRole('button', { name: 'Remove the link' })).toBeNull();
    expect(document.body.textContent).not.toContain('no longer exists');
  });

  it('says nothing for an achievement with no links at all', () => {
    view([{ achievementId: 'achievement-1', observableEvidence: 'ran it', outcomeIds: [] }]);
    expect(screen.queryByRole('button', { name: 'Remove the link' })).toBeNull();
  });
});
