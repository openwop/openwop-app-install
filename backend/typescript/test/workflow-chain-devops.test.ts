/**
 * DevOps workflow-chain pack (ADR 0190 Phase 4).
 *
 * All four chains are ADVISORY (in-app notification sinks, no external
 * writes, no gates needed) and zero-connection; the repo-wide conventions
 * suite (workflow-chain-knowledge-inbox.test.ts) covers gating + live-param
 * rules automatically. These chains use short chain-local prompts — they do
 * NOT dispatch the code-reviewer / git-author agent packs (no-parallel-
 * architecture: chains and agents coexist as different surfaces).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  chainRequirements,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

const PACK = 'core.openwop.workflows.devops';
const CHAINS = ['devops.pr-review', 'devops.release-notes', 'devops.ci-failure-explainer', 'devops.stale-issues'];

const KNOWN_TYPEIDS = new Set([
  'core.ai.chatCompletion',
  'feature.notifications.nodes.notify',
  'core.trigger.webhook',
  'core.openwop.http.webhook-verify',
  'core.openwop.http.fetch',
]);

describe('devops pack — discovery + typeIds', () => {
  it('loads all four chains with the DevOps category (keyword, not prettified "Devops")', () => {
    for (const id of CHAINS) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(PACK);
      expect(entry!.category).toBe('DevOps');
    }
    expect(listChains().filter((c) => c.packName === PACK)).toHaveLength(4);
  });

  it.each(CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });

  it('every chain is advisory: no external-send sinks, no connectionRef bindings', () => {
    for (const id of CHAINS) {
      const chain = getChain(id)!.chain;
      for (const n of chain.dag.nodes) {
        expect(n.typeId, `${id} must not send externally`).not.toMatch(/email-send|slack-message|sms-send/);
      }
      const req = chainRequirements(chain, KNOWN_TYPEIDS, () => true);
      expect(req.connections).toEqual([]);
      expect(req.missingNodeTypeIds).toEqual([]);
    }
  });
});

describe('devops pack — expansion', () => {
  const sampleParams: Record<string, Record<string, unknown>> = {
    'devops.pr-review': { diffText: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a=1\n+const a=2' },
    'devops.release-notes': { commitLog: 'feat: add exporter\nfix: null crash on empty list' },
    'devops.ci-failure-explainer': {},
    'devops.stale-issues': { repo: 'openwop/openwop' },
  };

  it.each(CHAINS)('%s expands to a validated, deterministic definition', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: sampleParams[id]! });
    expect(def.workflowId.startsWith(`${id}:`)).toBe(true);
    expect(def.nodes).toHaveLength(chain.dag.nodes.length);
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(expandChain(chain, { params: sampleParams[id]! })).toEqual(def);
  });

  it('stale-issues fetches the public GitHub API with the repo param in the URL', () => {
    const chain = getChain('devops.stale-issues')!.chain;
    const fetchNode = chain.dag.nodes.find((n) => n.typeId === 'core.openwop.http.fetch')!;
    const url = (fetchNode.config as { url?: string }).url ?? '';
    expect(url.startsWith('https://api.github.com/repos/{{params.repo}}/issues')).toBe(true);
  });
});
