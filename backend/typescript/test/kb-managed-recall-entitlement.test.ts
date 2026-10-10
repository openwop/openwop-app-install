/**
 * G8 (ADR 0820 §8.1, gating-audit Part D / core-audit §2b.6(i)) — READER-side
 * recall gating for feature-managed KB collections.
 *
 * Before this, a managed collection (`mgd-strategy-<org>`, `mgd-priority-matrix-<org>`,
 * `mgd-docs-<org>`, …) was gated only at its WRITER: the owning feature's indexer
 * checked `resolveOne(<feature>)` before indexing, but every READER — the KB list
 * and search doors, `ctx.knowledge` / `tenantRetrieve` (every workflow run and every
 * agent chat turn), the `openwop:knowledge.search` chat tool, and the agent-knowledge
 * recall lane (`PREAUTHORIZED_CALLER`) — served the content with no feature read at
 * all. So paid Planning & Strategy content stayed recallable on a free plan, and
 * after a lapse.
 *
 * The gate is GENERAL: a managed collection records its owning feature in
 * `managed`, and `MANAGED_COLLECTION_OWNER` maps that to the toggle id `resolveOne`
 * checks. Refused ⇒ the collection is INVISIBLE (filtered / not-found), never an
 * error. Each refusal leg has a positive control on an entitled tenant so it
 * cannot pass for the wrong reason.
 *
 * Sabotage witnesses (grade-tests wave 6): dropping the plan gate in `filterReadable`
 * reds the listing/retrieve legs; in `readableCollection` the search/documents doors;
 * letting `preAuthorized` bypass a CONTENT read reds the recall lane; dropping the
 * `KB_MAINTENANCE_CALLER` identity bypass reds the REMOVE case (via its precondition
 * and the ungated post-read).
 *
 * The tenant entitlement check is replaced after boot with a fake that refuses
 * `strategy` for FREE and allows it for PAID — the same seam billing registers
 * (`registerTenantEntitlementCheck`), so `resolveOne` exercises its real plan half.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { OpenwopError } from '../src/types.js';
import { createOrg } from '../src/host/accessControlService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { removeStrategy } from '../src/features/strategy/strategyKnowledgeService.js';
import {
  KB_MAINTENANCE_CALLER, createCollection, eraseSubjectKb, getDocument, listAllTenantCollections, listCollections, listDocuments, search, tenantRetrieve, upsertDocument,
} from '../src/features/kb/kbService.js';

let server: http.Server;
const FREE = 'org:g8-free';
const PAID = 'org:g8-paid';
// ADR 0830 D1 — recall now asks the ORG question too, so each tenant's strategy org is a
// REAL org with USER as its owner (org ids are global, hence one per tenant). Without it
// the FREE legs would pass because the org gate drops the row, not because of the plan.
const ORG_OF: Record<string, string> = { 'org:g8-free': 'o-g8-free', 'org:g8-paid': 'o-g8-paid' };
const COL_OF = (t: string): string => `mgd-strategy-${ORG_OF[t]}`;
const SECRET = 'zebracorn expansion into Lisbon market';
const USER = 'u-g8';

let refuse = false; // flipped on once the fixtures are written
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const d = getToggleDefault('strategy');
  if (!d) throw new Error('strategy toggle not registered');
  await saveConfig({ ...d, status: 'on' }, 'test');
  registerTenantEntitlementCheck(async (tenantId, featureId) => {
    if (refuse && tenantId === FREE && featureId === 'strategy') throw new OpenwopError('forbidden', 'not on plan', 403, {});
  });
  for (const tenantId of [FREE, PAID]) {
    await createOrg({ tenantId, createdBy: USER, name: 'Strategy', orgId: ORG_OF[tenantId]!, ownerSubject: USER });
    await createCollection(tenantId, ORG_OF[tenantId]!, 'strategy-sync', { name: 'Strategy KB' }, { collectionId: COL_OF(tenantId), managed: 'strategy' });
    await upsertDocument(tenantId, ORG_OF[tenantId]!, COL_OF(tenantId), 'strat-1', 'strategy-sync', { title: 'FY27 strategy', text: `# FY27\n${SECRET}`, contentTrust: 'trusted' });
    await upsertDocument(tenantId, ORG_OF[tenantId]!, COL_OF(tenantId), 'profile:subj-erase', 'strategy-sync', { title: 'p', text: 'erasable row', contentTrust: 'trusted' });
  }
  refuse = true;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const caller = { subject: USER };
const hasSecret = (v: unknown): boolean => JSON.stringify(v ?? null).includes('zebracorn');
/** Read a FREE-tenant document with the plan ALLOWED, so presence is observable
 *  independently of the gate under test. Restores the refusal even on failure. */
