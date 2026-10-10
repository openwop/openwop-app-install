/**
 * ADR 0826 — the marketplace card never offers a control the server refuses this
 * caller (D1), shows the server's trust verdict rather than inferring "verified"
 * from a marker's presence (D6), and the revoke dialog arms only with a reason (D5).
 *
 * View-level, like `curationUnknown.test.tsx`: the guarantees are what the user
 * sees, and a page-level harness would test fixture completeness instead.
 *
 * Sabotage-witnessed (/grade-tests wave 10): forcing `canCurate`/`canAdminister`
 * true reds the VIEWER/EDITOR cases; dropping `revoked` from Install's `disabled`
 * reds the OPERATOR case; mislabelling a tier reds its chip case; the dialog's
 * reason gate, trim, `*` scope and blast-radius notice each red their case; and
 * `revocationsCovering`'s wildcard / packName legs red the lift cases.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ListingCard } from '../MarketplaceViews.js';
import { RevokePackDialog } from '../RevokePackDialog.js';
import { revocationsCovering, type Listing, type MarketplaceViewer, type PackRevocation } from '../marketplaceClient.js';

const base: Listing = {
  packName: 'community.demo.pack',
  version: '1.2.3',
  title: 'Demo',
  category: 'node',
  installed: true,
  origin: 'registry',
  trust: { tier: 'operator-trusted', reason: 'install_marker_verified' },
};

const props = (listing: Listing, viewer: MarketplaceViewer | null) => ({
  listing,
  busy: false,
  wsDisabled: false,
  curationUnknown: false,
  viewer,
  onReviews: vi.fn(),
  onInstall: vi.fn(),
  onToggleAvailability: vi.fn(),
  onRemove: vi.fn(),
  onRestore: vi.fn(),
  onPurge: vi.fn(),
  onPurchase: vi.fn(),
  onRevoke: vi.fn(),
  onUnrevoke: vi.fn(),
});

const view = (listing: Listing, viewer: MarketplaceViewer | null) =>
  render(<MemoryRouter><ListingCard {...props(listing, viewer)} /></MemoryRouter>);

afterEach(cleanup);

describe('ADR 0826 D1 — controls follow the caller’s server-computed capabilities', () => {
  it('a VIEWER sees an inert availability switch and no operator actions', () => {
    view(base, { canCurate: false, canAdminister: false });
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /remove community\.demo\.pack/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /revoke community\.demo\.pack/i })).toBeNull();
  });

  it('an EDITOR curates but still gets no operator actions', () => {
    view(base, { canCurate: true, canAdminister: false });
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });

  it('an OPERATOR gets Revoke; a revoked pack offers the lift instead, and cannot be installed', () => {
    const { unmount } = view(base, { canCurate: true, canAdminister: true });
    expect(screen.getByRole('button', { name: /revoke community\.demo\.pack/i })).toBeTruthy();
    unmount();
    view({ ...base, installed: false, trust: { tier: 'revoked', reason: 'revoked_by_operator' } }, { canCurate: true, canAdminister: true });
    expect(screen.getByRole('button', { name: /lift the revocation of community\.demo\.pack/i })).toBeTruthy();
    expect((screen.getByRole('button', { name: /^install$/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ADR 0826 D6 — the trust chip is the server’s verdict', () => {
  it.each([
    ['steward', /ships with this app/i],
    ['operator-trusted', /signature verified/i],
    ['untrusted', /unverified/i],
    ['revoked', /revoked/i],
  ] as const)('%s renders its own chip', (tier, label) => {
    view({ ...base, trust: { tier, reason: 'x' } }, null);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });
});

describe('ADR 0826 D5 — the revoke dialog', () => {
  it('names the blast radius, and arms only once a reason is typed', () => {
    const onConfirm = vi.fn();
    render(<RevokePackDialog listing={{ ...base, requiredBy: ['crm'] }} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    expect(screen.getByText('These features pin this pack and will stop working: crm.')).toBeTruthy();
    const go = screen.getByRole('button', { name: /^revoke$/i }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  compromised key  ' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onConfirm).toHaveBeenCalledWith('1.2.3', 'compromised key');
  });

  it('“every version” revokes `*`', () => {
    const onConfirm = vi.fn();
    render(<RevokePackDialog listing={base} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /every version/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'publisher compromised' } });
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
    expect(onConfirm).toHaveBeenCalledWith('*', 'publisher compromised');
  });
});

describe('ADR 0826 — “Lift revocation” never claims a lift that cannot happen', () => {
  const row = (packName: string, version: string): PackRevocation => ({ key: `${packName}@${version}`, packName, version, revokedAt: '', revokedBy: 'op', reason: 'r' });
  it('lifts the exact version AND a wildcard row, nothing else', () => {
    const rows = [row('community.demo.pack', '1.2.3'), row('community.demo.pack', '*'), row('community.demo.pack', '1.2.4'), row('other.pack', '1.2.3')];
    expect(revocationsCovering(base, rows).map((r) => r.key)).toEqual(['community.demo.pack@1.2.3', 'community.demo.pack@*']);
  });
  it('a pack revoked only by static config has NOTHING to lift (returns [])', () => {
    expect(revocationsCovering(base, [row('other.pack', '1.2.3')])).toEqual([]);
  });
});

