/**
 * RI-3 (grade-data 2026-07-06, docs/steward/DATA-ASSESSMENT.md) — the PII-declared stores that
 * lacked lifecycle registrations get them, exercised through the REAL seams:
 *
 *  - users.user: a DSAR via `consentService.deleteSubject` (→ `eraseSubject` fan-out)
 *    SCRUBS the declared PII fields (email/displayName) in place and keeps the opaque
 *    auth skeleton (userId/principalId) — it must NOT delete the row (replay/display
 *    resolution depend on it), and must be tenant-guarded + idempotent.
 *  - intentLedger.entry: a retention sweep via `purgeRetained` deletes ledgers older
 *    than the cutoff for the owning tenant only, keyed on `createdAt`, and no-ops on
 *    a non-PII classification (fail-closed).
 *
 * strategy.record and insights.talentSnapshot are DELIBERATE non-registrations
 * (documented stances in their services) — no tests assert their absence beyond the
 * fan-out not touching them here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { createUser, getUser } from '../src/features/users/usersService.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import { saveLedger, getLedger } from '../src/features/intent-ledger/ledgerStore.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

let server: Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

function ledger(tenantId: string, conversationId: string, createdAt: string): IntentLedger {
  return {
    ledgerId: `led-${conversationId}`,
    tenantId,
    conversationId,
    goal: 'summarize the quarterly pipeline for Dana',
    allowed: [],
    forbidden: [],
    requireApproval: [],
    successCriteria: [],
    status: 'draft',
    proposedBy: 'extractor',
    createdAt,
  };
}

describe('users.user DSAR eraser (scrub-in-place)', () => {
  it('scrubs email/displayName via consent deleteSubject, keeps the auth skeleton', async () => {
    const u = await createUser({ tenantId: 't-erase', principalId: 'oidc:erase-1', email: 'dana@example.com', displayName: 'Dana Reyes' });
    await deleteSubject('t-erase', u.userId);
    const after = await getUser(u.userId);
    expect(after).not.toBeNull(); // the row survives — anonymize, not delete
    expect(after!.email).toBeUndefined();
    expect(after!.displayName).toBeUndefined();
    expect(after!.principalId).toBe('oidc:erase-1'); // auth join key intact
    expect(after!.tenantId).toBe('t-erase');
  });

  it('is tenant-guarded (a foreign-tenant DSAR does not scrub) and idempotent', async () => {
    const u = await createUser({ tenantId: 't-owner', principalId: 'oidc:erase-2', email: 'kai@example.com', displayName: 'Kai' });
    await deleteSubject('t-other', u.userId); // wrong tenant — fail-closed no-op
    let after = await getUser(u.userId);
    expect(after!.email).toBe('kai@example.com');

    await deleteSubject('t-owner', u.userId);
    await deleteSubject('t-owner', u.userId); // second pass finds nothing to scrub
    after = await getUser(u.userId);
    expect(after!.email).toBeUndefined();
    expect(after!.displayName).toBeUndefined();
  });
});

describe('intentLedger.entry retention purger', () => {
  it('purges only rows older than the cutoff, only for the named tenant', async () => {
    await saveLedger(ledger('t-ret', 'conv-old', iso(120)));
    await saveLedger(ledger('t-ret', 'conv-new', iso(1)));
    await saveLedger(ledger('t-bystander', 'conv-old-foreign', iso(120)));

    const results = await purgeRetained('t-ret', 'confidential-pii', iso(90));
    const mine = results.find((r) => r.feature === 'intent-ledger');
    expect(mine?.ok).toBe(true);
    expect(mine?.deleted).toBeGreaterThanOrEqual(1);

    expect(await getLedger('t-ret', 'conv-old')).toBeNull(); // aged out
    expect(await getLedger('t-ret', 'conv-new')).not.toBeNull(); // retained
    expect(await getLedger('t-bystander', 'conv-old-foreign')).not.toBeNull(); // foreign tenant untouched
  });

  it('fails closed on a non-PII classification', async () => {
    await saveLedger(ledger('t-class', 'conv-x', iso(120)));
    const results = await purgeRetained('t-class', 'internal', iso(90));
    const mine = results.find((r) => r.feature === 'intent-ledger');
    expect(mine?.deleted).toBe(0);
    expect(await getLedger('t-class', 'conv-x')).not.toBeNull();
  });
});
