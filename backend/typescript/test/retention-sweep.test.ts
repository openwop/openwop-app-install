/**
 * ADR 0077 Phase 3 — retention sweep daemon.
 *
 * Verifies the time-based, per-(tenant, classification) sweep: deletes rows past the
 * window, leaves fresh rows, never crosses tenants, fails closed on a blank tenant,
 * audits every purge (the tombstone), treats confidential-pii as OPT-IN (no default —
 * a configured `confidentialPiiDays` window is required; ADR 0081 P5 footgun fix),
 * leases so a second same-day sweep no-ops, and is best-effort across purgers.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { processRetentionSweep, windowDaysFor } from '../src/host/retentionSweepDaemon.js';
import { registerRetentionPurger, purgeRetained, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

const DAY = 86_400_000;

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetRetentionPurgers();
});

describe('ADR 0077 §3 — windowDaysFor', () => {
  it('confidential-pii defaults to 365; internal has no default; config overrides', () => {
    expect(windowDaysFor(null, 'confidential-pii', 365)).toBe(365);
    expect(windowDaysFor(null, 'internal', null)).toBeNull();
    const policy = { tenantId: 't', retention: { confidentialPiiDays: 30, internalDays: 90 }, updatedAt: '' };
    expect(windowDaysFor(policy, 'confidential-pii', 365)).toBe(30);
    expect(windowDaysFor(policy, 'internal', null)).toBe(90);
  });
});

describe('ADR 0077 §3 — processRetentionSweep', () => {
  const now = 1_900_000_000_000; // fixed clock

  it('purges past-window rows, keeps fresh rows, audits each purge', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    const deleted: string[] = [];
    const rows = [{ id: 'old', tenantId: 'tenantA', ts: new Date(now - 400 * DAY).toISOString() },
                  { id: 'fresh', tenantId: 'tenantA', ts: new Date(now - 10 * DAY).toISOString() }];
    registerRetentionPurger({
      feature: 'analytics',
      async purge(tenantId, classification, cutoffIso) {
        if (!tenantId || classification !== 'confidential-pii') return 0;
        let n = 0;
        for (const r of rows) if (r.tenantId === tenantId && r.ts < cutoffIso) { deleted.push(r.id); n++; }
        return n;
      },
    });
    const total = await processRetentionSweep({ storage }, now);
    expect(total).toBe(1);
    expect(deleted).toEqual(['old']); // fresh row untouched
    // Audit row = the tombstone.
    const audit = await storage.listAudit({ actionPrefix: 'governance.retention' });
    const row = audit.find((a) => (a.payload as { tenantId?: string })?.tenantId === 'tenantA');
    expect(row?.outcome).toBe('success');
    expect((row?.payload as { deleted?: number }).deleted).toBe(1);
  });

  it('opt-in: a governed tenant with NO confidentialPiiDays purges NOTHING (ADR 0081 P5 footgun fix)', async () => {
    // A governance policy set for an unrelated reason (no retention window configured) must
    // NOT trigger a PII purge — the default is now opt-in, not the old implicit 365.
    await setGovernancePolicy('tenantOptIn', { providerAllowlist: ['openai'] });
    let invoked = false;
    registerRetentionPurger({
      feature: 'x',
      async purge() { invoked = true; return 1; },
    });
    const total = await processRetentionSweep({ storage }, now);
    expect(total).toBe(0);
    expect(invoked).toBe(false); // windowDaysFor → null ⇒ the purger is never even called
  });

  it('opt-in: setting confidentialPiiDays explicitly re-enables the purge', async () => {
    await setGovernancePolicy('tenantOn', { retention: { confidentialPiiDays: 365 } });
    let called = 0;
    registerRetentionPurger({ feature: 'x', async purge() { called++; return 2; } });
    const total = await processRetentionSweep({ storage }, now);
    expect(total).toBe(2);
    expect(called).toBe(1);
  });

  it('never crosses tenants', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    await setGovernancePolicy('tenantB', { retention: { confidentialPiiDays: 365 } });
    const purgedFor: string[] = [];
    registerRetentionPurger({
      feature: 'x', async purge(tenantId) { purgedFor.push(tenantId); return tenantId === 'tenantA' ? 1 : 0; },
    });
    await processRetentionSweep({ storage }, now);
    // each tenant purged with ITS OWN id only; tenantA's purge can't touch tenantB.
    expect(new Set(purgedFor)).toEqual(new Set(['tenantA', 'tenantB']));
  });

  it('fails closed: purgeRetained no-ops on a blank tenant', async () => {
    registerRetentionPurger({ feature: 'x', async purge() { return 99; } });
    expect(await purgeRetained('', 'confidential-pii', new Date(now).toISOString())).toEqual([]);
  });

  it('leases: a second same-day sweep does not double-purge', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    let calls = 0;
    registerRetentionPurger({ feature: 'x', async purge() { calls++; return 1; } });
    await processRetentionSweep({ storage }, now);
    await processRetentionSweep({ storage }, now); // same day slot → claim already taken
    expect(calls).toBe(1);
  });

  it('best-effort: a throwing purger is reported partial_failure, others still run', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    registerRetentionPurger({ feature: 'boom', async purge() { throw new Error('nope'); } });
    registerRetentionPurger({ feature: 'ok', async purge() { return 2; } });
    const total = await processRetentionSweep({ storage }, now);
    expect(total).toBe(2); // the ok purger ran despite boom throwing
    const audit = await storage.listAudit({ actionPrefix: 'governance.retention' });
    expect(audit.some((a) => a.outcome === 'partial_failure')).toBe(true);
    expect(audit.some((a) => a.outcome === 'success')).toBe(true);
  });

  it('does not purge a tenant whose classification has no window', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } }); // no internalDays
    const seen: string[] = [];
    registerRetentionPurger({ feature: 'x', async purge(_t, c) { seen.push(c); return 0; } });
    await processRetentionSweep({ storage }, now);
    expect(seen).toContain('confidential-pii');
    expect(seen).not.toContain('internal'); // no window ⇒ never invoked
  });
});

describe('GOV-3 — crash-recoverable slot lease (stale claim + completion marker)', () => {
  const now = 1_900_000_000_000; // fixed clock (same day as the suite above)
  const HOUR = 3_600_000;
  const slot = Math.floor(now / DAY);
  const startKey = (t: string, c: string) => `retention-sweep:${t}:${c}:${slot}`;
  const doneKey = (t: string, c: string) => `retention-swept:${t}:${c}:${slot}`;

  it('recovers a CRASHED holder: a STALE start-claim with NO completion marker is re-swept same day', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    // A holder claimed the slot 3h ago (> STALE_CLAIM_MS = 2h) then crashed before completing —
    // the start-claim exists but no completion marker does.
    await storage.claimIdempotency(startKey('tenantA', 'confidential-pii'), new Date(now - 3 * HOUR).toISOString());
    let invoked = 0;
    registerRetentionPurger({ feature: 'x', async purge() { invoked++; return 1; } });

    const total = await processRetentionSweep({ storage }, now);
    expect(invoked).toBe(1);   // recovered — re-swept same day, not locked until tomorrow
    expect(total).toBe(1);
    // ...and it's now marked complete, so a subsequent stale tick won't re-sweep it again.
    const marker = await storage.claimIdempotency(doneKey('tenantA', 'confidential-pii'), new Date(now).toISOString());
    expect(marker.claimed).toBe(false); // the completion marker is present
  });

  it('does NOT re-sweep a COMPLETED slot whose start-claim is merely old (no hourly re-scan)', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    // Swept 3h ago and DID complete: both the start-claim AND the completion marker exist.
    await storage.claimIdempotency(startKey('tenantA', 'confidential-pii'), new Date(now - 3 * HOUR).toISOString());
    await storage.putIdempotency({ key: doneKey('tenantA', 'confidential-pii'), responseBody: 'done', responseStatus: 200, createdAt: new Date(now - 3 * HOUR).toISOString() });
    let invoked = 0;
    registerRetentionPurger({ feature: 'x', async purge() { invoked++; return 1; } });

    await processRetentionSweep({ storage }, now);
    expect(invoked).toBe(0); // completed slot is skipped despite the stale start-claim
  });

  it('does NOT recover a FRESH start-claim (an actively-sweeping peer is left alone — GOV-5 preserved)', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    // A peer claimed the slot just now (fresh) and is mid-sweep — not stale, so no recovery.
    await storage.claimIdempotency(startKey('tenantA', 'confidential-pii'), new Date(now).toISOString());
    let invoked = 0;
    registerRetentionPurger({ feature: 'x', async purge() { invoked++; return 1; } });

    await processRetentionSweep({ storage }, now);
    expect(invoked).toBe(0); // fresh claim ⇒ skip (the peer owns it)
  });
});
