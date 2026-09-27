/**
 * Content & Monitoring workflow-chain pack (ADR 0190 Phase 3).
 *
 * Feed/page watching WITHOUT a host RSS poller: each chain pairs a schedule
 * trigger with durable seen-state in host KV (deterministic per-source key,
 * first run seeds the baseline). The repo-wide conventions suite
 * (workflow-chain-knowledge-inbox.test.ts) additionally covers gating and
 * live-param rules for this pack automatically.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

const PACK = 'core.openwop.workflows.content';
const CHAINS = ['content.feed-watch', 'content.page-watch'];

const KNOWN_TYPEIDS = new Set([
  'core.trigger.schedule',
  'core.openwop.http.fetch',
  'core.storage.kv-get',
  'core.storage.kv-set',
  'core.ai.chatCompletion',
  'feature.notifications.nodes.notify',
]);

describe('content pack — discovery + typeIds', () => {
  it('loads both watch chains with the Content category', () => {
    for (const id of CHAINS) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(PACK);
      expect(entry!.category).toBe('Content');
    }
    expect(listChains().filter((c) => c.packName === PACK)).toHaveLength(2);
  });

  it.each(CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('content pack — durable seen-state wiring', () => {
  it.each(CHAINS)('%s keys its KV state deterministically per source URL', (id) => {
    const chain = getChain(id)!.chain;
    const kvNodes = chain.dag.nodes.filter((n) => n.typeId.startsWith('core.storage.kv-'));
    expect(kvNodes).toHaveLength(2); // one get, one set
    const keys = kvNodes.map((n) => (n.inputs as { key?: string }).key);
    // get + set MUST address the same param-derived key or the watch never converges.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/\{\{params\.(feedUrl|pageUrl)\}\}/);
    // Namespaces are per-chain so feed and page state never collide.
    const namespaces = kvNodes.map((n) => (n.config as { namespace?: string }).namespace);
    expect(new Set(namespaces).size).toBe(1);
  });

  it('the two chains use distinct KV namespaces', () => {
    const ns = CHAINS.map((id) =>
      (getChain(id)!.chain.dag.nodes.find((n) => n.typeId === 'core.storage.kv-get')!.config as { namespace?: string }).namespace,
    );
    expect(new Set(ns).size).toBe(2);
  });
});

describe('content pack — expansion', () => {
  const sampleParams: Record<string, Record<string, unknown>> = {
    'content.feed-watch': { feedUrl: 'https://example.com/blog.xml' },
    'content.page-watch': { pageUrl: 'https://example.com/pricing' },
  };

  it.each(CHAINS)('%s expands to a validated, deterministic definition', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: sampleParams[id]! });
    expect(def.workflowId.startsWith(`${id}:`)).toBe(true);
    expect(def.nodes).toHaveLength(chain.dag.nodes.length);
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(expandChain(chain, { params: sampleParams[id]! })).toEqual(def);
  });
});
