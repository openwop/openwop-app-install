/**
 * The one real finding in the personal-data cluster: the team directory said two
 * contradictory things at once on a failed read.
 *
 * `.catch(setError)` left `rows` null, and the render treats null as LOADING. So
 * the error Notice appeared **with a skeleton still pulsing underneath it** — the
 * page reporting a failure and claiming to still be working on it, in the same
 * frame. And the branch one step further along reads "Profiles appear here as
 * teammates fill them in", which invites you to wait for colleagues who have in
 * fact done nothing wrong.
 *
 * The other four surfaces in this cluster were checked and are SOUND — recorded
 * in the batch notes rather than here, because a test file is a bad place to
 * claim things about files it does not touch.
 *
 * Gap ids: #2670 (`1eb4749ac` — an error and a skeleton in the same frame),
 * PROF-UX-11 (a failed read shows ONLY the announced card), PROF-UX-9/16/17 (the
 * endorse chip: sr-only why, verified text, in-flight busy), ADR 0624 D7 (the
 * chip reads the projected `endorsedByMe`, never "count > 0").
 *
 * The failed-state cases each carry a POSITIVE anchor (the failure card, no
 * skeleton; after a retry, the row) — a bare negative also holds while the page
 * is still LOADING, which is exactly where #2670 lived. Both live regions are
 * module state and are reset in `beforeEach`. Sabotage-witnessed (/grade-tests
 * wave 3, `w3g3-td-*`): a failure that stays loading / renders empty / renders
 * the "fill them in" body / toasts the raw error, a dead retry, a sticky failure
 * flag, a retry that drops the rows, an unannounced card, an endorse chip that is
 * not disabled / not busy / never released / pressed from a non-zero count, and
 * the removed sr-only texts each turn a named case red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { Profile } from '../profilesClient.js';
import type { MyIdentity } from '../useMyIdentity.js';

const { listProfiles, endorseSkill, unendorseSkill, PROFILE } = vi.hoisted(() => {
  /** Complete against the real shape — a thin fixture renders no row and every
   *  assertion then fails for a reason unrelated to the defect.
   *  `displayName`, NOT `preferredName` — the card reads the former and falls
   *  back to "unnamed teammate". ADR 0624 D7 — endorsements ride as
   *  `{ count, endorsedByMe, endorserUserIds }`. Hoisted so the identity mock
   *  below can build the viewer's (complete) profile from it. */
  const PROFILE: Profile = {
    userId: 'u1', tenantId: 't1', displayName: 'Ada Lovelace', jobTitle: 'Engineer',
    skills: [{ name: 'maths', proficiency: 5, endorsements: { count: 0, endorsedByMe: false, endorserUserIds: [] } }],
    interests: ['looms'], equipment: [], workflows: [],
    portfolioAssetTokens: [], pinnedAgentIds: [],
    completeness: 40, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  return {
    PROFILE,
    listProfiles: vi.fn<() => Promise<Profile[]>>(),
    endorseSkill: vi.fn<(userId: string, skill: string) => Promise<Profile>>(),
    unendorseSkill: vi.fn<(userId: string, skill: string) => Promise<Profile>>(),
  };
});
vi.mock('../profilesClient.js', async (orig) => ({
  ...(await orig<typeof import('../profilesClient.js')>()),
  listProfiles,
  endorseSkill,
  unendorseSkill,
}));
// The viewer is a KNOWN teammate (`u2`) who is not the row's owner (`u1`), so the
// endorse chip is offered. `isMine` stays real — it is what the page reasons with.
vi.mock('../useMyIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../useMyIdentity.js')>()),
  useMyIdentity: (): MyIdentity => ({ status: 'known', userId: 'u2', profile: { ...PROFILE, userId: 'u2', displayName: 'Grace Hopper', skills: [] } }),
}));

import { TeamPage } from '../TeamPage.js';
import { GlobalLiveRegion, announce } from '../../../ui/announce.js';

const mount = async (): Promise<void> => {
  render(<MemoryRouter><TeamPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  announce('');
  announce('', { assertive: true });
  listProfiles.mockResolvedValue([PROFILE]);
});

describe('a failed directory read is not an empty directory', () => {
  it('stops claiming to still be loading underneath its own error', async () => {
    listProfiles.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(document.body.textContent).toContain('Could not load the team directory');
  });

  it('does not invite you to wait for teammates who did nothing wrong', async () => {
    listProfiles.mockRejectedValue(new Error('503'));
    await mount();
    // Positive anchor first: the page is in its FAILED state (not still loading,
    // where this negative would hold vacuously) …
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(document.body.textContent).toContain('Could not load the team directory');
    // … and that state does not tell you to wait for teammates.
    expect(document.body.textContent).not.toContain('Profiles appear here as teammates fill them in');
  });

  it('the retry re-runs the read', async () => {
    listProfiles.mockRejectedValueOnce(new Error('503')).mockResolvedValue([PROFILE]);
    await mount();
    expect(listProfiles).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load the team directory');
    // The retried read LANDED — the row, not a skeleton that also lacks the error.
    expect(document.body.textContent).toContain('Ada Lovelace');
  });

  it('a genuinely empty directory still says so', async () => {
    // The failure mode of this fix: a new workspace told its directory is broken
    // when in fact nobody has filled a profile in yet.
    listProfiles.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('Profiles appear here as teammates fill them in');
    expect(document.body.textContent).not.toContain('Could not load the team directory');
  });

  it('a successful read still lists people', async () => {
    await mount();
    expect(document.body.textContent).toContain('Ada Lovelace');
  });
});

