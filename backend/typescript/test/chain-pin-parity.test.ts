/**
 * ADR 0766 P2 — every node pin an in-tree chain declares names a version this
 * host actually runs.
 *
 * The predicate is the SAME one the template gallery and `from-chain` use to
 * report an install gap (`unmetNodePins`, ADR 0766 D3), read against the SAME
 * source (`buildNodeCatalog()` of a booted host). So "parity is green" and "no
 * user sees `typeId@x.y.z` in a pre-flight" are one statement, not two that can
 * drift apart.
 *
 * What makes this fail: a node's version bumps without its chains being re-pinned.
 * The fix it names is one command. A pin whose type the host does not have at all
 * fails here too — `unmetNodePins` deliberately leaves absent types to the
 * missing-type check, so this file asserts that half itself.
 *
 * TST-CCP-1. Red when an in-tree chain pins a version, or a type, the booted host
 * does not run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { buildNodeCatalog } from '../src/host/nodeCatalogBuilder.js';
import { unmetNodePins } from '../src/host/chainPinRule.js';
import { _resetChainRegistryForTest, listChains, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';

const CHAIN_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');
const FIX = 'cd backend/typescript && npm run chains:pin -- --write --repin';

let installed: Map<string, string | undefined>;
let loadErrors: unknown[] = [];

beforeAll(async () => {
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  installed = new Map(buildNodeCatalog().map((n) => [n.typeId, n.version]));
  _resetChainRegistryForTest();
  loadErrors = loadWorkflowChainPacks({ roots: [CHAIN_ROOT] }).errors;
}, 120_000);

describe('ADR 0766 P2 — in-tree chain pins match the installed node versions', () => {
  it('loaded the in-tree chains (a vacuous registry would pass everything)', () => {
    expect(loadErrors, 'an in-tree chain pack failed to load').toEqual([]);
    expect(listChains().length).toBeGreaterThan(268); // measured 272 (2026-10-29)
  });

  it('no chain pins a version this host does not run', () => {
    const gaps = listChains().flatMap(({ chain }) =>
      unmetNodePins(chain.nodePins, (t) => installed.get(t)).map((ref) => `${chain.chainId}: ${ref} (installed ${installed.get(ref.slice(0, ref.lastIndexOf('@')))})`));
    expect(gaps, `stale pins — ${FIX}`).toEqual([]);
  });

  it('no chain pins a node type this host does not have at all', () => {
    const absent = listChains().flatMap(({ chain }) =>
      Object.keys(chain.nodePins ?? {}).filter((t) => !installed.has(t)).map((t) => `${chain.chainId}: ${t}`));
    expect(absent, 'a pinned node type is not installed — the chain cannot run here').toEqual([]);
  });
});
