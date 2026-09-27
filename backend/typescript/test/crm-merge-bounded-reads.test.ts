/**
 * CRM-11 — the merge/unmerge relink path must never issue a cross-tenant scan.
 *
 * `deals.ts` was fixed to read its tenant slice; its two siblings were not, and
 * `entities/tasks.ts` + `entities/activities.ts` kept calling the bare `.list()` —
 * ONE `kvList` over the whole collection, ALL TENANTS — twelve times between them,
 * each followed by per-row writes. So a single `POST /contacts/:id/merge` fanned
 * out four-plus full-collection reads. Both collections already had `tenantOf`
 * armed, so the bounded read was available the whole time, and
 * `host/crmRecordLifecycle.ts` states outright that handlers "MUST bound their
 * work (indexed/point reads — never a cross-tenant scan)".
 *
 * Asserted at the STORAGE layer rather than by counting call sites: a source-grep
 * test would pass the moment someone re-spelt the call, and what matters is the
 * key space actually read. The probe records every `kvList` prefix the merge
 * issues, so a re-introduced whole-collection scan is visible as the prefix that
 * carries no tenant.
 *
 * FOLD-IN B4 — this gate was an ALLOWLIST, and it walked straight past a live
 * offender. It filtered for exactly two literals (`hostext:crm:task:`,
 * `hostext:crm:activity:`), so when CRM-5 registered a NEW merge handler
 * (`email-sendlog-relink`) that did `for (const s of await sendLogs.list())` — every
 * tenant's send ledger, on the merge hot path, in the same change that quoted the
 * seam's "never a cross-tenant scan" contract — the probe OBSERVED
 * `hostext:email:sendlog:` and discarded it. A gate that only recognises the
 * offences already fixed cannot catch the next one.
 *
 * It is now inverted: NO unbounded whole-collection prefix may be scanned during a
 * merge, whoever registered the handler and whatever collection it owns. A
 * whole-collection read is recognisable by SHAPE — `hostext:<name>:` with nothing
 * after it — so the rule needs no list to maintain and no list to forget.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __hostExtStorage, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { mergeContacts } from '../src/features/crm/crmMergeService.js';
import { createTask, createActivity, makeLinkValidators, __resetCrmEntities } from '../src/features/crm/crmEntitiesService.js';

const T = 'crm-bounded-tenant';
const OTHER = 'crm-bounded-other';
let server: http.Server;
let real: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  real = __hostExtStorage()!;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => {
  initHostExtPersistence(real);
  await __resetCrmStore(); await __resetCrmEntities();
});

/** Record every `kvList` prefix issued while `fn` runs. */
async function recordListPrefixes(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  initHostExtPersistence(new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'kvList') {
        return async (prefix: string) => { seen.push(prefix); return (target as Storage).kvList(prefix); };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Storage);
  await fn();
  initHostExtPersistence(real);
  return seen;
}

/**
 * A whole-collection read, recognised by SHAPE rather than by name: the bare
 * `.list()` scan is exactly `hostext:<collection>:` with nothing after it, whereas
 * every bounded read carries something more — a tenant-prefixed id
 * (`hostext:<c>:<tenant>:…`) or the `hostextidx:` marker space, which names the
 * tenant in the key. So the rule generalises to collections nobody has written yet.
 *
 * `hostextidx:` / `hostextidxmeta:` reads are NOT unbounded reads: the tenant-index
 * backfill sentinel and the marker slice both live there. `hostextidx:<c>:` with
 * nothing after it WOULD be a cross-tenant marker sweep, and is caught below.
 */
function unboundedScans(prefixes: readonly string[]): string[] {
  return prefixes.filter((p) => /^hostext(?:idx)?:[^:]+(?::[^:]+)?:$/.test(p) && !p.startsWith('hostextidxmeta:'));
}

/**
 * `DurableCollection.ensureTenantIndex()` does ONE full `list()` per collection, ever
 * (sentinel-guarded, fleet-wide), to mint markers for rows written before the index
 * existed. That is a genuine one-shot backfill and not a per-merge scan — but it is
 * indistinguishable from one inside a single probe window, so the probe would report
 * it and the honest response is to say so rather than to carve a silent exemption
 * into the rule. Every case below therefore WARMS the indexes it will touch first
 * and then measures the STEADY-STATE merge, which is the thing being claimed.
 */
