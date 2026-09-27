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
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listProfiles, endorseSkill, unendorseSkill } = vi.hoisted(() => ({ listProfiles: vi.fn(), endorseSkill: vi.fn(), unendorseSkill: vi.fn() }));
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
  useMyIdentity: () => ({ status: 'known', userId: 'u2', profile: { userId: 'u2' } }),
}));

import { TeamPage } from '../TeamPage.js';
import { GlobalLiveRegion } from '../../../ui/announce.js';

/** Complete against the real shape — a thin fixture renders no row and every
 *  assertion then fails for a reason unrelated to the defect. */
const PROFILE = {
  userId: 'u1', tenantId: 't1', displayName: 'Ada Lovelace', jobTitle: 'Engineer',
  // `displayName`, NOT `preferredName` — the card reads the former (:24, :34) and
  // falls back to "unnamed teammate", so the wrong field makes the row render
  // anonymously and the positive assertion fail while the fix is fine.
  // The ARRAY fields are what render reads with `.length` — omitting any one of
  // them throws inside render, and every assertion then fails for a reason that
  // has nothing to do with the defect.
  // ADR 0624 D7 — endorsements ride as `{ count, endorsedByMe, endorserUserIds }`.
  skills: [{ name: 'maths', proficiency: 5, endorsements: { count: 0, endorsedByMe: false, endorserUserIds: [] } }],
  interests: ['looms'], equipment: [], workflows: [],
  portfolioAssetTokens: [], pinnedAgentIds: [],
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter><TeamPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
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
    expect(document.body.textContent).not.toContain('Profiles appear here as teammates fill them in');
  });

  it('the retry re-runs the read', async () => {
    listProfiles.mockRejectedValueOnce(new Error('503')).mockResolvedValue([PROFILE]);
    await mount();
    expect(listProfiles).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load the team directory');
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
    let resolveEndorse: (p: unknown) => void = () => {};
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

  it('reads the pressed state from `endorsedByMe` and the count from `count` (ADR 0624 D7)', async () => {
    // Three OTHER people endorsed it; the viewer (`u2`) did not. Before D7 the chip
    // derived both from an id array — a count of 3 must NOT read as "pressed".
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
