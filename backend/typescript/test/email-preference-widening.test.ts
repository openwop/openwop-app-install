/**
 * ADR 0655 D3 (EMWF-3 / EM-UX-23 / EM-UX-24) — the preference-center token can
 * NARROW consent forever and WIDEN it only when the link is fresh and the address
 * is clean; it never clears an erasure tombstone.
 *
 * Born red on the pre-ADR route: every leg below that expects 409 answered 200
 * "Your preferences have been saved." — and the tombstone leg CLEARED the tombstone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { mintToken, __setTokenCreatedAtForTests } from '../src/features/email/engagementService.js';
import { getConsent, isAllowed, recordConsent, deleteSubject, isErasureTombstoned, __resetConsentStore } from '../src/features/consent/consentService.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';

let BASE = '';
let server: http.Server;
const T = 'tPrefWiden';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('consent'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await __resetConsentStore();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const post = async (token: string, body: string): Promise<{ status: number; text: string }> => {
  const res = await fetch(`${BASE}/v1/host/openwop-app/public-email/p/${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  return { status: res.status, text: await res.text() };
};
const fresh = async (contactId: string, email?: string): Promise<string> =>
  mintToken({ tenantId: T, campaignId: `cmp-${n++}`, contactId, kind: 'preferences', ...(email ? { email } : {}) });
const backdate = async (token: string, days: number): Promise<void> =>
  __setTokenCreatedAtForTests(token, new Date(Date.now() - days * 86_400_000).toISOString());

describe('ADR 0655 D3 — preference-center widening', () => {
  it('a FRESH clean link may WIDEN (first-time opt-in from an absent record) → 200 saved', async () => {
    const ct = 'ct-fresh'; const tok = await fresh(ct, 'fresh@example.com');
    const r = await post(tok, 'email=on');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Your preferences have been saved.');
    expect(await isAllowed(T, ct, 'marketing.email')).toBe(true);
  });

  it('a STALE link may NOT widen → 409 refused, consent unchanged; the same stale link may still NARROW → 200', async () => {
    const ct = 'ct-stale';
    await recordConsent({ tenantId: T, subjectKey: ct, categories: { marketing: true, 'marketing.email': false, 'marketing.sms': true }, source: 'test' });
    const tok = await fresh(ct, 'stale@example.com');
    await backdate(tok, 31);
    const widen = await post(tok, 'email=on&sms=on');
    expect(widen.status, widen.text.slice(0, 300)).toBe(409);
    expect(widen.text).toContain('too old to turn messages back on');
    expect(widen.text).toContain('role="alert"');
    expect(widen.text).not.toContain('Your preferences have been saved.');
    expect(await isAllowed(T, ct, 'marketing.email'), 'the refused widening wrote nothing').toBe(false);
    expect(await isAllowed(T, ct, 'marketing.sms'), 'and touched nothing else').toBe(true);
    // Narrowing from the same stale link: an effective no-op on email, and sms off — accepted.
    const narrow = await post(tok, '');
    expect(narrow.status).toBe(200);
    expect(await isAllowed(T, ct, 'marketing.sms')).toBe(false);
  });

  it('an effective NO-OP on a stale link is not a widening (specific absent, umbrella on) → 200', async () => {
    const ct = 'ct-umbrella';
    await recordConsent({ tenantId: T, subjectKey: ct, categories: { marketing: true }, source: 'test' });
    const tok = await fresh(ct, 'umb@example.com');
    await backdate(tok, 400);
    // email/sms/push are all EFFECTIVELY on through the umbrella; submitting all three on widens nothing.
    const r = await post(tok, 'email=on&sms=on&push=on');
    expect(r.status, r.text.slice(0, 200)).toBe(200);
  });

  it('a SUPPRESSED address may NOT widen even from a fresh link → 409 (EM-UX-23: never "saved" over a re-grant that cannot deliver)', async () => {
    const ct = 'ct-supp';
    await addSuppression(T, 'supp@example.com', 'unsubscribed', `contact:${ct}`, 'test');
    const tok = await fresh(ct, 'supp@example.com');
    const r = await post(tok, 'email=on');
    expect(r.status).toBe(409);
    expect(r.text).toContain('cannot be turned back on from this link');
    expect(r.text).toContain('reply to the sender');
    expect(await isAllowed(T, ct, 'marketing.email')).toBe(false);
  });

  it('a row with NO address cannot run the suppression leg → widening refused', async () => {
    const ct = 'ct-noemail';
    const tok = await fresh(ct);
    expect((await post(tok, 'email=on')).status).toBe(409);
  });

  it('an ERASED subject: the DSAR erases the link itself (404); a token minted AFTER erasure may narrow but never un-erase, and may not widen', async () => {
    const ct = 'ct-erased';
    await recordConsent({ tenantId: T, subjectKey: ct, categories: { marketing: true, 'marketing.email': true }, source: 'test' });
    const before = await fresh(ct, 'erased@example.com');
    await deleteSubject(T, ct);
    expect(await isErasureTombstoned(T, ct)).toBe(true);
    // The erasure fan-out deleted the engagement token row: the old link is DEAD, not refused.
    // (This test's first draft expected 409 here — the premise was wrong, the code was right.)
    expect((await post(before, 'email=on')).status).toBe(404);
    // A later campaign that still references the erased contactId (the only way a live
    // token can name a tombstoned subject) mints a fresh token:
    const after = await fresh(ct, 'erased@example.com');
    // Effective values are all off (no record) ⇒ "email=on" is a widening ⇒ refused on the tombstone.
    const widen = await post(after, 'email=on');
    expect(widen.status, widen.text.slice(0, 200)).toBe(409);
    expect(await isErasureTombstoned(T, ct), 'a refused widening never touches the tombstone').toBe(true);
    expect(widen.text, 'ADR 0657 D7 — the truth, not an instruction nobody can honour').toContain('removed at your request');
    expect(widen.text).not.toContain('reply to the sender');
    // Narrowing (all off) on an ERASED subject: ADR 0657 D10 — the write barrier refuses it
    // (there is nothing to manage; the tombstone already denies everything), and the page
    // says so instead of "saved" over a write that never landed. No row, tombstone intact.
    const narrow = await post(after, '');
    expect(narrow.status, narrow.text.slice(0, 200)).toBe(409);
    expect(narrow.text).toContain('removed at your request');
    expect(await isErasureTombstoned(T, ct), 'a public form never un-erases').toBe(true);
    expect(await getConsent(T, ct), 'and never re-inserts the erased record').toBeNull();
  });
});
