/**
 * Regression: the demo-ops-planning "Go-to-Market Advisory" board must be
 * idempotent across re-seeds. The original guard read `listForTenantIndexed`, a
 * tenant secondary index the advisory-board SERVICE never populates (its
 * DurableCollection is constructed without a `tenantOf`), so the guard was always
 * empty and every re-seed minted a new board — `createBoard` auto-uniquifies the
 * handle, giving gtm-advisory / -2 / -3 / …. The fix guards by handle via the
 * consistent `listBoards` scan. This proves a second seed adds no board.
 *
 * Full-app harness + demo mode (like strategy-board-showcase) so the advisor
 * cohort + board actor resolve the same way a real demo deployment runs.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedAdvisoryBoards } from '../src/host/advisoryBoardSeed.js';
import { seedDemoOpsPlanning } from '../src/host/demoOpsPlanningSeed.js';
import { listBoards } from '../src/features/advisory-board/service.js';

let server: http.Server;
const TENANT = 'user:ops-board-idempotent-test';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  for (const id of ['crm', 'strategy', 'priority-matrix', 'csm', 'advisory-board', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});

function storageOrThrow() {
  const s = __hostExtStorage();
  if (!s) throw new Error('host-ext storage not initialized');
  return s;
}

describe('demo-ops-planning advisory board idempotency', () => {
  it('does not duplicate the gtm-advisory board on a re-seed', async () => {
    const storage = storageOrThrow();
    // Substrate the ops-planning board needs: people/org, CRM, and the advisor
    // cohort it reuses (the board only creates when advisors exist).
    await seedDemoPeople(TENANT);
    await seedDemoCrm(TENANT);
    await seedAdvisoryBoards(TENANT, storage, { heal: true });

    await seedDemoOpsPlanning(TENANT);
    const afterFirst = (await listBoards(TENANT, undefined)).filter((b) => b.handle === 'gtm-advisory');
    expect(afterFirst).toHaveLength(1);

    // The bug: a second seed used to mint gtm-advisory-2 (guard read an index the
    // writer never maintains). It must now be a no-op for the board.
    await seedDemoOpsPlanning(TENANT);
    const afterSecond = (await listBoards(TENANT, undefined)).filter((b) => b.handle.startsWith('gtm-advisory'));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.handle).toBe('gtm-advisory');
  });
});
