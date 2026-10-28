/**
 * ADR 0889 NP-EVAL-3 — the flagship agent packs ship eval suites that load
 * through the real `evalSuiteRef` path and discriminate.
 *
 * Why this exists: until this, no shipped pack carried a suite, so the D2 loader,
 * the D10 `--changed` hook and the Evals-tab "Pack" chip were exercised only by a
 * temp fixture. Each suite here is loaded from the REAL pack directory (steward-
 * attested by `packs/.steward-manifest.json`) and run twice through
 * `POST /runs {mode:"eval"}` with the scripted mock (the test seam):
 *   - a script that follows the agent's prompt rules ⇒ every task passes;
 *   - a script that breaks them (writes before reading, skips draft mode, persists
 *     outside the closed world) ⇒ every task fails.
 * A suite that passed both would be a gate that cannot fail. The suites are
 * replay-only (`onMiss:"fail"`), so neither run reaches a real tool: the Agent
 * Author's roster is asserted unchanged.
 *
 * Tracker TST-BHG-5. Red when (sabotage-witnessed, wave 62): the in-order trajectory
 * grader (host/evals/trajectory.ts) accepts any call sequence, so a rule-breaking
 * script passes both shipped suites.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '../../../packs');
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
let server: Server; let base = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const dir of ['vendor.openwop-app.agent-author.agents', 'vendor.openwop-app.workflow-author.agents']) {
    loadAgentsFromManifest(join(PACKS, dir));
  }
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted by the caller */ }
  return { status: res.status, json, text };
}

type Round = { toolCalls: Array<{ name: string; input: Record<string, unknown> }> } | { content: string };
const call = (name: string, input: Record<string, unknown> = {}): Round => ({ toolCalls: [{ name, input }] });
const say = (content: string): Round => ({ content });

interface Summary { passed: boolean; passedCount: number; taskCount: number; tasks: Array<{ taskId: string; passed: boolean }> }
/** A narrow guard over the eval-summary wire JSON (no cast). */
function isSummary(x: unknown): x is Summary {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as { passed?: unknown; passedCount?: unknown; taskCount?: unknown; tasks?: unknown };
  return typeof s.passed === 'boolean' && typeof s.passedCount === 'number' && typeof s.taskCount === 'number' && Array.isArray(s.tasks);
}

async function runSuite(suiteRef: string, agentId: string, rounds: Record<string, Round[]>): Promise<Summary> {
  const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: suiteRef, agentId, configurable: { mockProvider: { id: 'tool-calls', rounds } } });
  expect(c.status, c.text.slice(0, 400)).toBe(201);
  const runId = String(c.json['runId']);
  await vi.waitFor(async () => {
    const r = await send('GET', `/runs/${runId}`);
    expect(['completed', 'failed', 'cancelled']).toContain(String(r.json['status']));
  }, { timeout: 15_000, interval: 25 });
  const s = await send('GET', `/runs/${runId}/eval-summary`);
  expect(s.status, s.text.slice(0, 400)).toBe(200);
  if (!isSummary(s.json)) throw new Error(`eval-summary is not a summary: ${s.text.slice(0, 400)}`);
  return s.json;
}

const AA = 'vendor.openwop-app.agent-author.agents.agent-author';
const AA_SUITE = 'vendor.openwop-app.agent-author.evals.agent-author@1.0.0';
const N = 'openwop:feature.agent-author.nodes.';