const readUngated = async (tenantId: string, documentId: string): Promise<unknown> => {
  refuse = false;
  try { return await getDocument(tenantId, ORG_OF[tenantId]!, COL_OF(tenantId), documentId, caller); } finally { refuse = true; }
};

describe('G8 — a refused owning feature makes its managed KB collection invisible on every reader', () => {
  it('KB listing door: hidden for FREE, listed for PAID', async () => {
    expect((await listCollections(FREE, ORG_OF[FREE]!, caller)).map((c) => c.collectionId)).not.toContain(COL_OF(FREE));
    expect((await listCollections(PAID, ORG_OF[PAID]!, caller)).map((c) => c.collectionId)).toContain(COL_OF(PAID));
  });

  it('KB search / documents doors: not-found for FREE (never a 500), served for PAID', async () => {
    await expect(search(FREE, ORG_OF[FREE]!, COL_OF(FREE), 'zebracorn', 5, 'hybrid', caller)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(listDocuments(FREE, ORG_OF[FREE]!, COL_OF(FREE), caller)).rejects.toMatchObject({ httpStatus: 404 });
    expect(hasSecret(await search(PAID, ORG_OF[PAID]!, COL_OF(PAID), 'zebracorn', 5, 'hybrid', caller))).toBe(true);
  });

  it('ctx.knowledge / tenantRetrieve (workflow run + chat turn): no strategy content for FREE', async () => {
    expect(hasSecret(await tenantRetrieve(FREE, { query: 'zebracorn Lisbon' }, caller))).toBe(false);
    expect(hasSecret(await tenantRetrieve(FREE, { query: 'zebracorn Lisbon' }, {}))).toBe(false); // system run
    expect(hasSecret(await tenantRetrieve(PAID, { query: 'zebracorn Lisbon' }, caller))).toBe(true);
  });

  it('agent-knowledge recall lane (PREAUTHORIZED, bound collection) is gated too', async () => {
    expect(hasSecret(await tenantRetrieve(FREE, { query: 'zebracorn Lisbon', collectionIds: [COL_OF(FREE)] }, PREAUTHORIZED_CALLER))).toBe(false);
    expect(await getDocument(FREE, ORG_OF[FREE]!, COL_OF(FREE), 'strat-1', PREAUTHORIZED_CALLER)).toBeNull();
    expect(hasSecret(await tenantRetrieve(PAID, { query: 'zebracorn Lisbon', collectionIds: [COL_OF(PAID)] }, PREAUTHORIZED_CALLER))).toBe(true);
    expect(hasSecret(await getDocument(PAID, ORG_OF[PAID]!, COL_OF(PAID), 'strat-1', PREAUTHORIZED_CALLER))).toBe(true);
  });

  it('the openwop:knowledge.search chat tool: no strategy content for FREE', async () => {
    const run = async (tenantId: string) => (await createAgentToolProvider({ tenantId, actingUserId: USER }).executeTool({ name: 'openwop:knowledge.search', input: { query: 'zebracorn Lisbon' } })).content;
    expect(hasSecret(await run(FREE))).toBe(false);
    expect(hasSecret(await run(PAID))).toBe(true);
  });

  it('an EXISTENCE listing (preAuthorized) still sees it — so a lapse never prunes an agent binding', async () => {
    expect((await listAllTenantCollections(FREE, PREAUTHORIZED_CALLER)).map((c) => c.collectionId)).toContain(COL_OF(FREE));
  });

  it('DSAR erasure still reaches a refused managed collection', async () => {
    const out = await eraseSubjectKb(FREE, 'subj-erase');
    expect(out.documentsDeleted).toBe(1); // FREE holds exactly one subject-keyed row
    // …and the row is really gone — read through an UNGATED lane (plan allowed), so a
    // hidden-but-present row cannot pass for a deleted one.
    expect(await readUngated(FREE, 'profile:subj-erase')).toBeNull();
  });

  it('the owning feature can still REMOVE its row while the plan is refused (no false "already gone")', async () => {
    // Precondition: the MAINTENANCE caller SEES the row while the plan is refused. Without
    // the identity bypass the read is plan-gated, `removeStrategy` reads null, returns
    // `true` ("already gone") and deletes nothing — the defect this case is named for.
    expect(await getDocument(FREE, ORG_OF[FREE]!, COL_OF(FREE), 'strat-1', KB_MAINTENANCE_CALLER), 'maintenance must see the row under a refused plan').not.toBeNull();
    expect(await removeStrategy(FREE, ORG_OF[FREE]!, 'strat-1')).toBe(true);
    expect(await readUngated(FREE, 'strat-1'), 'the row must actually be deleted, not merely hidden').toBeNull();
    expect(await getDocument(PAID, ORG_OF[PAID]!, COL_OF(PAID), 'strat-1', KB_MAINTENANCE_CALLER)).not.toBeNull(); // control: the other tenant's row is untouched
  });
});
