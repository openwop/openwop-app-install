/**
 * UX_UPGRADE-campaign-brief — CB-G1 / CB-G2.
 *
 *  - CB-G1: the validator returns `{ field, message }` per issue. The page threw
 *    `field` away and joined every message into one run-on line, so on a
 *    five-section editor the reader had to hunt for what the server had already
 *    pinpointed. Issues are now a list, each naming its section and taking the
 *    reader there.
 *  - CB-G2: Validate asks the server about the SAVED brief. With unsaved edits on
 *    screen that is a different document — the Review panel reads live form state
 *    while Validate answered about the stored one, so two panels on one screen
 *    could disagree. When the form is dirty the action saves first and says so.
 *
 * Wave 30 (grade-tests): the valid case asserts the success copy (an "invalid, 0
 * issues" render used to pass it); the detail's `findCampaignForBrief` read is
 * mocked (it was a live fetch — allowlist line retired); the fixture is a full
 * typed row (no casts). Sabotage-witnessed: one row per issue, the section jump +
 * focus, the unknown-field fallback, save-first when dirty, no save when clean.
 *
 * CC-UI-1 (`35e7340754`): the shared `ui/Notice` renders ONE status
 * icon and puts the labelled dismiss LAST; the brief page must not add a second
 * icon of its own inside the children.
 *
 * Wave 112 (`w112g4-bv-*`): each issue row is asserted as its full text (the
 * section label beside ITS message), the jump lands on the named section's own
 * heading, an unknown field's row holds no control at all (the Notice's Close is
 * in the same group), the success copy names the enabled channel, and save-first
 * is asserted as an ORDER (save called before validate), not as two calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as C from '../campaignBriefClient.js';
import type { CampaignBrief, ValidationResult } from '../campaignBriefClient.js';

// Typed against the real client, so a fixture drifting from its types fails tsc.
const listBriefs = vi.fn<typeof C.listBriefs>();
const validateBriefById = vi.fn<typeof C.validateBriefById>();
const updateBrief = vi.fn<typeof C.updateBrief>();

// The collection selector reads the current client's KB through its own client.
vi.mock('../../kb/kbClient.js', () => ({ listCollections: vi.fn(async () => []) }));

vi.mock('../campaignBriefClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBriefs: (...a: Parameters<typeof C.listBriefs>) => listBriefs(...a),
    validateBriefById: (...a: Parameters<typeof C.validateBriefById>) => validateBriefById(...a),
    updateBrief: (...a: Parameters<typeof C.updateBrief>) => updateBrief(...a),
    listPersonas: vi.fn(async () => []),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBrands: vi.fn(async () => []),
    findCampaignForBrief: vi.fn(async () => null),
    getPendingKernelRun: vi.fn(async () => null), // ADR 1020 D8 — the pending-kernel read
    deleteBrief: vi.fn(async () => {}),
    duplicateBrief: vi.fn(async () => { throw new Error('duplicate not exercised here'); }),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignBriefPage } from '../CampaignBriefPage.js';

const BRIEF: CampaignBrief = {
  id: 'brief-1', tenantId: 't', orgId: 'org-1', name: 'Spring launch', objective: 'Grow trials',
  personaIds: [], productName: 'Widget', productDescription: '', industryVertical: '',
  // R2 CB-SP-13 — the fixture used 'email' (not a real channel enum; the real
  // one is 'email_sequence'), forced past the compiler with the cast, which
  // would mask an enum-keyed regression.
  channels: [{ type: 'email_sequence', enabled: false, config: {} }],
  messaging: { primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '' },
  status: 'draft', kernelStale: false, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const INVALID: ValidationResult = {
  valid: false,
  issues: [
    { field: 'personaIds', message: 'At least one persona is required.' },
    { field: 'messaging.primaryValueProp', message: 'A primary value proposition is required.' },
    { field: 'channels', message: 'Enable at least one channel.' },
  ],
  enabledChannels: [],
};

/** Open the brief detail and press the validate action. */
async function openAndValidate(): Promise<HTMLElement> {
  render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
  await screen.findByRole('button', { name: /validate/i });
  fireEvent.click(screen.getByRole('button', { name: /validate/i }));
  return await screen.findByRole('group', { name: /validation result/i });
}

/** The Notice root inside the validation group (no cast: a missing root fails here). */
function noticeBox(summary: HTMLElement): HTMLElement {
  const box = summary.firstElementChild;
  if (!(box instanceof HTMLElement)) throw new Error('validation group has no Notice');
  return box;
}

beforeEach(() => {
  listBriefs.mockReset(); validateBriefById.mockReset(); updateBrief.mockReset();
  listBriefs.mockResolvedValue([BRIEF]);
  validateBriefById.mockResolvedValue(INVALID);
  updateBrief.mockResolvedValue(BRIEF);
});
afterEach(cleanup);

