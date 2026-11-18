/**
 * CC-LEAD-2: the active-model CAS accepts the pointer GET /models/active
 * reports, and the built-in v0 can be restored.
 *
 * MEASURED on prod 2026-11-17 (build 569fdfec88, client org-57dd2a6a):
 *  - GET …/leads/models/active with no pointer returned {modelId:"v0", version:0};
 *  - activate {expected:{modelId:"v0",version:0}} returned 409
 *    active_model_conflict "The active model changed since you opened it.";
 *  - activate v0 version 0 returned 404 "Model version not found.", so a client
 *    that activated a model could never return to the built-in.
 *
 * Red on main: the first `activateModel` with expected v0@0 rejects with 409, and
 * the v0 restore rejects with 404.
 * The stale-editor refusals (null over a pointer, a wrong pointer) stay 409, so
 * the CAS was widened only to the reported value.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { activateModel, resolveActiveModel, saveModelVersion } from '../src/features/crm/leadIntel/modelStore.js';

const T = (): string => `t-cclead2-${randomBytes(4).toString('hex')}`;
const content = { signals: [{ signalId: 'funnel.completion', weight: 10 }], bands: { A: 50, B: 40, C: 30, D: 20, E: 10 } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('CC-LEAD-2: the active-model pointer round-trips through what the read reports', () => {
  it('expected v0@0 is accepted when no model is active, and v0 is restorable', async () => {
    const tenantId = T();
    const orgId = 'org-cclead2';
    const reported = await resolveActiveModel(tenantId, orgId);
    expect({ modelId: reported.modelId, version: reported.version }).toEqual({ modelId: 'v0', version: 0 });
    await saveModelVersion({ tenantId, orgId, modelId: 'standard', expectedVersion: 0, content, actor: 'u1' });

    await activateModel({ tenantId, orgId, modelId: 'standard', version: 1, actor: 'u1', expected: { modelId: 'v0', version: 0 } });
    expect(await resolveActiveModel(tenantId, orgId)).toMatchObject({ modelId: 'standard', version: 1 });

    // A stale editor is still refused: neither "none" nor the old v0 matches now.
    await expect(activateModel({ tenantId, orgId, modelId: 'v0', version: 0, actor: 'u2', expected: null }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'active_model_conflict' } });
    await expect(activateModel({ tenantId, orgId, modelId: 'v0', version: 0, actor: 'u2', expected: { modelId: 'v0', version: 0 } }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'active_model_conflict' } });

    await activateModel({ tenantId, orgId, modelId: 'v0', version: 0, actor: 'u1', expected: { modelId: 'standard', version: 1 } });
    const back = await resolveActiveModel(tenantId, orgId);
    expect({ modelId: back.modelId, version: back.version }).toEqual({ modelId: 'v0', version: 0 });

    // After the restore, the reported v0@0 is again an accepted `expected`.
    await activateModel({ tenantId, orgId, modelId: 'standard', version: 1, actor: 'u1', expected: { modelId: 'v0', version: 0 } });
    expect(await resolveActiveModel(tenantId, orgId)).toMatchObject({ modelId: 'standard', version: 1 });
  });

  it('a version that was never saved is still a 404, and v0 at another version is not the built-in', async () => {
    const tenantId = T();
    const orgId = 'org-cclead2-b';
    await expect(activateModel({ tenantId, orgId, modelId: 'standard', version: 7, actor: 'u1', expected: null }))
      .rejects.toMatchObject({ httpStatus: 404 });
    await expect(activateModel({ tenantId, orgId, modelId: 'v0', version: 1, actor: 'u1', expected: null }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });
});
