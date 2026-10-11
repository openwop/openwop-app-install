/**
 * Shared workflow-template library (ADR 0032 Phase 2.0), now a chain pack
 * (ADR 0775 P2).
 *
 * The 44 `tmpl.*` templates the ten work-twins compose used to be a pinned
 * in-tree catalog (`host/workflowTemplates.ts`). P2a–P2c moved all of them to
 * the `work-twin-templates` chain pack and deleted the catalog. This file pins
 * the LIBRARY: 11 categories × 4, and that every id a consumer binds (the
 * seeded twin portfolios, the frontend role templates) is one of them, so a
 * consumer cannot point at a template that does not resolve.
 *
 * Definition-level properties (byte identity with the deleted definitions,
 * node types, gates, composition, real-executor runs) live in
 * `test/work-twin-template-chains.test.ts`. The end-to-end consumer run
 * (heartbeat → `tmpl.it.incident-triage` → completed) is in
 * `test/agents-example-data.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_TEMPLATE_CATEGORIES, WORKFLOW_TEMPLATE_CHAIN_IDS } from '../src/host/workflowTemplates.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK = join(REPO, 'examples/workflow-chain-packs/work-twin-templates/pack.json');
/** `tmpl.<category>.<name>`, kept only when <category> is a library category, so
 *  property reads on an unrelated local named `tmpl` do not count. */
const ID = /\btmpl\.([a-z-]+)\.([a-z0-9-]+)\b/g;
const boundIds = (text: string): string[] =>
  [...text.matchAll(ID)].filter((m) => (WORKFLOW_TEMPLATE_CATEGORIES as readonly string[]).includes(m[1]!)).map((m) => m[0]);

describe('workflow-template library — shape', () => {
  it('ships exactly 44 templates (11 categories × 4), unique ids', () => {
    expect(WORKFLOW_TEMPLATE_CHAIN_IDS).toHaveLength(44);
    expect(new Set(WORKFLOW_TEMPLATE_CHAIN_IDS).size).toBe(44);
    expect(WORKFLOW_TEMPLATE_CATEGORIES).toHaveLength(11);
    for (const category of WORKFLOW_TEMPLATE_CATEGORIES) {
      expect(WORKFLOW_TEMPLATE_CHAIN_IDS.filter((id) => id.split('.')[1] === category), category).toHaveLength(4);
    }
  });

  it('the registration list and the pack name the same chains', () => {
    const pack = JSON.parse(readFileSync(PACK, 'utf8')) as { chains: Array<{ chainId: string }> };
    expect(pack.chains.map((c) => c.chainId).sort()).toEqual([...WORKFLOW_TEMPLATE_CHAIN_IDS].sort());
  });
});

describe('workflow-template library — consumers bind only ids that resolve', () => {
  const consumers = [
    'backend/typescript/src/host/seed-data/exampleAgents.json',
    'frontend/react/src/agents/roleTemplates.ts',
  ];
  for (const rel of consumers) {
    it(`${rel}`, () => {
      const ids = boundIds(readFileSync(join(REPO, rel), 'utf8'));
      // Non-vacuity: both consumers bind templates today.
      expect(ids.length, rel).toBeGreaterThan(0);
      for (const id of ids) expect(WORKFLOW_TEMPLATE_CHAIN_IDS, `${rel} binds ${id}`).toContain(id);
    });
  }
});
