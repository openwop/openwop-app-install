/**
 * Teardown-reachability RECORDED_DEBT shrink (baseline 5→3): the connection CHILD
 * pointers `connections:pairing` and `connections:inbound-session` key by
 * `connectionId` and carry NO tenant, so the generic `purgeTenantHostExt` content
 * walk cannot reach them (it deletes `connections:connection` via its `tenantId`
 * but the children are unreachable) — they orphaned on account deletion. A
 * `tenantOf` cannot help (the key is an opaque `conn:<uuid>`, not a tenant), so
 * `feature.ts` registers a PARENT-RESOLVED `purgeTenantHostExt` pre-hook
 * (`purgeTenantConnectionChildren`, ADR 0590) that enumerates the tenant's
 * connections and deletes each one's children.
 *
 * Three parts:
 *  1. TEARDOWN — register the hook the way `feature.ts` does, seed a connection +
 *     pairing + inbound-session per tenant via the real services, purge tenant A,
 *     and assert BOTH of A's child rows are reached AND tenant B's survive
 *     (`listTenantConnectionIds` filters by exact `tenantId`, so B is untouched).
 *     Born-red: drop the hook registration → A's children survive the purge.
 *  2. REVOKE — the PRODUCT's `connections-children` consumer (registered by
 *     `connectionsFeature.registerRoutes`, feature.ts) deletes a revoked
 *     connection's children (so none orphan between revoke and teardown, keeping
 *     the teardown hook COMPLETE). The consumer is not exported, so the case boots
 *     the real app (createApp registers every feature) and registers no copy of
 *     it (it only no-ops the WhatsApp sibling, which also unpairs; see the case):
 *     an earlier version registered its own copy of the consumer, and
 *     deleting the product's body stayed green (probe 8fw3g3-tdc-consumer was
 *     vacuous). Fire the revoke event → the children are gone.
 *  3. WIRING — assert `feature.ts` actually registers BOTH the purge hook and the
 *     revoke consumer, so deleting either wiring fails the build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  initHostExtPersistence,
  purgeTenantHostExt,
  hostExtStorage,
  registerTenantPurgeHook,
} from '../src/host/hostExtPersistence.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import {
  createSecretConnection,
  __resetConnectionsStore,
} from '../src/features/connections/connectionsService.js';
import { pairConnection, getPairing, __resetMessagingOutbound } from '../src/features/connections/messagingOutbound.js';
import {
  __setInboundSessionForTest,
  __resetInboundStore,
} from '../src/features/connections/inboundWebhooks.js';
import { purgeTenantConnectionChildren } from '../src/features/connections/tenantTeardown.js';
import { createApp } from '../src/index.js';
import {
  onConnectionRevoked,
  fireConnectionRevoked,
  __resetConnectionLifecycleHooks,
} from '../src/host/connectionLifecycle.js';

// A is a proper prefix of B (`org:conn` vs `org:conn2`) — a reminder that tenant
// ids contain `:`; here isolation rides `listTenantConnectionIds`' exact-equality
// filter, not a prefix match, so B's rows must be wholly untouched.
const A = 'org:conn';
const B = 'org:conn2';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // BYOK resolver — createSecretConnection encrypts the secret through it.
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'owp-conn-teardown-')) });
  await __resetConnectionsStore();
  await __resetMessagingOutbound();
  await __resetInboundStore();
  __resetConnectionLifecycleHooks();
});

// Seed a tenant's connection + its two child pointers; return the connection id.
async function seed(tenant: string): Promise<string> {
  const conn = await createSecretConnection({
    tenantId: tenant,
    provider: 'servicenow',
    kind: 'api_key',
    secret: `sn-key-${tenant}`,
    scope: 'workspace',
  });
  await pairConnection(conn.connectionId, 'slack', `chan-${tenant}`);
  await __setInboundSessionForTest(conn.connectionId, `run-${tenant}`);
  return conn.connectionId;
}

// The inbound-session row keys by connectionId with no tenant — assert via the
// raw hostext rows (no getter). A live row's key contains both the namespace and
// the connection id.
async function sessionRowExists(connectionId: string): Promise<boolean> {
  const rows = await hostExtStorage().kvList('hostext:');
  return rows.some(({ key }) => key.includes('connections:inbound-session') && key.includes(connectionId));
}

describe('teardown-debt connections hook — pairing + inbound-session are teardown-reachable', () => {
  it('purges tenant A\'s pairing + inbound-session via its connections; tenant B survives', async () => {
    registerTenantPurgeHook('connections', purgeTenantConnectionChildren);
    const idA = await seed(A);
    const idB = await seed(B);

    // Both tenants' children exist up front.
    expect(await getPairing(idA)).not.toBeNull();
    expect(await sessionRowExists(idA)).toBe(true);
    expect(await getPairing(idB)).not.toBeNull();
    expect(await sessionRowExists(idB)).toBe(true);

    await purgeTenantHostExt(A);

    // A's children are GONE — the parent-resolved hook reached them (born-red
    // without the registration: the generic walk cannot see connectionId-keyed rows).
    expect(await getPairing(idA)).toBeNull();
    expect(await sessionRowExists(idA)).toBe(false);
    // B is untouched — the hook enumerated only A's connections.
    expect(await getPairing(idB)).not.toBeNull();
    expect(await sessionRowExists(idB)).toBe(true);
  });

  it('the connections-children revoke consumer deletes a revoked connection\'s children', async () => {
    // Boot the real app: createApp runs connectionsFeature.registerRoutes, which
    // registers the product's consumer (and re-binds host-ext persistence to the
    // app's own store, which the seed below then writes through).
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    // DOUBLE GUARD in the booted app: the WhatsApp feature's own revoke consumer
    // (`cleanupWhatsAppConnection`, whatsappService.ts:134) also calls `unpair`
    // for EVERY revoked connection, whatever its provider. With it live, deleting
    // the connections consumer's `unpair` stayed green (round-2 probe
    // 8fw3g3-tdc-consumer-r2 was vacuous). Its keyed slot is replaced with a no-op
    // so the consumer under test is the only one that can delete the pairing.
    // Nothing else is replaced, and no copy of the product consumer is registered.
    onConnectionRevoked('whatsapp', async () => {});
    const id = await seed(A);
    const other = await seed(B); // a sibling connection the revoke must not touch
    expect(await getPairing(id)).not.toBeNull();
    expect(await sessionRowExists(id)).toBe(true);

    // The lifecycle seam fires AFTER the connection row is gone; the consumer
    // deletes the now-parentless children so they never orphan before teardown.
    await fireConnectionRevoked({ tenantId: A, connectionId: id });

    expect(await getPairing(id)).toBeNull();
    expect(await sessionRowExists(id)).toBe(false);
    expect(await getPairing(other)).not.toBeNull();
    expect(await sessionRowExists(other)).toBe(true);
  }, 60_000);

  it('feature.ts wires BOTH the purge hook and the revoke consumer', () => {
    // Strip line-comments before matching: a commented-out registration still
    // carries the literal string, so a raw grep passes on a disabled wiring (the
    // "ratchet counts comments" vacuity class). Match live code only.
    const featureSrc = readFileSync(join(__dirname, '..', 'src', 'features', 'connections', 'feature.ts'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(featureSrc).toMatch(/registerTenantPurgeHook\(\s*['"]connections['"]\s*,\s*purgeTenantConnectionChildren\s*\)/);
    expect(featureSrc).toMatch(/onConnectionRevoked\(\s*['"]connections-children['"]/);
  });
});
