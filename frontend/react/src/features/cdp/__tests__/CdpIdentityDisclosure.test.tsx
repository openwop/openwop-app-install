/**
 * CDP-G2 / CDP-G3 (docs/steward/UX_UPGRADE-cdp.md) — what the Identity tab DISCLOSES about a
 * golden record.
 *
 *  - CDP-G2: when the resolver had to follow a merge tombstone, the record on
 *    screen is the SURVIVING one, not the record the identifier was filed under.
 *    That has to be said out loud, above the name — otherwise a different
 *    person's record reads as a direct hit. Equally: a direct hit must show NO
 *    banner, or the disclosure becomes noise people learn to skip.
 *  - CDP-G3: `verifiedAt` rides every identifier. BOTH states render, because
 *    absence is the meaningful one (nobody confirmed this identifier).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { currentAnnouncements } from '../../../ui/announce.js';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { GoldenRecord } from '../../../client/cdpClient.js';

let resolved: GoldenRecord | null = null;
let rejectNext = false;
vi.mock('../../../client/cdpClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveIdentity: vi.fn(async () => {
    if (rejectNext) { rejectNext = false; throw new Error('boom'); }
    return resolved;
  }),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { CdpConsolePage } from '../CdpConsolePage.js';

const BASE: GoldenRecord = {
  contact: { contactId: 'crm:survivor-1', name: 'Ada Lovelace', email: 'ada@acme.test', stage: 'lead' },
  identifiers: [],
  resolvedBy: { type: 'loyalty', value: 'LOY-1' },
};

async function lookUp(): Promise<void> {
  render(<CdpConsolePage />);
  // Let the mount effects flush before dispatching — a change fired ahead of
  // them is DROPPED, not merely late, and no amount of waitFor recovers it.
  await act(async () => {});
  fireEvent.change(screen.getByLabelText(/value/i), { target: { value: 'LOY-1' } });
  fireEvent.click(screen.getByRole('button', { name: /resolve/i }));
  await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
}

beforeEach(() => { resolved = BASE; rejectNext = false; });
afterEach(cleanup);

describe('CDP identity disclosure', () => {
  it('a direct hit shows NO merge banner', async () => {
    await lookUp();
    expect(screen.queryByText(/merged/i)).toBeNull();
  });

  it('a followed merge is disclosed, with the record the identifier was filed under', async () => {
    resolved = { ...BASE, mergedFrom: { contactId: 'crm:tombstone-9' } };
    await lookUp();
    // Said out loud …
    expect(screen.getByText(/surviving record/i)).toBeTruthy();
    // … and the merged-away id is on screen so it can be looked up directly.
    expect(screen.getByText('crm:tombstone-9')).toBeTruthy();
    // R2 CD-SP-5 — ACTUALLY announced: the banner now rides the Notice
    // `announce` prop, which delegates to the ADR 0363 global announcer and
    // (by design) renders no role of its own. The old assertion pinned a
    // role=status that never spoke (mounted WITH content — the documented
    // Notice trap); this pins the words reaching the announcer.
    expect(currentAnnouncements().polite).toMatch(/surviving record/i);
  });

  it('renders the verified date when an identifier carries one', async () => {
    resolved = {
      ...BASE,
      identifiers: [{ type: 'loyalty', value: 'LOY-1', source: 'import', verifiedAt: '2026-03-04T10:00:00.000Z' }],
    };
    await lookUp();
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(screen.queryByText(/unverified/i)).toBeNull();
  });

  it('says UNVERIFIED rather than going quiet when no one confirmed the identifier', async () => {
    resolved = {
      ...BASE,
      identifiers: [{ type: 'loyalty', value: 'LOY-1', source: 'form' }],
    };
    await lookUp();
    // The absence of a verification is the fact that matters here; a blank
    // would read as "verified" to anyone scanning the row.
    expect(screen.getByText(/unverified/i)).toBeTruthy();
  });
});

describe('R2 round-2 — lookup truth + disclosure parity', () => {
  it('CD-SP-1: a FAILED second lookup never co-renders the previous customer (the record clears)', async () => {
    await lookUp();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    rejectNext = true;
    fireEvent.change(screen.getByLabelText(/value/i), { target: { value: 'OTHER-9' } });
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).toBeNull());
    // The error shows; the OLD record (and its resolvedBy chip) is gone.
    expect(screen.queryByText(/LOY-1/)).toBeNull();
  });

  it('CDP-G5: a masked record renders the masked notice; an unmasked one does not', async () => {
    resolved = { ...BASE, masked: true };
    await lookUp();
    expect(screen.getByText(/pseudonymized for your access level/i)).toBeTruthy();
    cleanup();
    resolved = BASE;
    await lookUp();
    expect(screen.queryByText(/pseudonymized/i)).toBeNull();
  });

  it('CD-SP-3: phone/title/owner/leadSource render, and absence is LABELED (— not a vanished row)', async () => {
    resolved = { ...BASE, contact: { ...BASE.contact, phone: '+1 555 0100', title: 'CTO', owner: 'sam@acme.test' } };
    await lookUp();
    expect(screen.getByText('+1 555 0100')).toBeTruthy();
    expect(screen.getByText('CTO')).toBeTruthy();
    expect(screen.getByText('sam@acme.test')).toBeTruthy();
    // leadSource absent → the LABEL still renders with an em-dash.
    expect(screen.getByText(/lead source/i)).toBeTruthy();
  });

  it('CD-SP-3: customFields render when present (agent-settable was invisible)', async () => {
    resolved = { ...BASE, contact: { ...BASE.contact, customFields: { plan: 'enterprise' } } };
    await lookUp();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('enterprise')).toBeTruthy();
  });
});

