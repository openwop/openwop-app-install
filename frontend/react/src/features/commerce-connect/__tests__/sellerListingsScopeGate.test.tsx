/**
 * MPL-2 (review fold-in) — the client half of the scope gate on the seller
 * listing editor.
 *
 * MPL-2 put `workspace:write` on `PUT …/listings/:packName` and
 * `DELETE …/listings/:packName`, but the card still rendered **Save** and
 * **Unlist** to everyone: a VIEWER in a shared workspace pressed them and got the
 * raw, untranslated `Missing required scope: workspace:write` through
 * `toast.error(e.message)`. Unlist is the sharper of the two — it releases the
 * seller's claim on a pack name, which another workspace can then take.
 *
 * The pattern is `DocumentsPage.tsx:169` / `ProjectsPage.tsx:84`: presentation
 * only, backend still the authority, and — the part that is easy to drop — a
 * FAILED access read is reported as "we could not check", NOT as "you are not
 * allowed". Both hide the button; only one is a claim about the user, and
 * conflating them is the UX-DOC-3 defect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import type { EffectiveAccess } from '../../../client/accessClient.js';

const api = vi.hoisted(() => ({ listOwnListings: vi.fn() }));
const acc = vi.hoisted(() => ({ getEffectiveAccess: vi.fn() }));

vi.mock('../commerceConnectClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listOwnListings: api.listOwnListings };
});
vi.mock('../../../client/accessClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, getEffectiveAccess: acc.getEffectiveAccess };
});

import { SellerListingsCard } from '../SellerListingsCard.js';

const LISTING = { packName: 'vendor.mine.nodes', lane: 'native-paid' as const, priceMajorUnits: 40, currency: 'usd', approvalState: 'approved' as const };
const access = (scopes: string[]): EffectiveAccess => ({ roles: [], scopes: scopes as EffectiveAccess['scopes'], basis: 'member' });

beforeEach(() => {
  vi.clearAllMocks();
  api.listOwnListings.mockResolvedValue([LISTING]);
});
afterEach(cleanup);

describe('MPL-2 — Save and Unlist are gated on workspace:write', () => {
  it('an EDITOR sees both the row action and the editor Save', async () => {
    acc.getEffectiveAccess.mockResolvedValue(access(['workspace:read', 'workspace:write']));
    render(<SellerListingsCard />);
    expect(await screen.findByRole('button', { name: /unlist/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /save listing/i })).toBeTruthy();
  });

  it('a VIEWER sees NEITHER, and is told why in their own language', async () => {
    acc.getEffectiveAccess.mockResolvedValue(access(['workspace:read']));
    render(<SellerListingsCard />);
    // The ROW must still render — the gate hides actions, not the seller's
    // inventory. Without this the absence assertions could pass on an empty card.
    expect(await screen.findByText('vendor.mine.nodes')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /unlist/i })).toBeNull());
    expect(screen.queryByRole('button', { name: /save listing/i })).toBeNull();
    // Not the raw backend string, and not a silent disappearance.
    expect(screen.getByText(/read-only access/i)).toBeTruthy();
    expect(screen.queryByText(/Missing required scope/i)).toBeNull();
  });

  it('a FAILED access read hides the actions but says "could not check", never "not allowed"', async () => {
    acc.getEffectiveAccess.mockRejectedValue(new Error('access_500'));
    render(<SellerListingsCard />);
    expect(await screen.findByText('vendor.mine.nodes')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/could not check your permissions/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /save listing/i })).toBeNull();
    // The distinction is the point: an unreadable access check is not a verdict
    // about this user, and telling them they are read-only would be a false claim.
    expect(screen.queryByText(/read-only access/i)).toBeNull();
  });
});
