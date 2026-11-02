/**
 * `conformance.secret.echo` returned the SHA-256 and byte length of ANY secret
 * ref the caller named, resolved under the run's tenant — a confirm-a-guessed-key
 * and length oracle over the tenant's real BYOK keys (including workspace keys a
 * member without `host:byok:manage` cannot reveal) on any deployment that
 * enables the conformance nodes. It now resolves only the conformance canary
 * refs; the suite's legs name nothing else.
 *
 * Tracker TST-CJA-10 (grade-tests w68). Red when: the CONFORMANCE_SECRET_REFS gate
 * in the echo node is bypassed or the allowlist grows; or the canary leg stops
 * echoing the sha256 of the real secret value.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { CONFORMANCE_SECRET_REFS } from '../src/bootstrap/conformanceMockAgent.js';
import type { NodeContext, NodeOutcome } from '../src/executor/types.js';

const TENANT = 't-secret-pin';

beforeAll(async () => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  configureSecretResolver({ storage: await openStorage('memory://'), dataDir: mkdtempSync(join(tmpdir(), 'openwop-secret-pin-')) });
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
  await setSecret('openwop-conformance-canary-secret', 'canary-value', { tenantId: TENANT });
  await setSecret('tenant-real-openai-key', 'sk-real-key-material', { tenantId: TENANT });
});

async function echo(secretId: string): Promise<NodeOutcome> {
  const node = getNodeRegistry().get('conformance.secret.echo');
  expect(node, 'conformance.secret.echo is registered when the conformance nodes are enabled').toBeTruthy();
  const ctx: NodeContext = {
    tenantId: TENANT,
    runId: `run-pin-${secretId}`,
    nodeId: 'echo',
    config: { secretId },
    inputs: {},
    configurable: {},
    attempt: 1,
    secrets: {},
    async emit() {
      return { eventId: 'evt-pin', sequence: 1 };
    },
  };
  return node!.execute(ctx);
}

/** Narrow a NodeOutcome without a cast. */
function outputsOf(r: NodeOutcome): Record<string, unknown> | undefined {
  return r.status === 'success' ? (r.outputs as Record<string, unknown> | undefined) : undefined;
}
function errorCodeOf(r: NodeOutcome): string | undefined {
  return r.status === 'failure' ? r.error?.code : undefined;
}

describe('conformance.secret.echo resolves only the conformance canary refs', () => {
  it('the canary still echoes its hash + length (the BYOK round-trip leg keeps working)', async () => {
    const r = await echo('openwop-conformance-canary-secret');
    expect(r.status).toBe('success');
    expect(outputsOf(r)?.byteLength).toBe(12);
    // sha256('canary-value'), computed independently of the node.
    expect(outputsOf(r)?.sha256).toBe('59956a7568dda7e7d5af6bcb5b02367343b6e8f7deec2ea496983c9007a24a37');
  });

  it('a real tenant key is refused — no hash, no length, no existence signal', async () => {
    const r = await echo('tenant-real-openai-key');
    expect(r.status).toBe('failure');
    expect(errorCodeOf(r)).toBe('forbidden');
    expect('outputs' in r).toBe(false);
    // An unknown ref gets the SAME refusal as a real one, so the answer cannot
    // be used to probe which refs exist.
    const missing = await echo('no-such-ref');
    expect(errorCodeOf(missing)).toBe('forbidden');
  });

  it('the allowlist is exactly the conformance-reserved names', () => {
    expect([...CONFORMANCE_SECRET_REFS].sort()).toEqual(['conformance-test-secret', 'openwop-conformance-canary-secret']);
  });
});
