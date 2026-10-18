/**
 * DEF-1 (CODEBASE-ASSESSMENT) — AuditLogPage designed states: rows render, a
 * 403 becomes the honest superadmin StateCard (never a blank), an empty
 * result gets its designed empty state, and a network failure surfaces as an
 * error notice.
 *
 * Stubbed at the FETCH level (not a governanceClient module mock) so the real
 * `listAudit` — its query building, `{items}` unwrap, and ApiError throw path
 * — runs under test. (A module-level vi.fn returning a naked rejected promise
 * also trips the runner's unhandled-rejection tracking on every test after
 * the first; fetch-level stubbing sidesteps that entirely.)
 *
 * Sabotage that turns it red: request another path; render the raw outcome enum; let
 * `loadFailed` outrank `forbidden`; key the superadmin state on 401; drop the error
 * Notice; skip the failed-read card or its Retry; drop the empty card.
 *
 * Twins (protected, kept): DEF-1 "403 …" and AU-G1 "a 403 still gets …" both settle on
 * the superadmin card — DEF-1 owns its BODY + the still-offered export, AU-G1 owns the
 * failed-read card's absence. DEF-1 "empty result" and AU-G1 "a genuinely empty log"
 * both reach the empty card — DEF-1 owns its BODY + no Retry, AU-G1 owns the failed
 * card's absence.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AuditLogPage } from '../AuditLogPage.js';
import type { AuditRecord } from '../../client/governanceClient.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ROW: AuditRecord = {
  timestamp: '2026-07-03T12:00:00.000Z',
  principalId: 'user-1',
  action: 'assistant.dispatch',
  resource: 'run:r-1',
  outcome: 'success',
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AuditLogPage states (DEF-1)', () => {
  it('renders audit rows from the governance route', async () => {
    const fn = vi.fn(async (_url: string): Promise<Response> => jsonResponse(200, { items: [ROW] }));
    vi.stubGlobal('fetch', fn);
    render(<AuditLogPage />);
    expect(await screen.findByText('assistant.dispatch')).toBeTruthy();
    const url = new URL(fn.mock.calls[0]![0], 'http://localhost');
    expect(url.pathname).toBe('/host/openwop-app/governance/audit');
    expect(url.searchParams.get('actionPrefix')).toBe('');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(screen.getByText('user-1')).toBeTruthy();
    // Outcome chips are localized (§4.5 kit) — the raw 'success' enum renders as its label.
    expect(screen.getByText('Success')).toBeTruthy();
  });

  it('403 renders the honest superadmin StateCard, never a blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: { code: 'forbidden' } })));
    render(<AuditLogPage />);
    expect(await screen.findByText('Superadmin access required')).toBeTruthy();
    expect(screen.getByText(/The audit log is a governance surface/)).toBeTruthy();
    // ADR 0416 P3 — the chain export is tenant-admin authority, still offered here.
    expect(screen.getByRole('button', { name: 'Export JSONL' })).toBeTruthy();
    expect(screen.queryByText('assistant.dispatch')).toBeNull();
  });

  it('empty result renders the designed empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: [] })));
    render(<AuditLogPage />);
    expect(await screen.findByText('No audited actions match')).toBeTruthy();
    expect(screen.getByText(/Try clearing the prefix filter or raising the row limit/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a network failure surfaces as an error notice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('backend unreachable'); }));
    render(<AuditLogPage />);
    expect(await screen.findByText('backend unreachable')).toBeTruthy();
  });
});

/**
 * AU-G1 — a failed audit read must not render the "adjust your filter" card.
 *
 * The page already avoids the loading-sentinel trap (it sets `rows` on failure
 * rather than leaving it `null`), but the value it set was `[]` — which renders
 * "No audited actions match — try clearing the prefix filter or raising the row
 * limit". That is an INSTRUCTIVE empty state, and it implies the read succeeded
 * and simply matched nothing. On an audit surface that is the worst thing to
 * imply: an operator checking whether an action was logged is told to adjust
 * their filter.
 */
describe('AU-G1 — a failed read is not an empty audit log', () => {
  it('does not tell the operator to adjust their filter — it says the read failed, and Retry re-reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => { throw new Error('network down'); }));
    render(<AuditLogPage />);
    expect(await screen.findByText('Could not load the audit log')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
    expect(screen.queryByText('No audited actions match')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: [ROW] })));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('assistant.dispatch')).toBeTruthy();
    expect(screen.queryByText('Could not load the audit log')).toBeNull();
  });

  it('a genuinely empty log still gets its designed empty state', async () => {
    // The failure mode of this fix is costing the real empty state its meaning —
    // and its call to action, which is the useful part of it.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: [] })));
    render(<AuditLogPage />);
    expect(await screen.findByText('No audited actions match')).toBeTruthy();
    expect(screen.queryByText('Could not load the audit log')).toBeNull();
  });

  it('a 403 still gets the superadmin state, not the failed-read one', async () => {
    // Forbidden is a real answer about permissions, not a failed read.
    //
    // This case USED to settle on `findByRole('heading', {level: 1})` and then
    // assert only the ABSENCE of the failed-read card. Both halves were wrong:
    // the PageHeader's h1 paints on the first render, BEFORE the fetch resolves,
    // so the await proved nothing had happened yet — and at that moment the
    // failed-read card is legitimately absent, so the assertion passed against
    // an un-settled tree. It would have stayed green with the branch inverted.
    //
    // It matters here more than anywhere: `AuditLogPage.tsx:61-62` runs
    // `setRows([]); setLoadFailed(true)` UNCONDITIONALLY — the 403 branch sets
    // BOTH `forbidden` and `loadFailed`. The only thing keeping the failed-read
    // card off a 403 is the render-branch ORDER (`forbidden ?` wraps everything
    // else), which is exactly what this case claims to guard.
    //
    // So: a POSITIVE assertion, anchored on copy that can only exist once the
    // read has settled into the forbidden branch.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'forbidden', message: 'nope' })));
    render(<AuditLogPage />);
    expect(await screen.findByText('Superadmin access required')).toBeTruthy();
    expect(screen.queryByText('Could not load the audit log')).toBeNull();
  });
});
