/**
 * UX_UPGRADE-environments R2 — ENV2-M1 / ENV2-B1.
 *
 * R1's verdict on this feature was "checked, NO findings". `promotionApproval.ts`
 * really is exemplary and is untouched here: tenant RBAC enforced in the
 * handler, a CAS flip whose `changed` gates the side effect, and compensation on
 * BOTH the approve and reject paths.
 *
 * ENV2-M1 — what the gate QUEUES, not how it decides. The proposal was
 * `Deploy snapshot <12 hex>… to "prod"`, and that string reaches the reviewer
 * verbatim (`reviewProjection.ts` falls back `summary ?? proposal`; `ReviewCard`
 * renders it). So the person holding `host:members:manage` approved a LIVE
 * config change knowing the destination and a truncated hash, and nothing about
 * the substance. A hash is not reviewable.
 *
 * ENV2-B1 — the missing subject eraser, with a DIFFERENT semantic from the one
 * `documents` needed. See the audit-ledger case below: it is the whole reason
 * this class is being closed one feature at a time rather than swept.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createUser } from '../src/features/users/usersService.js';
import {
  describeSnapshotChange,
  diffDomainPayloads,
} from '../src/features/environments/environmentsService.js';
import { eraseEnvironmentsSubject, ERASED_SUBJECT } from '../src/features/environments/erasure.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ENV2-M1 — the approval says what changes, not just where it lands', () => {
  it('names each domain and its added/changed/removed counts', () => {
    const text = describeSnapshotChange({
      'feature-toggles': { added: 2, changed: 1, removed: 0 },
      'publish-pointers': { added: 0, changed: 0, removed: 3 },
    });
    // The reviewer must be able to see the SHAPE of the change without opening
    // anything else. Domain names, and the direction of each count.
    expect(text).toContain('feature-toggles');
    expect(text).toContain('+2');
    expect(text).toContain('~1');
    expect(text).toContain('publish-pointers');
    expect(text).toContain('-3');
    // A count of zero is noise, not information — it must not be rendered.
    expect(text, 'zero counts are omitted, not printed as +0').not.toContain('+0');
  });

  it('says so plainly when NOTHING changes, rather than going quiet', () => {
    // A promotion CAN move a pointer to a snapshot that differs only in
    // metadata. "no config entries change" is a real answer; an empty string
    // would put the reviewer back where the bare hash left them.
    expect(describeSnapshotChange({})).toBe('no config entries change');
    expect(describeSnapshotChange({ 'feature-toggles': { added: 0, changed: 0, removed: 0 } }))
      .toBe('no config entries change');
  });

  it('is computed from the SAME diff the preview uses, over real payloads', () => {
    // Not a second opinion invented for the review: `diffDomainPayloads` is the
    // extracted form of what `diffSnapshots` (and therefore the preview) runs.
    const diff = diffDomainPayloads(
      { 'feature-toggles': { a: 'on', b: 'off' } as never },
      { 'feature-toggles': { a: 'off', c: 'on' } as never },
    );
    const text = describeSnapshotChange(diff);
    // b removed, c added, a changed — whatever the domain's own diff() reports,
    // the sentence must be non-empty and mention the domain.
    expect(text).toContain('feature-toggles');
    expect(text).not.toBe('no config entries change');
  });

  it('the QUEUED approval actually carries the summary — the wiring, not the helper', async () => {
    // Probe finding: reverting the proposal string reddened NOTHING, because
    // the three cases above exercise `describeSnapshotChange` directly. That is
    // the mechanism-vs-wiring defect (ADR 0502) inside my own tests — the helper
    // was proven and its only caller was not. This drives a REAL gated promote
    // and reads what a reviewer would see.
    const T = 'org:env-gate';
    const {
      createEnvironment, setEnvironmentSettings, snapshotLiveConfig, movePointer, promote,
    } = await import('../src/features/environments/environmentsService.js');

    await createEnvironment({ tenantId: T, name: 'staging', order: 1 });
    await createEnvironment({ tenantId: T, name: 'prod', order: 2 });
    const snap = await snapshotLiveConfig({ tenantId: T, sourceEnv: 'staging', createdBy: 'u-1' });
    await movePointer({ tenantId: T, fromEnvName: null, toEnvName: 'staging', snapshotHash: snap.hash, actor: 'u-1' });

    await setEnvironmentSettings(T, { requireApprovalForPromotion: true });
    const outcome = await promote({ tenantId: T, fromEnvName: 'staging', toEnvName: 'prod', actor: 'u-1' });

    const approval = (outcome as { pendingApproval?: { proposal?: string } }).pendingApproval;
    expect(approval, 'the promote must have been GATED, not applied').toBeTruthy();
    const proposal = String(approval?.proposal ?? '');
    expect(proposal, 'the reviewer still sees where it lands').toContain('prod');
    // The property under test: the substance, not just the destination + hash.
    expect(proposal, 'and what it does — the bare hash was the defect').toMatch(/change|\+\d|~\d|-\d/);
    expect(proposal.length, 'materially more than "Deploy snapshot abcdef… to \'prod\'"').toBeGreaterThan(50);
  });
});


describe('ENV2-B1 — erasure reaches environments, and STOPS at the audit ledger', () => {
  it('anonymizes who captured a config snapshot', async () => {
    const { snapshotLiveConfig, getSnapshot } = await import('../src/features/environments/environmentsService.js');
    const subject = (await createUser({ tenantId: 'org:env-erase', principalId: 'password:env@t.test', displayName: 'Env User' })).userId;

    const snap = await snapshotLiveConfig({ tenantId: 'org:env-erase', sourceEnv: null, createdBy: subject });
    expect(snap.createdBy, 'premise: the snapshot really is attributed to them').toBe(subject);

    await eraseEnvironmentsSubject('org:env-erase', subject);

    const after = await getSnapshot('org:env-erase', snap.hash);
    expect(after, 'the snapshot itself survives — it is config, not personal data').toBeTruthy();
    expect(after?.createdBy).toBe(ERASED_SUBJECT);
  });

  it('PRESERVES the promotion ledger actor — the audit record of a production change', async () => {
    // This pins a DECISION, not an oversight. `PromotionRecord.actor` answers
    // "who pushed this config to live". Erasing it would destroy accountability
    // for production changes in order to remove a name from an audit log.
    //
    // The test exists so a later sweep closing the other ~40 missing erasers
    // cannot quietly "finish the job" here without confronting the choice: if
    // this assertion is ever deliberately inverted, that is a legal/product
    // decision an operator made, not a gap someone tidied.
    const { recordRejectedPromotion, listPromotions } = await import('../src/features/environments/environmentsService.js');
    const subject = (await createUser({ tenantId: 'org:env-audit', principalId: 'password:audit@t.test', displayName: 'Auditor' })).userId;

    await recordRejectedPromotion({
      tenantId: 'org:env-audit', fromEnvName: null, toEnvName: 'prod',
      snapshotHash: 'deadbeef', actor: subject, approvalId: 'appr:x',
    });
    await eraseEnvironmentsSubject('org:env-audit', subject);

    const rows = await listPromotions('org:env-audit');
    expect(rows.length, 'premise: the ledger row exists').toBeGreaterThan(0);
    expect(rows[0]?.actor, 'the audit trail is deliberately NOT anonymized').toBe(subject);
  });

  it('is idempotent and tenant-scoped', async () => {
    const { snapshotLiveConfig, getSnapshot } = await import('../src/features/environments/environmentsService.js');
    const subject = (await createUser({ tenantId: 'org:env-idem', principalId: 'password:idem@t.test', displayName: 'Idem' })).userId;
    const mine = await snapshotLiveConfig({ tenantId: 'org:env-idem', sourceEnv: null, createdBy: subject });
    const foreign = await snapshotLiveConfig({ tenantId: 'org:env-other', sourceEnv: null, createdBy: subject });

    await eraseEnvironmentsSubject('org:env-idem', subject);
    const once = await getSnapshot('org:env-idem', mine.hash);
    await eraseEnvironmentsSubject('org:env-idem', subject);
    expect(await getSnapshot('org:env-idem', mine.hash)).toEqual(once);

    expect(
      (await getSnapshot('org:env-other', foreign.hash))?.createdBy,
      'the same person in another tenant is out of scope',
    ).toBe(subject);
  });

  it('is WIRED — the host fan-out reaches this feature', async () => {
    // A handler that exists but was never registered is the exact shape of the
    // original defect (ADR 0502 mechanism-vs-wiring).
    const { eraseSubject } = await import('../src/host/subjectErasure.js');
    const { snapshotLiveConfig, getSnapshot } = await import('../src/features/environments/environmentsService.js');
    const subject = (await createUser({ tenantId: 'org:env-wire', principalId: 'password:wire@t.test', displayName: 'Wire' })).userId;
    const snap = await snapshotLiveConfig({ tenantId: 'org:env-wire', sourceEnv: null, createdBy: subject });

    await eraseSubject('org:env-wire', subject);

    expect((await getSnapshot('org:env-wire', snap.hash))?.createdBy).toBe(ERASED_SUBJECT);
  });
});