describe('brief validation summary', () => {
  it('CB-G1: lists each issue separately instead of one run-on line', async () => {
    const summary = await openAndValidate();
    expect(within(summary).getAllByRole('listitem')).toHaveLength(3);
  });

  it('CB-G1: each issue names the SECTION the server pointed at', async () => {
    const summary = await openAndValidate();
    // The `field` the validator returned is no longer discarded: each row is the
    // section label beside ITS OWN message, in the server's order.
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Audience: At least one persona is required.',
      'Messaging: A primary value proposition is required.',
      'Channels: Enable at least one channel.',
    ]);
    expect(within(summary).getAllByRole('listitem').map((li) => within(li).getByRole('button').textContent)).toEqual(['Audience', 'Messaging', 'Channels']);
  });

  it('CB-G1: clicking an issue focuses the section that owns it', async () => {
    const summary = await openAndValidate();
    fireEvent.click(within(summary).getByRole('button', { name: 'Messaging' }));
    // The section is focusable precisely so an issue can carry the reader to it.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) throw new Error('nothing focused');
    expect(focused.tagName).toBe('SECTION');
    // The section's OWN heading, not any text that mentions messaging.
    expect(focused.querySelector('h3')?.textContent).toBe('Messaging');
  });

  it('CB-G1: an UNRECOGNISED field still shows its message, with no jump offered', async () => {
    validateBriefById.mockResolvedValue({
      valid: false,
      issues: [{ field: 'somethingNew', message: 'A new rule fired.' }],
      enabledChannels: [],
    } satisfies ValidationResult);
    const summary = await openAndValidate();
    const [row, ...rest] = within(summary).getAllByRole('listitem');
    expect(rest).toHaveLength(0);
    expect(row!.textContent).toBe('somethingNew: A new rule fired.');
    // We do not guess where an unknown field lives: the row holds NO control (the
    // group's only button is the Notice's Close).
    expect(within(row!).queryByRole('button')).toBeNull();
  });

  it('CB-G1: a valid brief still reports success, not an empty list', async () => {
    validateBriefById.mockResolvedValue({ valid: true, issues: [], enabledChannels: ['email_sequence'] } satisfies ValidationResult);
    const summary = await openAndValidate();
    expect(within(summary).queryAllByRole('listitem')).toHaveLength(0);
    // The success copy itself, not merely "some text" (an invalid-with-0-issues
    // render also has text), naming the enabled channel by its label.
    expect(within(summary).getByText(/Ready to generate/).textContent).toBe('Ready to generate. Channels: Email sequence.');
  });
});

describe('validation notice chrome (CC-UI-1)', () => {
  // Live on a1d1dccb7 the valid notice read "✓ ✕ ✓ Ready to generate…": a
  // leading close button plus a second status icon inside the children, on top
  // of the one Notice already renders.
  const statusIcons = (root: HTMLElement): number =>
    [...root.querySelectorAll('svg')].filter((s) => !s.closest('button')).length;

  it('valid: one status icon, message first, a trailing labelled dismiss', async () => {
    validateBriefById.mockResolvedValue({ valid: true, issues: [], enabledChannels: ['email_sequence'] } satisfies ValidationResult);
    const summary = await openAndValidate();
    const box = noticeBox(summary);
    expect(statusIcons(box)).toBe(1);
    const close = within(summary).getByRole('button', { name: 'Close' });
    expect(box.lastElementChild).toBe(close);
    expect(within(summary).getByText(/Ready to generate/).compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('group', { name: /validation result/i })).toBeNull());
  });

  it('invalid: one status icon, and the dismiss trails the issue list', async () => {
    const summary = await openAndValidate();
    const box = noticeBox(summary);
    expect(statusIcons(box)).toBe(1);
    expect(within(summary).getAllByRole('listitem')).toHaveLength(3);
    expect(box.lastElementChild).toBe(within(summary).getByRole('button', { name: 'Close' }));
  });
});

describe('validate reports on the document you are looking at', () => {
  it('CB-G2: a clean form validates WITHOUT saving', async () => {
    const summary = await openAndValidate();
    // The answer rendered (the stored brief's three issues) and no save preceded it.
    expect(within(summary).getAllByRole('listitem')).toHaveLength(3);
    expect(validateBriefById).toHaveBeenCalledExactlyOnceWith('brief-1');
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it('CB-G2: an edited form saves FIRST, so the answer is about what is on screen', async () => {
    render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
    await screen.findByRole('button', { name: /^validate$/i });

    // Edit the value prop the validator complains about.
    const valueProp = screen.getByLabelText(/value prop/i);
    fireEvent.change(valueProp, { target: { value: 'The fastest widget' } });

    // The action renames itself, so the save is disclosed rather than surprising.
    const action = await screen.findByRole('button', { name: /save & validate/i });
    fireEvent.click(action);

    await waitFor(() => expect(validateBriefById).toHaveBeenCalledTimes(1));
    // The edit reached the server BEFORE the question was asked.
    expect(updateBrief).toHaveBeenCalledTimes(1);
    const [id, payload] = updateBrief.mock.calls[0]!;
    expect(id).toBe('brief-1');
    expect(payload.messaging?.primaryValueProp).toBe('The fastest widget');
    expect(updateBrief.mock.invocationCallOrder[0]!).toBeLessThan(validateBriefById.mock.invocationCallOrder[0]!);
  });
});
