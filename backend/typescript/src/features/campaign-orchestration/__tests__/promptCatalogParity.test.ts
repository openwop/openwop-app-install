/**
 * ADR 0942 P6 — the Campaign Strategist (campaign-orchestration pack) prompt ↔
 * its tools and its review-policy facts.
 *
 * `agent-prompt-tool-ids.test.ts` catches a PHANTOM id (a prompt naming a tool
 * nobody registers). It cannot catch the reverse: a tool the agent is given that
 * its prompt never explains, or a prompt sentence that stopped being true. This
 * pins both for this agent:
 *   - the allowlist is exactly the tools this feature registers, and the prompt
 *     names every one of them;
 *   - the prompt does not claim a gate always waits for a person (P2 made the
 *     kernel gate the autonomy gate, so whether it waits is the policy's call);
 *   - the place the prompt sends people to change a policy is the panel's real
 *     title (the SPA's `autTitle`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID } from '../agentTools.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../../../../../..');
const PACK = join(ROOT, 'packs/vendor.openwop-app.campaign-orchestration.agents');
const prompt = readFileSync(join(PACK, 'prompts/campaign-strategist.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(PACK, 'pack.json'), 'utf8')) as { agents: Array<{ toolAllowlist: string[] }> };
const REGISTERED = [CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID, CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID];

describe('campaign-strategist (orchestration) prompt parity — ADR 0942 P6', () => {
  it('the allowlist is exactly the registered tools, and the prompt explains each one', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...REGISTERED].sort());
    for (const id of REGISTERED) expect(prompt, `prompt must explain ${id}`).toContain(`\`${id}\``);
    expect(prompt).toMatch(/You have four tools/);
  });

  it('does not claim a gate always waits for a person', () => {
    expect(prompt).not.toMatch(/nothing proceeds until they approve/i);
    expect(prompt).not.toMatch(/The human approves the kernel and each channel/);
    expect(prompt).toMatch(/set by the campaign's review\s+policy/);
  });

  it('sends people to the panel by its real title', () => {
    const en = readFileSync(join(ROOT, 'frontend/react/src/features/campaign-orchestration/i18n/en.ts'), 'utf8');
    const title = /\n {2}autTitle: "([^"]+)",/.exec(en)?.[1];
    expect(title).toBe('Review policy');
    expect(prompt).toContain(`**${title}**`);
  });
});
