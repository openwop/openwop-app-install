/**
 * ADR 0285 (grade-data RI-6 / DG-INT-4) — revoking a connection DISABLES its
 * dependents through the real seam, never deletes them:
 *  - inbound-webhook config → enabled: false (row + binding survive)
 *  - knowledge-sync sources → status 'paused' with the revoke reason on lastError
 *  - crm gmail syncs → status 'paused' (scheduler job disabled by the status path)
 * Bystander connection's dependents untouched; a re-fire is a no-op.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { createSecretConnection, revokeConnection } from '../src/features/connections/connectionsService.js';
import { setInboundConfig, getInboundConfig, disableInboundForRevokedConnection } from '../src/features/connections/inboundWebhooks.js';
import { createSyncSource, getSyncSource, pauseSourcesForRevokedConnection } from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { createGmailSync, getGmailSync, pauseGmailSyncsForRevokedConnection } from '../src/features/crm/gmailSyncService.js';

const T = 'conn-lc-t1';
const now = () => new Date().toISOString();

// Full app boot: the REAL boot-time consumer registrations (connections-inbound,
// knowledge-sync, crm-gmail-sync) serve the seam — nothing re-registered by
// hand — and the crm-ops workflow-chain pack loads for createGmailSync.
let server: Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('connection revoke disables dependents (ADR 0285)', () => {
  it('inbound config disabled, sources + gmail syncs paused; bystanders intact; idempotent', async () => {
    const doomed = await createSecretConnection({ tenantId: T, provider: 'google', kind: 'api_key', secret: 'g-doomed', scope: 'user', userId: 'u-1' });
    const keeper = await createSecretConnection({ tenantId: T, provider: 'google', kind: 'api_key', secret: 'g-keeper', scope: 'user', userId: 'u-2' });

    await setInboundConfig({ tenantId: T, connectionId: doomed.connectionId, provider: 'slack', workflowId: 'wf-1', signingSecret: 'ss-1' });
    await setInboundConfig({ tenantId: T, connectionId: keeper.connectionId, provider: 'slack', workflowId: 'wf-2', signingSecret: 'ss-2' });

    const srcDoomed = await createSyncSource(T, 'org-1', { connectionId: doomed.connectionId, provider: 'google', externalFolderId: 'f-1', collectionId: 'col-1', cadence: 'daily' }, now());
    const srcKeeper = await createSyncSource(T, 'org-1', { connectionId: keeper.connectionId, provider: 'google', externalFolderId: 'f-2', collectionId: 'col-2', cadence: 'daily' }, now());

    const gmailDoomed = await createGmailSync({ tenantId: T, orgId: 'org-1', userId: 'u-1', connectionId: doomed.connectionId, cadence: 'daily' });
    const gmailKeeper = await createGmailSync({ tenantId: T, orgId: 'org-1', userId: 'u-2', connectionId: keeper.connectionId, cadence: 'daily' });

    expect(await revokeConnection(T, doomed.connectionId)).toBe(true);

    // Inbound: DISABLED, not deleted.
    const inbound = await getInboundConfig(T, doomed.connectionId);
    expect(inbound).not.toBeNull();
    expect(inbound!.enabled).toBe(false);
    expect((await getInboundConfig(T, keeper.connectionId))!.enabled).toBe(true);

    // Knowledge-sync: paused with the reason; bystander active.
    const src = await getSyncSource(T, srcDoomed.id);
    expect(src!.status).toBe('paused');
    expect(src!.lastError).toMatch(/revoked/i);
    expect((await getSyncSource(T, srcKeeper.id))!.status).toBe('active');

    // Gmail: paused; bystander active.
    expect((await getGmailSync(T, gmailDoomed.syncId))!.status).toBe('paused');
    expect((await getGmailSync(T, gmailKeeper.syncId))!.status).toBe('active');

    // Idempotent re-fire: everything already non-active ⇒ zero work.
    expect(await pauseSourcesForRevokedConnection(T, doomed.connectionId, now())).toBe(0);
    expect(await pauseGmailSyncsForRevokedConnection(T, doomed.connectionId)).toBe(0);
    expect(await disableInboundForRevokedConnection(T, doomed.connectionId)).toBe(false);
  });
});
