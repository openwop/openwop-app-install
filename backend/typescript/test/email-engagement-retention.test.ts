/**
 * MKT-2 — per-kind retention for the append-only email engagement stores.
 * `email:engagement-token`: age click/open; KEEP unsubscribe/preferences (legal opt-out +
 * recordUnsubscribe reads the unsubscribe token). `email:engagement` events: age
 * opened/clicked; KEEP unsubscribed (dedup marker + consent record). Both ride the
 * `confidential-pii` window. Drives the host seam via `purgeRetained`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import type { Storage } from '../src/storage/storage.js';

// Import for the module-load side-effect: registers the two engagement purgers.
import '../src/features/email/engagementService.js';

const T = 'tA';
const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 90 * DAY).toISOString();
const OLD = new Date(now - 200 * DAY).toISOString();

interface TokRow { token: string; tenantId: string; campaignId: string; contactId: string; kind: string; createdAt: string }
interface EvtRow { id: string; tenantId: string; campaignId: string; contactId: string; kind: string; at: string }
const tokCol = () => new DurableCollection<TokRow>('email:engagement-token', (t) => t.token);
const evtCol = () => new DurableCollection<EvtRow>('email:engagement', (e) => `${e.tenantId}::${e.id}`);
const tok = (token: string, kind: string, createdAt = OLD): TokRow => ({ token, tenantId: T, campaignId: 'c1', contactId: 'ct1', kind, createdAt });
const evt = (id: string, kind: string, at = OLD): EvtRow => ({ id, tenantId: T, campaignId: 'c1', contactId: 'ct1', kind, at });

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const purge = () => purgeRetained(T, 'confidential-pii', cutoffIso);

describe('MKT-2 — email engagement per-kind retention', () => {
  it('engagement-token: ages click/open, KEEPS unsubscribe/preferences (legal survive-condition)', async () => {
    const col = tokCol();
    for (const [tkn, kind] of [['t-click', 'click'], ['t-open', 'open'], ['t-unsub', 'unsubscribe'], ['t-prefs', 'preferences']] as const) {
      await col.put(tok(tkn, kind));
    }
    const res = await purge();
    expect(res.find((r) => r.feature === 'email:engagement-token')).toMatchObject({ deleted: 2, ok: true });
    expect(await col.get('t-click')).toBeNull();   // aged
    expect(await col.get('t-open')).toBeNull();    // aged
    expect(await col.get('t-unsub')).not.toBeNull(); // KEPT — backs the live unsubscribe link
    expect(await col.get('t-prefs')).not.toBeNull(); // KEPT — backs the preference center
  });

  it('engagement events: ages opened/clicked, KEEPS unsubscribed (dedup + consent record)', async () => {
    const col = evtCol();
    for (const [id, kind] of [['e-open', 'opened'], ['e-click', 'clicked'], ['e-unsub', 'unsubscribed']] as const) {
      await col.put(evt(id, kind));
    }
    const res = await purge();
    expect(res.find((r) => r.feature === 'email:engagement')).toMatchObject({ deleted: 2, ok: true });
    expect(await col.get(`${T}::e-open`)).toBeNull();     // aged
    expect(await col.get(`${T}::e-click`)).toBeNull();    // aged
    expect(await col.get(`${T}::e-unsub`)).not.toBeNull(); // KEPT — dedup marker + consent
  });

  it('keeps a FRESH ageable row (not past the cutoff)', async () => {
    await tokCol().put(tok('t-fresh', 'click', new Date(now - 10 * DAY).toISOString()));
    await purge();
    expect(await tokCol().get('t-fresh')).not.toBeNull();
  });

  it('classification guard: an `internal` sweep purges nothing (these ride confidential-pii)', async () => {
    await tokCol().put(tok('t-click', 'click'));
    await evtCol().put(evt('e-open', 'opened'));
    const res = await purgeRetained(T, 'internal', cutoffIso);
    expect(res.find((r) => r.feature === 'email:engagement-token')?.deleted).toBe(0);
    expect(res.find((r) => r.feature === 'email:engagement')?.deleted).toBe(0);
    expect(await tokCol().get('t-click')).not.toBeNull();
  });

  it('never crosses tenants', async () => {
    await tokCol().put({ ...tok('t-other', 'click'), tenantId: 'tB' });
    await purge();
    expect(await tokCol().get('t-other')).not.toBeNull();
  });
});
