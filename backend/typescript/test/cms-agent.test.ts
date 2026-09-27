/**
 * feature.cms.agents — a feature-bound manifest agent (ADR 0064 Phase 3). Proves
 * the CMS feature ships a localizer agent that the host loads at boot (RFC 0003
 * agents[]), tool-allowlisted to the feature's own workflow nodes (ctx.features
 * .cms via feature.cms.nodes). In this host the agent + nodes ARE the chat-
 * drivable path — there is no separate `content.translate` envelope seam.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('feature.cms.agents.localizer', () => {
  it('is loaded into the agent registry at boot', async () => {
    const agent = await getAgentRegistry().resolve('feature.cms.agents.localizer');
    expect(agent).not.toBeNull();
    expect(agent!.persona).toBe('WRITER');
    // The system prompt resolved from prompts/cms-localizer.md.
    expect(agent!.systemPrompt).toContain('Localizer');
  });

  it('is tool-allowlisted to the CMS feature agent tools only (CFP-1)', async () => {
    const agent = await getAgentRegistry().resolve('feature.cms.agents.localizer');
    const allow = (agent!.toolAllowlist ?? []) as string[];
    // CFP-1: the allowlist moved off the WORKFLOW-node typeIds
    // (`openwop:feature.cms.nodes.*`, which never resolved at chat dispatch) to
    // the registered `openwop:cms.*` agent tools over the same surface owner.
    expect(allow).toContain('openwop:cms.get-page');
    expect(allow).toContain('openwop:cms.translate-section');
    // No tool outside the CMS feature surface.
    expect(allow.every((t) => t.startsWith('openwop:cms.'))).toBe(true);
  });
});
