/**
 * UX_UPGRADE-app-builder R2 — AB2-M1.
 *
 * App-builder's erasure story was ALMOST complete before this pass, and the
 * "almost" is the finding. Canvases and version snapshots are covered by the
 * HOST canvas eraser (`eraseSubjectCanvas`, ADR 0464 — the canvas store is
 * shared, so its erasure is host-owned); `ExportLineageEntry` carries no user
 * identifier at all. The one identifier nothing reached was
 * `SyncBinding.boundBy` — the user who bound a GitHub repo — on a feature-owned
 * durable row. A data-subject erasure returned success with that id intact.
 *
 * The eraser touches ONLY `boundBy`. `owner`/`repo`/`branch` are the sync's
 * machine coordinates: anonymizing them destroys a live binding the ORG
 * configured. Whether an erasure must also sever an org's intentional repo
 * binding (a GitHub `owner` may be a personal login) is an operator decision,
 * flagged in the tracker — the environments audit-ledger precedent. A case
 * below PINS that the binding stays functional, so a later sweep cannot
 * quietly widen the erasure without confronting that choice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  createSyncBinding, getSyncBinding, getSyncBindingByWebhookId,
  eraseSyncBindingSubject, ERASED_SUBJECT,
} from '../src/features/app-builder/syncBinding.js';

const TENANT = 'org:ab-erase';
const SUBJECT = 'user:erase-me-ab';
const OTHER = 'user:keep-me-ab';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
const aBinding = (boundBy: string, tenantId = TENANT) =>
  createSyncBinding(tenantId, `canvas-${++n}`, {
    owner: 'acme-co', repo: 'site', branch: 'main', target: 'react-tailwind', boundBy,
  });

describe('AB2-M1 — erasure reaches the sync binding, and ONLY the attribution', () => {
  it('anonymizes boundBy while the binding STAYS FUNCTIONAL', async () => {
    const { view } = await aBinding(SUBJECT);

    await eraseSyncBindingSubject(TENANT, SUBJECT);

    const after = await getSyncBinding(TENANT, view.canvasId);
    expect(after, 'the binding row survives — it is org infrastructure').toBeTruthy();
    expect(after?.boundBy).toBe(ERASED_SUBJECT);

    // The machine coordinates are untouched — this PINS the operator-decision
    // boundary. If a later pass decides erasure must also sever the repo
    // binding, this assertion is the one it must consciously invert.
    expect(after?.owner).toBe('acme-co');
    expect(after?.repo).toBe('site');
    expect(after?.branch).toBe('main');
    // ...and the inbound webhook route still resolves — the sync is alive.
    expect(await getSyncBindingByWebhookId(after!.webhookId), 'the webhook lookup still works').toBeTruthy();
  });

  it('leaves another subject\'s bindings untouched (the negative control)', async () => {
    const { view } = await aBinding(OTHER);
    await eraseSyncBindingSubject(TENANT, SUBJECT);
    expect((await getSyncBinding(TENANT, view.canvasId))?.boundBy).toBe(OTHER);
  });

  it('is tenant-scoped and idempotent', async () => {
    const foreign = await aBinding(SUBJECT, 'org:ab-erase-2');
    const mine = await aBinding(SUBJECT);

    await eraseSyncBindingSubject(TENANT, SUBJECT);
    const once = await getSyncBinding(TENANT, mine.view.canvasId);
    await eraseSyncBindingSubject(TENANT, SUBJECT);
    expect(await getSyncBinding(TENANT, mine.view.canvasId)).toEqual(once);

    expect(
      (await getSyncBinding('org:ab-erase-2', foreign.view.canvasId))?.boundBy,
      'the same person in another tenant is out of scope',
    ).toBe(SUBJECT);
  });

  it('is WIRED — the host fan-out reaches this feature (mechanism ≠ wiring)', async () => {
    const { eraseSubject } = await import('../src/host/subjectErasure.js');
    const { view } = await aBinding(SUBJECT);

    await eraseSubject(TENANT, SUBJECT);

    expect((await getSyncBinding(TENANT, view.canvasId))?.boundBy, 'the HOST fan-out must reach the binding').toBe(ERASED_SUBJECT);
  });
});
