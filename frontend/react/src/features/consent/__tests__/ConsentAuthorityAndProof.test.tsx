/**
 * ADR 0849 D1 / D3 / D6 — the console is role-aware and shows the proof.
 *
 *  - A NON-ADMIN (`canManage:false`) sees the regime read-only and is offered no
 *    lookup, no erase and no ledger, and the page never fires the ledger read
 *    the server would refuse (architect M4).
 *  - An UNKNOWN answer (the access read failed) never hides the DSAR console —
 *    the server's 403 decides (architect B1).
 *  - With the toggle OFF an admin still gets the data-subject panel (CONS-5).
 *  - A lookup renders the record's consent history, and a legacy row says it has
 *    none instead of inventing one.
 *
 * Sabotage-witnessed (/grade-tests w9): dropping `if (can === false) return` fires the
 * ledger read for a member; mapping a failed access read to `false` instead of `null`
 * hides the DSAR console (B1); reading the STORED channel literal instead of the
 * effective grant (`effective()`) reds CN2UX-3, `renders each change` and N2; and
 * dropping the gap/region/source/legacy branches reds their cases. The CONS-5
 * toggle-off case lives in ConsentLookupHonesty (the stronger of two copies).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import type { ConsentRecord } from '../consentClient.js';

let access: { canManage: boolean } | Error = { canManage: true };
let regimeEnabled = true;
const listRecords = vi.fn();
const getSubject = vi.fn();

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getPolicy: vi.fn(async () => ({ policy: { tenantId: 't', regulatedRegions: ['EU'], defaultMode: 'opt-in' }, legalHold: null })),
  getAccess: vi.fn(async () => { if (access instanceof Error) throw access; return access; }),
  listRecords: (...a: unknown[]) => listRecords(...a),
  getSubject: (...a: unknown[]) => getSubject(...a),
  deleteSubject: vi.fn(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: regimeEnabled, locked: false, loading: false, status: (regimeEnabled ? 'on' : 'off') as 'on' | 'off', isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ConsentPage } from '../ConsentPage.js';

beforeEach(() => {
  access = { canManage: true };
  regimeEnabled = true;
  listRecords.mockReset();
  listRecords.mockImplementation(async () => []);
  getSubject.mockReset();
});
afterEach(cleanup);

async function settle(): Promise<void> {
  render(<ConsentPage />);
  await act(async () => {});
  await act(async () => {});
}

describe('D1/D6 — a non-admin sees the regime, not the controls', () => {
  it('policy read-only, no lookup/erase, no ledger — and the ledger read is never fired', async () => {
    access = { canManage: false };
    await settle();
    // CN2UX-9 — ONE statement of the member view, not a line per card.
    await screen.findByText(/viewing as a member/i);
    // CN2UX-1 — read as a definition list: no inputs, no placeholder posing as a value.
    expect(screen.queryByLabelText(/regulated regions/i)).toBeNull();
    expect(screen.getByText('EU')).toBeTruthy();
    expect(screen.getByText(/opt-in \(fail-closed\)/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save policy/i })).toBeNull();
    expect(screen.queryByLabelText(/subject key/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^erase$/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /consent records/i }), 'no ledger card').toBeNull();
    expect(listRecords).not.toHaveBeenCalled();
    expect(screen.queryByText(/couldn.t load consent records/i), 'never the failed-read card').toBeNull();
  });

  it('an admin gets every control and the ledger', async () => {
    await settle();
    await screen.findByLabelText(/subject key/i);
    expect(screen.getByRole('button', { name: /save policy/i })).toBeTruthy();
    expect(listRecords).toHaveBeenCalledTimes(1);
  });

  it('architect B1 — an UNKNOWN answer (access read failed) keeps the DSAR console', async () => {
    access = new Error('network');
    await settle();
    await screen.findByLabelText(/subject key/i);
    expect(listRecords).toHaveBeenCalledTimes(1);
  });
});

describe('D3/D6 — the lookup shows the proof', () => {
  const lookUp = async (key: string): Promise<void> => {
    await settle();
    const input = await screen.findByLabelText(/subject key/i);
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
  };

  it('renders each change newest-first: what was granted or withdrawn, and through what', async () => {
    const cats = (m: boolean, sms?: boolean) => ({ necessary: true as const, analytics: false, marketing: m, ...(sms === undefined ? {} : { 'marketing.sms': sms }) });
    const record: ConsentRecord = {
      subjectKey: 'ada@x.test', categories: cats(false, false), ts: '2026-10-03T00:00:00.000Z', source: 'unsubscribe',
      history: [
        { ts: '2026-10-03T00:00:00.000Z', source: 'unsubscribe', categories: cats(false, false) },
        { ts: '2026-10-02T00:00:00.000Z', source: 'preference-center', categories: cats(true, false) },
        { ts: '2026-10-01T00:00:00.000Z', source: 'form-optin:f1', categories: cats(true) },
      ],
    };
    getSubject.mockImplementation(async () => ({ record, erased: false }));
    await lookUp('ada@x.test');
    await screen.findByText(/consent history — 3 entries/i);
    // Entry 2 withdrew SMS explicitly (the umbrella was still on); entry 1 withdrew the umbrella.
    expect(screen.getByText(/withdrawn: marketing/i)).toBeTruthy();
    expect(screen.getByText(/withdrawn: sms/i)).toBeTruthy();
    expect(screen.getByText(/first recorded/i)).toBeTruthy();
    // CN2UX-7 — the capture kind in words, the id as code.
    expect(screen.getByText(/via form opt-in/i)).toBeTruthy();
    expect(screen.getByText('f1').tagName).toBe('CODE');
  });

  it('CN2UX-3 — a channel that FOLLOWS the umbrella is not reported as its own change', async () => {
    const record: ConsentRecord = {
      subjectKey: 'u', categories: { necessary: true, analytics: false, marketing: false }, ts: '2026-10-02T00:00:00.000Z', source: 'unsubscribe',
      history: [
        { ts: '2026-10-02T00:00:00.000Z', source: 'unsubscribe', categories: { necessary: true, analytics: false, marketing: false } },
        { ts: '2026-10-01T00:00:00.000Z', source: 'public:o1', categories: { necessary: true, analytics: false, marketing: true } },
        // An explicit channel somewhere in the log makes `email` a DIFFED key (historyKeys
        // derives keys from the entries). Without it no channel could ever be reported and
        // this case could not fail (/grade-tests w9 probe).
        { ts: '2026-09-30T00:00:00.000Z', source: 'form-optin:f9', categories: { necessary: true, analytics: false, marketing: true, 'marketing.email': true } },
      ],
    };
    getSubject.mockImplementation(async () => ({ record, erased: false }));
    await lookUp('u');
    await screen.findByText(/withdrawn: marketing/i);
    // The middle entry: umbrella still on, email ABSENT — it FOLLOWS the umbrella, so its
    // effective grant did not move. Never "Withdrawn: Email" (the stored-literal reading).
    const middle = screen.getAllByRole('listitem')[1]!;
    expect(within(middle).getByText(/no change in effect/i)).toBeTruthy();
    expect(within(middle).queryByText(/withdrawn: email/i)).toBeNull();
    expect(screen.getByText(/via public consent capture/i)).toBeTruthy();
  });

  it('N2 — a removal is a change, and an entry with no effect says so (never just a date and a source)', async () => {
    const c = { necessary: true, analytics: false, marketing: true };
    const record: ConsentRecord = {
      subjectKey: 'r', categories: c, ts: '2026-10-03T00:00:00.000Z', source: 'workflow:r3',
      history: [
        { ts: '2026-10-03T00:00:00.000Z', source: 'workflow:r3', categories: { ...c, 'marketing.sms': true } },
        { ts: '2026-10-02T00:00:00.000Z', source: 'workflow:r2', categories: c },
        { ts: '2026-10-01T00:00:00.000Z', source: 'workflow:r1', categories: c, region: 'EU' },
      ],
    };
    getSubject.mockImplementation(async () => ({ record, erased: false }));
    await lookUp('r');
    await screen.findByText(/region cleared/i);
    expect(screen.getByText(/no change in effect/i), 'sms:true under an umbrella that already granted it').toBeTruthy();
  });

  it('CN2UX-5 / CN2CD-4 — a bounded-out stretch is shown as a gap, and long logs collapse', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 0, 25 - i)).toISOString(), source: `workflow:r${25 - i}`,
      categories: { necessary: true, analytics: i % 2 === 0, marketing: false },
    }));
    getSubject.mockImplementation(async () => ({
      record: { subjectKey: 'b', categories: entries[0]!.categories, ts: entries[0]!.ts, source: entries[0]!.source, history: entries, historyDropped: 7 },
      erased: false,
    }));
    await lookUp('b');
    await screen.findByText(/consent history — 25 entries/i);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: /show all 25/i }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
    expect(screen.getByText(/7 earlier changes were not kept/i)).toBeTruthy();
    // The entry above the gap shows its full STATE — never a diff across dropped changes.
    expect(screen.getByText(/^state:$/i)).toBeTruthy();
  });

  it('a legacy record says it has no history instead of inventing one', async () => {
    getSubject.mockImplementation(async () => ({
      record: { subjectKey: 'old', categories: { necessary: true, analytics: true, marketing: false }, ts: '2026-01-01T00:00:00.000Z', source: 'public' },
      erased: false,
    }));
    await lookUp('old');
    await screen.findByText(/current state only/i);
  });
});
