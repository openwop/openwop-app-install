/**
 * NP-EVAL-1 / AEV-5 ratchet — every chat tool this host registers is REACHABLE by
 * some agent, or is a named exception with its reason.
 *
 * Why this exists: ADR 0889 D8 registered three agent-eval tools, called them
 * "pack-allowlisted", and no pack allowlisted them. `filterTools` matches exact
 * ids, the tools are not in the ADR 0315 default-on baseline, so no shipped agent
 * could list, run or read an eval, and the LLM-exchange tracker graded the row
 * A-. Nothing noticed, because nothing asked whether a registered tool is offered
 * to anyone.
 *
 * Reachable = the ADR 0315 baseline ∪ a shipped pack's `agents[].toolAllowlist`
 * (`packs/**`, `examples/**`) ∪ a host-composed lane allowlist (KickBot, the one
 * such lane, imported, never copied). The denominator is the LIVE
 * `builtinAgentToolIds()` after a real boot (the safe-mode-baseline-census
 * precedent: registration is a runtime mutation).
 *
 * Both exception maps are EXACT: a new unreachable tool fails until it is reached
 * or listed, and a listed tool that becomes reachable fails until it is removed.
 * Sabotage-witnessed: dropping the three eval ids from the Agent Author pack reds
 * both the reach assertion and the eval pin below.
 */
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { DEFAULT_ON_AGENT_TOOL_IDS } from '../src/host/agentToolAllowlistService.js';
import { KICKBOT_TOOL_ALLOWLIST } from '../src/features/kicktodo-core/kickbotService.js';
import {
  AGENT_EVALS_GET_SUMMARY_TOOL_ID,
  AGENT_EVALS_LIST_SUITES_TOOL_ID,
  AGENT_EVALS_RUN_TOOL_ID,
} from '../src/host/evals/agentTools.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Unreached ON PURPOSE: granting it is the decision, and the default is none. */
const BY_DESIGN: Readonly<Record<string, string>> = {
  'openwop:workflows.compose-and-run': 'ADR 0369 §6: runs a model-written workflow unreviewed; granted per agent by an operator, zero by default',
};

/** Unreached DEBT: registered for a persona no shipped pack provides yet. Shrink-only. */
const UNREACHED_DEBT: Readonly<Record<string, string>> = {
  'openwop:conversations.export-document': 'ADR 0119: for record-keeping personas; no shipped pack allowlists it yet (chat-export/agentTools.ts header)',
  'openwop:destination-sync.list': 'CHAT-FIRST-PORT D7: no destination-sync agent pack; deferred to the CDP ops console',
  'openwop:destination-sync.dry-run': 'CHAT-FIRST-PORT D7: no destination-sync agent pack; deferred to the CDP ops console',
  'openwop:destination-sync.run': 'CHAT-FIRST-PORT D7: no destination-sync agent pack; deferred to the CDP ops console',
  'openwop:entities.describe-type': 'ADR 0386 P6: registered for the content-model chat lane; no shipped pack allowlists it yet',
  'openwop:entities.query': 'ADR 0386 P6: registered for the content-model chat lane; no shipped pack allowlists it yet',
  'openwop:work-selection.preview': 'ADR 0534 P4: registered for the work-loop chat lane; no shipped pack allowlists it yet',
};

interface Manifest { name?: string; agents?: Array<{ agentId?: string; toolAllowlist?: string[] }> }

function shippedManifests(): Manifest[] {
  const out: Manifest[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'pack.json') out.push(JSON.parse(readFileSync(p, 'utf8')) as Manifest);
    }
  };
  for (const root of ['packs', 'examples']) if (existsSync(join(REPO_ROOT, root))) walk(join(REPO_ROOT, root));
  return out;
}

let server: http.Server | undefined;
beforeAll(async () => {
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
}, 120_000);
afterAll(() => { server?.close(); });

describe('every registered chat tool is reachable by an agent, or a named exception', () => {
  it('the reachable set ∪ the exceptions covers the live tool set exactly', () => {
    const manifests = shippedManifests();
    const reachable = new Set<string>([
      ...DEFAULT_ON_AGENT_TOOL_IDS,
      ...KICKBOT_TOOL_ALLOWLIST,
      ...manifests.flatMap((m) => (m.agents ?? []).flatMap((a) => a.toolAllowlist ?? [])),
    ]);
    const live = [...builtinAgentToolIds()].sort();
    expect(live.length).toBeGreaterThan(150);
    const exceptions = { ...BY_DESIGN, ...UNREACHED_DEBT };
    const unreached = live.filter((id) => !reachable.has(id) && !(id in exceptions));
    expect(unreached, 'registered but offered to no agent: allowlist it in a pack, or add a named exception with its reason').toEqual([]);
    const stale = Object.keys(exceptions).filter((id) => reachable.has(id) || !live.includes(id));
    expect(stale, 'an exception that is now reachable (or no longer registered): remove it').toEqual([]);
  });

  it('the agent-eval tools are reached through the Agent Author pack (ADR 0889 D8)', () => {
    const pack = shippedManifests().find((m) => m.name === 'vendor.openwop-app.agent-author.agents');
    const allow = pack?.agents?.find((a) => a.agentId === 'vendor.openwop-app.agent-author.agents.agent-author')?.toolAllowlist ?? [];
    const prompt = readFileSync(join(REPO_ROOT, 'packs/vendor.openwop-app.agent-author.agents/prompts/agent-author.md'), 'utf8');
    for (const id of [AGENT_EVALS_LIST_SUITES_TOOL_ID, AGENT_EVALS_RUN_TOOL_ID, AGENT_EVALS_GET_SUMMARY_TOOL_ID]) {
      expect(allow, `${id} allowlisted`).toContain(id);
      expect(prompt, `${id} explained in the prompt`).toContain(`\`${id}\``);
      expect(DEFAULT_ON_AGENT_TOOL_IDS, `${id} must stay OUT of the default-on baseline`).not.toContain(id);
    }
  });
});
