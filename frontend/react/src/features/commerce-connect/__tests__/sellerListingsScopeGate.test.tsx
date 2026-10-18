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
const READ_ONLY = 'You have read-only access to this workspace. Ask a workspace admin for edit access (workspace:write) to create or unlist listings.';
const ACCESS_UNKNOWN = 'We could not check your permissions, so editing is unavailable. Reload the page to try again.';
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
    // Not a silent disappearance: the exact, translated reason. Since MPL-2-INFLIGHT-1
    // the notice appears only once the access read has LANDED, so awaiting it first
    // makes the absences below post-verdict, not the in-flight default (hidden).
    // (The raw `Missing required scope` toast is unreachable here — nothing is
    // clicked — so it is not asserted; hiding the button is what prevents it.)
    expect(await screen.findByText(READ_ONLY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /unlist/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save listing/i })).toBeNull();
    expect(screen.queryByText(ACCESS_UNKNOWN)).toBeNull();
  });

  it('a FAILED access read hides the actions but says "could not check", never "not allowed"', async () => {
    acc.getEffectiveAccess.mockRejectedValue(new Error('access_500'));
    render(<SellerListingsCard />);
    expect(await screen.findByText('vendor.mine.nodes')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(ACCESS_UNKNOWN)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /save listing/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unlist/i })).toBeNull();
    // The distinction is the point: an unreadable access check is not a verdict
    // about this user, and telling them they are read-only would be a false claim.
    expect(screen.queryByText(/read-only access/i)).toBeNull();
  });
});

describe('MPL-2-INFLIGHT-1 — no verdict while the access read is in flight', () => {
  it('an editor whose access is still loading is not told they are read-only', async () => {
    let resolve!: (a: EffectiveAccess) => void;
    acc.getEffectiveAccess.mockReturnValue(new Promise<EffectiveAccess>((r) => { resolve = r; }));
    render(<SellerListingsCard />);
    expect(await screen.findByText('vendor.mine.nodes')).toBeTruthy();
    // In flight: the actions stay hidden (fail-closed), but no claim about the user.
    expect(screen.queryByText(/read-only access/i)).toBeNull();
    expect(screen.queryByText(/could not check your permissions/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /save listing/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unlist/i })).toBeNull();
    resolve(access(['workspace:read', 'workspace:write']));
    expect(await screen.findByRole('button', { name: /save listing/i })).toBeTruthy();
    expect(screen.queryByText(/read-only access/i)).toBeNull();
  });
});
