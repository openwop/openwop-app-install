/**
 * PROF-UX-1/2/3/4 — the /profile page's own bar, raised to the feature's /team
 * reference:
 *  - a failed profile read is an announced, retryable designed state, never a
 *    raw `err.message` over a pulsing skeleton (PROF-UX-3);
 *  - the skills editor's fields carry accessible names (the proficiency select
 *    previously had NONE — an axe-critical `select-name`) and the 1–5 scale is
 *    labeled with named levels (PROF-UX-1/2);
 *  - the portfolio section is REACHABLE (the client surface had zero TSX
 *    consumers — the ADR 0488 built-but-unreachable class) (PROF-UX-4).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { getMyProfile, uploadImage, updateMyProfile } = vi.hoisted(() => ({ getMyProfile: vi.fn(), uploadImage: vi.fn(), updateMyProfile: vi.fn() }));
vi.mock('../profilesClient.js', async (orig) => ({
  ...(await orig<typeof import('../profilesClient.js')>()),
  getMyProfile,
  uploadImage,
  updateMyProfile,
}));
// The composed tabs are other features' surfaces (graded by their own
// collections); stub them so this test exercises ONLY the profile-owned page.
vi.mock('../../connections/ConnectionsManager.js', () => ({ ConnectionsManager: () => null }));
vi.mock('../../connections/useOAuthCallback.js', () => ({ useOAuthCallbackToast: () => undefined }));
vi.mock('../../../agents/AgentBoardPanel.js', () => ({ AgentBoardPanel: () => null }));
vi.mock('../../../notifications/ApprovalsInbox.js', () => ({ ApprovalsInbox: () => null }));
vi.mock('../../profile-memory/ProfileMemoryTab.js', () => ({ ProfileMemoryTab: () => null }));
vi.mock('../../profile-memory/ProfileKnowledgeTab.js', () => ({ ProfileKnowledgeTab: () => null }));
vi.mock('../../twin/ProfileTwinGrantsTab.js', () => ({ ProfileTwinGrantsTab: () => null }));
vi.mock('../ProfileWorkflowsTab.js', () => ({ ProfileWorkflowsTab: () => null }));
vi.mock('../ProfileSchedulesTab.js', () => ({ ProfileSchedulesTab: () => null }));
vi.mock('../ProfileActivityTab.js', () => ({ ProfileActivityTab: () => null }));
vi.mock('../../../kanban/kanbanClient.js', () => ({ getPersonalBoard: vi.fn() }));
vi.mock('../../users/usersClient.js', () => ({ updateMyDisplayName: vi.fn() }));

import { COMPLETENESS_FIELD_KEY, ProfilePage } from '../ProfilePage.js';
import { COMPLETENESS_FIELD_IDS } from '../profilesClient.js';
import { messages as enMessages } from '../i18n/en.js';
import { GlobalLiveRegion } from '../../../ui/announce.js';
import { MAX_UPLOAD_BYTES } from '../../../client/fileToBase64.js';

/** Complete against the real shape — a thin fixture makes assertions fail for
 *  reasons unrelated to the defect (the teamDirectoryFailedRead lesson). */
const PROFILE = {
  userId: 'u1', tenantId: 't1', displayName: 'Ada Lovelace',
  // ADR 0624 D7 — endorsements ride as `{ count, endorsedByMe, endorserUserIds }`.
  skills: [{ name: 'maths', proficiency: 3, endorsements: { count: 0, endorsedByMe: false, endorserUserIds: [] } }],
  equipment: [], interests: [], workflows: [],
  portfolioAssetTokens: ['tok-portfolio-1'], pinnedAgentIds: [],
  completeness: 40, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter><ProfilePage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getMyProfile.mockResolvedValue(PROFILE);
});