const mountWithLive = async (): Promise<void> => {
  render(<MemoryRouter><GlobalLiveRegion /><TeamPage /></MemoryRouter>);
  await act(async () => {});
};
const polite = (): string => document.querySelector('[data-owp-live="polite"]')?.textContent ?? '';

describe('a failed read shows ONLY the announced designed card (PROF-UX-11)', () => {
  it('no raw err.message Notice above the card; the card is what is spoken', async () => {
    listProfiles.mockRejectedValue(new Error('503 backend exploded'));
    await mountWithLive();
    // The designed state is there and announced…
    expect(document.body.textContent).toContain('Could not load the team directory');
    expect(polite()).toContain('Could not load the team directory');
    // …and the server blob is nowhere: not as a Notice, not as text.
    expect(document.querySelector('.alert')).toBeNull();
    expect(document.body.textContent).not.toContain('503 backend exploded');
  });
});

describe('the endorse chip (PROF-UX-9 / 16 / 17)', () => {
  it('is busy + disabled while the endorsement is in flight, then released', async () => {
    let resolveEndorse: (p: Profile) => void = () => {};
    endorseSkill.mockImplementation(() => new Promise((res) => { resolveEndorse = res; }));
    await mountWithLive();
    const chip = screen.getByRole('button', { name: /maths/ }) as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    await act(async () => { fireEvent.click(chip); });
    // In flight: a second click cannot re-POST and land as a false "failed".
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(chip);
    expect(endorseSkill).toHaveBeenCalledTimes(1);
    await act(async () => { resolveEndorse({ ...PROFILE, skills: [{ name: 'maths', proficiency: 5, endorsements: { count: 1, endorsedByMe: true, endorserUserIds: ['u2'] } }] }); });
    const after = screen.getByRole('button', { name: /maths/ }) as HTMLButtonElement;
    expect(after.disabled).toBe(false);
    expect(after.getAttribute('aria-busy')).toBeNull();
    expect(after.getAttribute('aria-pressed')).toBe('true');
  });

  it('a non-zero count is not "pressed": pressed follows `endorsedByMe` (ADR 0624 D7)', async () => {
    // Three OTHER people endorsed it; the viewer (`u2`) did not — a count of 3 must
    // NOT read as "pressed". (Ceiling: the backend always projects
    // `count = ids.length` and `endorsedByMe = ids.includes(viewer)`, so "reads the
    // count from `count`" vs from `endorserUserIds.length` is not distinguishable
    // with a production-shaped fixture — and is not claimed here.)
    listProfiles.mockResolvedValue([{ ...PROFILE, skills: [{ name: 'maths', proficiency: 5, endorsements: { count: 3, endorsedByMe: false, endorserUserIds: ['u3', 'u4', 'u5'] } }] }]);
    await mountWithLive();
    const chip = screen.getByRole('button', { name: /maths/ });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.querySelector('.teampage-endorse-count')?.textContent).toBe('3');
    expect(chip.textContent).toContain('Endorse this skill');
    // And the inverse: the viewer IS among the endorsers → pressed, "remove" copy.
    cleanup();
    listProfiles.mockResolvedValue([{ ...PROFILE, skills: [{ name: 'maths', proficiency: 5, endorsements: { count: 2, endorsedByMe: true, endorserUserIds: ['u2', 'u3'] } }] }]);
    await mountWithLive();
    const mine = screen.getByRole('button', { name: /maths/ });
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(mine.querySelector('.teampage-endorse-count')?.textContent).toBe('2');
  });

  it('says WHY in text a screen reader gets, not only in a title (PROF-UX-9)', async () => {
    await mountWithLive();
    const chip = screen.getByRole('button', { name: /maths/ });
    expect(chip.textContent).toContain('Endorse this skill');
    expect(chip.querySelector('.sr-only')?.textContent).toContain('Endorse this skill');
  });

  it('the verified chip carries sr-only text, not an icon alone (PROF-UX-16)', async () => {
    listProfiles.mockResolvedValue([{ ...PROFILE, emailVerified: true }]);
    await mountWithLive();
    const flag = document.querySelector('.teampage-flag');
    expect(flag?.querySelector('.sr-only')?.textContent).toBe('Email verified');
  });
});
