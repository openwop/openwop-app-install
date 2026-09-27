/**
 * ADR 0525 — a builder chain-pack export must LOAD.
 *
 * `buildChainPackManifest` writes a file the product's own publish banner invites
 * the user to PR to a public registry. Its derivation logic is covered by the
 * frontend test; the two claims that matter most cannot be checked there — ajv is
 * not a frontend dependency and the chain loader is backend-only, so
 * re-implementing either would be the second copy the architecture contract
 * forbids.
 *
 * THE WRONG-REASON TRAP THIS FILE IS BUILT AROUND: `loadWorkflowChainPacks`
 * RETURNS `{ installed, errors }` — it does NOT throw. A test that writes a
 * manifest, calls the loader, and asserts "no exception" therefore passes on a
 * totally invalid manifest. Every assertion below goes past that: `errors` is
 * empty, the chain RESOLVES by id, and expansion PRESERVES the fields the export
 * carried.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

/**
 * The manifest shape `buildChainPackManifest` emits, pinned here.
 *
 * Deliberately NOT hand-idealised: this mirrors the exporter's output for a
 * two-node graph whose email node authors `config.from` plus `inputs.to`, with a
 * `{{params.*}}` token so the derived `parameters` block is exercised. A
 * hand-written golden that drifts from the exporter validates a file the
 * exporter no longer produces — the classic pass-for-the-wrong-reason.
 */
const EXPORTED_MANIFEST = {
  name: 'community.local.my-export',
  version: '1.0.0',
  kind: 'workflow-chain',
  description: 'Workflow-chain pack exported from the OpenWOP builder: "My Export". Declares 1 parameter(s) found in the graph. Rename the community.local.* placeholder before publishing.',
  author: 'openwop-app',
  license: 'Apache-2.0',
  engines: { openwop: '^1.0.0' },
  chains: [
    {
      chainId: 'community.local.my-export',
      version: '1.0.0',
      label: 'My Export',
      description: 'My Export. Asks for 1 value(s) when you run it: recipientEmail.',
      parameters: {
        type: 'object',
        required: ['recipientEmail'],
        properties: {
          recipientEmail: { type: 'string', description: 'The value to use for "recipientEmail" each time this workflow runs.' },
        },
      },
      dag: {
        nodes: [
          { id: 'draft', typeId: 'core.ai.chatCompletion', name: 'Draft', position: { x: 0, y: 0 }, config: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
          { id: 'send', typeId: 'core.openwop.integration.email-send', name: 'Send', position: { x: 280, y: 0 }, config: { from: 'me@example.com' }, inputs: { to: '{{params.recipientEmail}}' } },
        ],
        edges: [{ from: 'draft', to: 'send' }],
      },
    },
  ],
};

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  _resetChainRegistryForTest();
});

function installExport(manifest: unknown): { errors: unknown[] } {
  dir = mkdtempSync(join(tmpdir(), 'chain-export-'));
  const packDir = join(dir, 'my-export');
  mkdirSync(packDir);
  writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest, null, 2));
  _resetChainRegistryForTest();
  const res = loadWorkflowChainPacks({ roots: [dir] });
  return { errors: (res.errors ?? []) as unknown[] };
}

describe('a builder export loads as a chain pack', () => {
  it('loads with ZERO errors — not merely "did not throw"', () => {
    const { errors } = installExport(EXPORTED_MANIFEST);
    // `loadWorkflowChainPacks` returns errors rather than throwing, so this is
    // the assertion; "no exception" would pass on an invalid manifest.
    expect(errors, `the exported manifest was rejected: ${JSON.stringify(errors)}`).toEqual([]);
  });

  it('the chain RESOLVES by id after loading', () => {
    installExport(EXPORTED_MANIFEST);
    const found = listChains().find((c) => c.chain.chainId === 'community.local.my-export');
    expect(found, 'the pack loaded but the chain is not resolvable').toBeDefined();
  });

  it('expansion PRESERVES both config and inputs the export carried', () => {
    // The ADR 0523 defect, chased to its last surface: an export that loads but
    // loses `inputs` sends an email to nobody, under a green run.
    installExport(EXPORTED_MANIFEST);
    const chain = listChains().find((c) => c.chain.chainId === 'community.local.my-export')!.chain;
    const expanded = expandChain(chain, { params: { recipientEmail: 'you@example.com' } });
    const send = expanded.nodes.find((n) => n.typeId === 'core.openwop.integration.email-send');
    expect(send, 'the email node vanished in expansion').toBeDefined();
    expect(send!.config).toMatchObject({ from: 'me@example.com' });
    expect(send!.inputs, 'the export carried `to` and expansion dropped it').toMatchObject({
      to: 'you@example.com',
    });
  });

  it('the derived `parameters` block actually binds the token', () => {
    // The anti-fabrication property end to end: a declared param is substituted,
    // so the node receives a value rather than the ADR 0507 empty string.
    installExport(EXPORTED_MANIFEST);
    const chain = listChains().find((c) => c.chain.chainId === 'community.local.my-export')!.chain;
    const expanded = expandChain(chain, { params: { recipientEmail: 'bound@example.com' } });
    const send = expanded.nodes.find((n) => n.typeId === 'core.openwop.integration.email-send')!;
    expect(JSON.stringify(send.inputs)).not.toContain('{{params.');
    expect(send.inputs).toMatchObject({ to: 'bound@example.com' });
  });

  it('FIXTURE GUARD: a manifest the loader SHOULD reject is rejected', () => {
    // Without this, every assertion above could be passing because the loader
    // accepts anything — which is exactly how "no exception" tests lie.
    //
    // Note the case this does NOT use: a wrong `kind` is SKIPPED, not errored —
    // correct, since a root holds mixed pack kinds and a node pack is not a
    // chain-pack failure. Picking that as the guard would have asserted a
    // rejection the loader never makes. The guard has to be a manifest that is
    // structurally invalid AS a chain pack.
    const broken = JSON.parse(JSON.stringify(EXPORTED_MANIFEST)) as typeof EXPORTED_MANIFEST;
    delete (broken.chains[0] as { dag?: unknown }).dag;
    const { errors } = installExport(broken);
    expect(errors.length, 'the loader accepted a chain with no dag').toBeGreaterThan(0);
  });
});