describe('a failed profile read is a designed, retryable state (PROF-UX-3)', () => {
  it('renders the retry StateCard, not a skeleton and not the raw error', async () => {
    getMyProfile.mockRejectedValue(new Error('503 backend exploded'));
    await mount();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(document.body.textContent).toContain('Could not load your profile');
    // No raw err.message on the page — the copy is the designed state's.
    expect(document.body.textContent).not.toContain('503 backend exploded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('the retry re-runs the read and renders the profile', async () => {
    getMyProfile.mockRejectedValueOnce(new Error('503')).mockResolvedValue(PROFILE);
    await mount();
    expect(getMyProfile).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(getMyProfile).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your profile');
    expect(document.body.textContent).toContain('Ada Lovelace');
  });
});

describe('the skills editor is accessibly named (PROF-UX-1/2)', () => {
  it('the proficiency select and skill input carry accessible names', async () => {
    await mount();
    // The select previously announced as bare "3, combobox" (axe-critical).
    expect(screen.getByRole('combobox', { name: 'Proficiency level (1–5)' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Skill name' })).toBeTruthy();
  });

  it('the 1–5 scale is labeled with named levels, not bare numbers', async () => {
    await mount();
    expect(screen.getByRole('option', { name: '3 — Proficient' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '5 — Expert' })).toBeTruthy();
  });
});

describe('the portfolio section is reachable (PROF-UX-4)', () => {
  it('renders the stored images with an accessible remove, plus the add action', async () => {
    await mount();
    expect(document.body.textContent).toContain('Portfolio');
    expect(screen.getByRole('img', { name: 'Portfolio image' })).toBeTruthy();
    // F8 — per-item accessible name, not one shared label for every remove.
    expect(screen.getByRole('button', { name: 'Remove portfolio image 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add image' })).toBeTruthy();
  });

  it('the /profile completeness meter is a labeled progressbar (PROF-UX-7)', async () => {
    await mount();
    const meter = screen.getByRole('progressbar', { name: 'Your profile completeness' });
    expect(meter.getAttribute('aria-valuenow')).toBe('40');
  });
});

/** The shell's live regions BY NAME — `toast.error` speaks through the assertive
 *  one (PROF-UX-20), `toast.success` through the polite one. */
const mountWithLive = async (): Promise<void> => {
  render(<MemoryRouter><GlobalLiveRegion /><ProfilePage /></MemoryRouter>);
  await act(async () => {});
};
const assertive = (): string => document.querySelector('[data-owp-live="assertive"]')?.textContent ?? '';

describe('the hours-range error is a FIELD error, not a toast (PROF-UX-12)', () => {
  it('attaches to the field: aria-invalid + aria-describedby + focus, and no save request', async () => {
    await mountWithLive();
    const hours = screen.getByRole('textbox', { name: 'Hours / week' }) as HTMLInputElement;
    fireEvent.change(hours, { target: { value: '999' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save details' })); });
    expect(hours.getAttribute('aria-invalid')).toBe('true');
    const describedBy = hours.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    const errorNode = describedBy.split(' ').map((id) => document.getElementById(id)).find((n) => n?.textContent?.includes('between 0 and 168'));
    expect(errorNode).toBeTruthy();
    // The user learns WHICH field failed: focus moved there.
    expect(document.activeElement).toBe(hours);
    // One mechanism per message — the error is NOT also toasted.
    expect(assertive()).not.toContain('between 0 and 168');
    expect(updateMyProfile).not.toHaveBeenCalled();
  });

  it('typing in the field clears the error (a stale error is a lie)', async () => {
    await mountWithLive();
    const hours = screen.getByRole('textbox', { name: 'Hours / week' }) as HTMLInputElement;
    fireEvent.change(hours, { target: { value: '999' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save details' })); });
    expect(hours.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(hours, { target: { value: '40' } });
    expect(hours.getAttribute('aria-invalid')).toBeNull();
  });

  it('the preferred-name hint is a DESCRIPTION, no longer part of the accessible NAME', async () => {
    await mount();
    // Before: the hint sat inside the <label>, so the name was
    // "Preferred name What agents should call you…". Now `help` → aria-describedby.
    const field = screen.getByRole('textbox', { name: 'Preferred name' });
    const describedBy = field.getAttribute('aria-describedby') ?? '';
    const hint = describedBy.split(' ').map((id) => document.getElementById(id)).find((n) => n?.textContent?.includes('What agents should call you'));
    expect(hint).toBeTruthy();
  });
});

describe('the tab strip has an accessible name (PROF-UX-8)', () => {
  it('names the tablist', async () => {
    await mount();
    expect(screen.getByRole('tablist', { name: 'Profile sections' })).toBeTruthy();
  });
});

describe('"Add skill" moves focus into the new row (PROF-UX-18)', () => {
  it('focuses the new, empty skill-name input', async () => {
    await mount();
    expect(screen.getAllByRole('textbox', { name: 'Skill name' })).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add skill' })); });
    const inputs = screen.getAllByRole('textbox', { name: 'Skill name' }) as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(document.activeElement).toBe(inputs[1]);
    expect(inputs[1]!.value).toBe('');
  });

  it('removing a row keeps the OTHER row intact (rows are keyed by id, not index)', async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add skill' })); });
    const inputs = screen.getAllByRole('textbox', { name: 'Skill name' }) as HTMLInputElement[];
    fireEvent.change(inputs[1]!, { target: { value: 'looms' } });
    // Remove the FIRST row; the second must survive with its own value.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove skill maths' })); });
    const left = screen.getAllByRole('textbox', { name: 'Skill name' }) as HTMLInputElement[];
    expect(left).toHaveLength(1);
    expect(left[0]!.value).toBe('looms');
  });
});

describe('portfolio refusals are localized and client-side (PROF-UX-13)', () => {
  const portfolioInput = (): HTMLInputElement => {
    const inputs = document.querySelectorAll('input[type="file"]');
    // The avatar picker is first (identity card); the portfolio picker follows.
    return inputs[1] as HTMLInputElement;
  };

  it('a non-image is refused with the PORTFOLIO copy (not the avatar string) and never uploaded', async () => {
    await mountWithLive();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.change(portfolioInput(), { target: { files: [file] } }); });
    expect(assertive()).toContain('Portfolio image must be an image.');
    expect(assertive()).not.toContain('Avatar must be an image.');
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('an oversize image is refused BEFORE the round-trip with a localized MiB figure', async () => {
    await mountWithLive();
    const file = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    await act(async () => { fireEvent.change(portfolioInput(), { target: { files: [file] } }); });
    expect(assertive()).toContain('That image is too large (max 32 MiB).');
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('an in-cap image goes through to the upload (the negative control)', async () => {
    uploadImage.mockResolvedValue('tok-new');
    await mountWithLive();
    const file = new File(['x'], 'ok.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(portfolioInput(), { target: { files: [file] } }); });
    expect(uploadImage).toHaveBeenCalledTimes(1);
  });
});

describe('the completeness "what next" caption (PROF-UX-14; `completenessMissing[]` on the /me lane, ADR 0624 D4)', () => {
  it('renders the two localized labels the backend names (bio + avatar, the two 15-weights)', async () => {
    getMyProfile.mockResolvedValue({ ...PROFILE, completenessMissing: [{ field: 'bio', weight: 15 }, { field: 'avatar', weight: 15 }] });
    await mount();
    const caption = screen.getByTestId('profile-completeness-next');
    expect(caption.textContent).toBe('Next: add Bio and Avatar');
    // Localized, never the raw ids.
    expect(caption.textContent).not.toMatch(/\bbio\b|\bavatar\b/);
  });

  it('renders the top two in the order served (weight desc), not all of them', async () => {
    getMyProfile.mockResolvedValue({
      ...PROFILE,
      completenessMissing: [{ field: 'bio', weight: 15 }, { field: 'jobTitle', weight: 10 }, { field: 'skills', weight: 15 }],
    });
    await mount();
    expect(screen.getByTestId('profile-completeness-next').textContent).toBe('Next: add Bio and Job title');
  });

  it('maps EVERY id in the backend contract to a catalog key that exists (no raw id can reach the caption)', () => {
    // Exhaustive by construction (`Record<CompletenessFieldId, string>`), but the
    // KEYS are strings — this pins that each one is a real `profiles` catalog key
    // and that the caption nouns are bare (the form hint suffix never leaks).
    expect(Object.keys(COMPLETENESS_FIELD_KEY).sort()).toEqual([...COMPLETENESS_FIELD_IDS].sort());
    for (const id of COMPLETENESS_FIELD_IDS) {
      const key = COMPLETENESS_FIELD_KEY[id];
      const label = (enMessages as Record<string, string>)[key];
      expect(label, `${id} → ${key}`).toBeTruthy();
      expect(label).not.toMatch(/comma-separated/);
    }
  });

  it('every one of the nine ids renders as its label (walked two at a time — the caption shows two)', async () => {
    const ids = [...COMPLETENESS_FIELD_IDS];
    for (let i = 0; i < ids.length; i += 2) {
      const pair = ids.slice(i, i + 2);
      getMyProfile.mockResolvedValue({ ...PROFILE, completenessMissing: pair.map((field) => ({ field, weight: 10 })) });
      await mount();
      const text = screen.getByTestId('profile-completeness-next').textContent ?? '';
      for (const id of pair) {
        expect(text, `caption for ${pair.join('+')}`).toContain((enMessages as Record<string, string>)[COMPLETENESS_FIELD_KEY[id]]);
      }
      cleanup();
    }
  });

  it('renders NOTHING when the field is absent (no invented next step)', async () => {
    await mount();
    expect(screen.queryByTestId('profile-completeness-next')).toBeNull();
    expect(document.body.textContent).not.toContain('Next: add');
  });

  it('an id from a NEWER backend renders as itself rather than being dropped (last-resort fallback only)', async () => {
    getMyProfile.mockResolvedValue({ ...PROFILE, completenessMissing: [{ field: 'somethingNew', weight: 5 }] });
    await mount();
    expect(screen.getByTestId('profile-completeness-next').textContent).toBe('Next: add somethingNew');
  });
});
