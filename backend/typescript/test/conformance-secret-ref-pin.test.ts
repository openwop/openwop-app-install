/**
 * `conformance.secret.echo` returned the SHA-256 and byte length of ANY secret
 * ref the caller named, resolved under the run's tenant — a confirm-a-guessed-key
 * and length oracle over the tenant's real BYOK keys (including workspace keys a
 * member without `host:byok:manage` cannot reveal) on any deployment that
 * enables the conformance nodes. It now resolves only the conformance canary
 * refs; the suite's legs name nothing else.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { CONFORMANCE_SECRET_REFS } from '../src/bootstrap/conformanceMockAgent.js';

const TENANT = 't-secret-pin';

beforeAll(async () => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  configureSecretResolver({ storage: await openStorage('memory://'), dataDir: mkdtempSync(join(tmpdir(), 'openwop-secret-pin-')) });
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
  await setSecret('openwop-conformance-canary-secret', 'canary-value', { tenantId: TENANT });
  await setSecret('tenant-real-openai-key', 'sk-real-key-material', { tenantId: TENANT });
});

async function echo(secretId: string): Promise<{ status: string; outputs?: { sha256?: string; byteLength?: number }; error?: { code?: string } }> {
  const node = getNodeRegistry().get('conformance.secret.echo');
  expect(node, 'conformance.secret.echo is registered when the conformance nodes are enabled').toBeTruthy();
  return (await node!.execute({ tenantId: TENANT, runId: `run-pin-${secretId}`, nodeId: 'echo', config: { secretId } } as never)) as never;
}

describe('conformance.secret.echo resolves only the conformance canary refs', () => {
  it('the canary still echoes its hash + length (the BYOK round-trip leg keeps working)', async () => {
    const r = await echo('openwop-conformance-canary-secret');
    expect(r.status).toBe('success');
    expect(r.outputs?.byteLength).toBe('canary-value'.length);
  });

  it('a real tenant key is refused — no hash, no length, no existence signal', async () => {
    const r = await echo('tenant-real-openai-key');
    expect(r.status).toBe('failure');
    expect(r.error?.code).toBe('forbidden');
    expect(r.outputs).toBeUndefined();
    // An unknown ref gets the SAME refusal as a real one, so the answer cannot
    // be used to probe which refs exist.
    const missing = await echo('no-such-ref');
    expect(missing.error?.code).toBe('forbidden');
  });

  it('the allowlist is exactly the conformance-reserved names', () => {
    expect([...CONFORMANCE_SECRET_REFS].sort()).toEqual(['conformance-test-secret', 'openwop-conformance-canary-secret']);
  });
});