describe('Agent Author pack suite (evals/agent-author.json)', () => {
  it('loads from the pack and lists as a locked pack suite', async () => {
    expect(getAgentRegistry().get(AA)?.evalSuite).toBeDefined();
    const r = await send('GET', `/host/openwop-app/agent-evals/suites?agentId=${AA}`);
    const items = r.json['items'] as Array<{ ref: string; source: string; locked: boolean }>;
    expect(items.find((i) => i.ref === AA_SUITE)).toMatchObject({ source: 'pack', locked: true });
  });

  it('passes an agent that follows its rules', async () => {
    const draft = { persona: 'Scout', agentId: 'core.openwop.agents.deep-research.default' };
    const s = await runSuite(AA_SUITE, AA, {
      'create-research-agent': [call(`${N}get`), call(`${N}draft`, { intent: 'competitor news' }), call(`${N}validate`, { draft }), call(`${N}persist`, { draft }), say('Scout was created disabled. Review and enable it at /agents.')],
      'draft-mode-on-request': [call(`${N}get`), call(`${N}persist`, { draft, mode: 'draft' }), say('Nothing was created. Your draft is waiting in the wizard at /agents/new.')],
      'closed-world-no-fit': [call(`${N}get`), say('No agent in your catalog can trade stocks, so I did not create one.')],
    });
    expect(s.tasks.map((t) => [t.taskId, t.passed])).toEqual(s.tasks.map((t) => [t.taskId, true]));
    expect(s).toMatchObject({ passed: true, passedCount: 3, taskCount: 3 });
  });

  it('fails an agent that writes before reading, ignores draft mode, or leaves the closed world', async () => {
    const draft = { persona: 'Scout', agentId: 'core.openwop.agents.deep-research.default' };
    const s = await runSuite(AA_SUITE, AA, {
      'create-research-agent': [call(`${N}persist`, { draft }), say('Scout was created disabled.')],
      'draft-mode-on-request': [call(`${N}get`), call(`${N}persist`, { draft }), say('Done, see /agents/new.')],
      'closed-world-no-fit': [call(`${N}get`), call(`${N}persist`, { draft: { persona: 'Trader', agentId: 'invented.trader' } }), say('Created.')],
    });
    expect(s.tasks.filter((t) => t.passed)).toEqual([]);
    expect(s.passed).toBe(false);
    // Replay-only: neither run reached the real persist (no roster entry exists).
    const roster = await send('GET', '/host/openwop-app/roster');
    expect(roster.status, roster.text.slice(0, 200)).toBe(200);
    expect(JSON.stringify(roster.json)).not.toContain('Scout');
  });
});

const WA = 'vendor.openwop-app.workflow-author.agents.workflow-architect';
const WA_SUITE = 'vendor.openwop-app.workflow-author.evals.workflow-architect@1.0.0';
const W = 'openwop:feature.workflow-author.nodes.';

describe('Workflow Architect pack suite (evals/workflow-architect.json)', () => {
  it('passes an agent that searches, validates, persists, and reads before changing', async () => {
    const def = { workflowId: 'x', nodes: [], edges: [] };
    const s = await runSuite(WA_SUITE, WA, {
      'author-new-workflow': [call(`${W}draft`, { query: 'send email' }), call(`${W}validate`, { definition: def }), call(`${W}persist`, { definition: def }), say('Registered email-sales-new-lead; open it in the builder.')],
      'change-reads-before-writing': [call('openwop:feature.builder-pair.nodes.read-canvas'), call(`${W}get`, { workflowId: 'lead-intake' }), call(`${W}validate`, { definition: def }), call(`${W}persist`, { definition: def, baseRevision: 'r7' }), say('Changed the subject; the previous version is in History.')],
    });
    expect(s).toMatchObject({ passed: true, passedCount: 2, taskCount: 2 });
  });

  it('fails an agent that persists without validating, or overwrites without reading the revision', async () => {
    const def = { workflowId: 'x', nodes: [], edges: [] };
    const s = await runSuite(WA_SUITE, WA, {
      'author-new-workflow': [call(`${W}draft`, { query: 'send email' }), call(`${W}persist`, { definition: def }), say('Done.')],
      'change-reads-before-writing': [call(`${W}persist`, { definition: def }), say('Changed it.')],
    });
    expect(s.tasks.filter((t) => t.passed)).toEqual([]);
    expect(s.passed).toBe(false);
  });
});