async function warmTenantIndexes(): Promise<void> {
  for (const c of [
    new DurableCollection<{ taskId: string; tenantId: string }>('crm:task', (t) => t.taskId, undefined, (t) => t.tenantId),
    new DurableCollection<{ activityId: string; tenantId: string }>('crm:activity', (a) => a.activityId, undefined, (a) => a.tenantId),
    new DurableCollection<{ sendId: string; tenantId: string }>('email:sendlog', (s) => s.sendId, undefined, (s) => s.tenantId),
  ]) await c.ensureTenantIndex();
}

describe('CRM-11 — a contact merge reads only its own tenant', () => {
  it('issues NO whole-collection scan of ANY collection — not just the ones already fixed', async () => {
    const survivor = await createContact({ tenantId: T, name: 'Survivor', stage: 'lead' });
    const source = await createContact({ tenantId: T, name: 'Source', stage: 'lead' });
    await createTask({ tenantId: T, orgId: 'org1', title: 'Follow up', contactId: source.contactId, createdBy: 'u1', validators: makeLinkValidators(T, 'org1') });
    await createActivity({ tenantId: T, orgId: 'org1', kind: 'note', body: 'spoke', contactId: source.contactId, createdBy: 'u1', validators: makeLinkValidators(T, 'org1') });

    await warmTenantIndexes();
    const prefixes = await recordListPrefixes(async () => {
      await mergeContacts(T, survivor.contactId, source.contactId, 'test');
    });

    // Non-vacuity: the probe really did observe the merge's reads.
    expect(prefixes.length, 'the probe must have captured kvList calls').toBeGreaterThan(0);

    // THE RULE, stated once and for every collection. An allowlist here is what let
    // `hostext:email:sendlog:` through in the change that added it (fold-in B4).
    expect(
      [...new Set(unboundedScans(prefixes))].sort(),
      'a merge handler MUST bound its work (indexed/point reads — never a cross-tenant scan). '
        + 'See host/crmRecordLifecycle.ts. If a new handler needs a per-tenant read, arm `tenantOf` '
        + 'on its collection and use listForTenantIndexed.',
    ).toEqual([]);

    // ...and every index read it DID issue names this tenant.
    const idxReads = prefixes.filter((p) => p.startsWith('hostextidx:') && p.split(':').length > 3);
    expect(idxReads.length, 'the bounded reads must actually have happened').toBeGreaterThan(0);
    for (const p of idxReads) expect(p, `index read must be tenant-scoped: ${p}`).toContain(T);
  });

  it('the inverted rule can SEE an unbounded scan (anti-vacuity)', () => {
    // A shape-matching gate that matches nothing passes forever. Each case
    // discriminates exactly one thing.
    expect(unboundedScans(['hostext:crm:task:']), 'the bare .list() shape').toEqual(['hostext:crm:task:']);
    expect(unboundedScans(['hostext:email:sendlog:']), 'the offender the allowlist walked past').toEqual(['hostext:email:sendlog:']);
    expect(unboundedScans(['hostextidx:crm:task:']), 'a cross-tenant MARKER sweep is unbounded too').toEqual(['hostextidx:crm:task:']);
    // ...and the bounded shapes must NOT match, or the gate would red every merge.
    expect(unboundedScans([`hostextidx:crm:task:${T}:`]), 'a tenant-scoped marker slice is bounded').toEqual([]);
    expect(unboundedScans([`hostext:crm:gmailsync:${T}:`]), 'a tenant-prefixed id scan is bounded').toEqual([]);
    expect(unboundedScans(['hostextidxmeta:crm:task:backfilled']), 'the backfill sentinel is a point read').toEqual([]);
  });

  it('the email send ledger is relinked WITHOUT a cross-tenant scan (B4)', async () => {
    // The CRM-5 handler this gate failed to police. Its relink must still happen —
    // the whole point of the seam — and must read only this tenant's slice.
    //
    // WHAT THE UNIVERSAL CASE ABOVE DOES *NOT* DISCRIMINATE, stated rather than
    // assumed: that handler is now toggle-gated, and the `email` toggle is OFF by
    // default, so it never runs in that case and re-introducing `sendLogs.list()`
    // leaves it green (MEASURED). The universal rule polices every UNGATED handler;
    // this case is what polices the email one. A gated handler needs its feature on.
    const { __resetEmailStore, listSends } = await import('../src/features/email/emailService.js');
    // The handler is toggle-gated (fold-in B4 — a merge must not touch the send
    // ledger for a tenant with email off), so turn the feature on for this case.
    const { saveConfig } = await import('../src/host/featureToggles/service.js');
    const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const emailToggle = getToggleDefault('email');
    if (emailToggle) await saveConfig({ ...emailToggle, status: 'on' }, 'test');
    const sendLogs = new DurableCollection<{ sendId: string; tenantId: string; campaignId: string; contactId: string; status: string; ts: string }>(
      'email:sendlog', (s) => s.sendId, undefined, (s) => s.tenantId,
    );
    const survivor = await createContact({ tenantId: T, name: 'Survivor', stage: 'lead' });
    const source = await createContact({ tenantId: T, name: 'Source', stage: 'lead' });
    await sendLogs.put({ sendId: 'snd:mine', tenantId: T, campaignId: 'cmp1', contactId: source.contactId, status: 'sent', ts: '2026-01-01T00:00:00.000Z' });
    await sendLogs.put({ sendId: 'snd:theirs', tenantId: OTHER, campaignId: 'cmp1', contactId: source.contactId, status: 'sent', ts: '2026-01-01T00:00:00.000Z' });

    await warmTenantIndexes();
    const prefixes = await recordListPrefixes(async () => {
      await mergeContacts(T, survivor.contactId, source.contactId, 'test');
    });
    expect(
      prefixes.filter((p) => p === 'hostext:email:sendlog:'),
      'the send-ledger relink must not scan every tenant\'s ledger',
    ).toEqual([]);

    // Non-vacuity: the relink genuinely ran, and stopped at the tenant boundary.
    expect((await listSends(T, 'cmp1')).map((s) => s.contactId), 'the survivor inherits the delivery record').toEqual([survivor.contactId]);
    expect((await sendLogs.get('snd:theirs'))!.contactId, "another tenant's ledger row is untouched").toBe(source.contactId);
    await __resetEmailStore();
  });

  it('still relinks correctly, and leaves another tenant\'s identically-named rows alone', async () => {
    const survivor = await createContact({ tenantId: T, name: 'Survivor', stage: 'lead' });
    const source = await createContact({ tenantId: T, name: 'Source', stage: 'lead' });
    const task = await createTask({ tenantId: T, orgId: 'org1', title: 'Mine', contactId: source.contactId, createdBy: 'u1', validators: makeLinkValidators(T, 'org1') });
    const act = await createActivity({ tenantId: T, orgId: 'org1', kind: 'note', body: 'mine', contactId: source.contactId, createdBy: 'u1', validators: makeLinkValidators(T, 'org1') });
    // A foreign-tenant row carrying the SAME contactId — what a cross-tenant scan
    // would have swept up, and what the tenant filter has always guarded. Seeded
    // directly because `createTask`'s link validator (correctly) refuses to bind a
    // contact from another tenant; the row shape is what matters here.
    const foreignTasks = new DurableCollection<{ taskId: string; tenantId: string; orgId: string; title: string; status: string; contactId?: string; createdBy: string; createdAt: string; updatedAt: string }>(
      'crm:task', (t) => t.taskId, undefined, (t) => t.tenantId,
    );
    await foreignTasks.put({
      taskId: 'task:foreign-1', tenantId: OTHER, orgId: 'org1', title: 'Theirs', status: 'open',
      contactId: source.contactId, createdBy: 'u2', createdAt: 'x', updatedAt: 'x',
    });

    await mergeContacts(T, survivor.contactId, source.contactId, 'test');

    const { getTask, getActivity } = await import('../src/features/crm/crmEntitiesService.js');
    expect((await getTask(T, 'org1', task.taskId))!.contactId, 'the relink still happens').toBe(survivor.contactId);
    expect((await getActivity(T, 'org1', act.activityId))!.contactId).toBe(survivor.contactId);
    expect(
      (await getTask(OTHER, 'org1', 'task:foreign-1'))!.contactId,
      "another tenant's row must be untouched",
    ).toBe(source.contactId);
  });
});
