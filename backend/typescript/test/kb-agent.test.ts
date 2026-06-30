/**
 * feature.kb.agents — a feature-bound manifest agent (ADR 0014 Phase 3). Proves
 * the KB feature ships an agent that the host loads at boot (RFC 0003 agents[]),
 * tool-allowlisted to the feature's own workflow nodes (ctx.features.kb via
 * feature.kb.nodes). The first agent bound to a feature surface.
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
  await new Promise<void>((res) => { server = app.listen(0, res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('feature.kb.agents.researcher', () => {
  it('is loaded into the agent registry at boot', async () => {
    const agent = await getAgentRegistry().resolve('feature.kb.agents.researcher');
    expect(agent).not.toBeNull();
    expect(agent!.persona).toBe('RESEARCH');
    expect(agent!.modelClass).toBe('research');
    // The system prompt resolved from prompts/kb-researcher.md.
    expect(agent!.systemPrompt).toContain('Knowledge Base');
  });

  it('is tool-allowlisted to the KB feature nodes only', async () => {
    const agent = await getAgentRegistry().resolve('feature.kb.agents.researcher');
    const allow = (agent!.toolAllowlist ?? []) as string[];
    expect(allow).toContain('openwop:feature.kb.nodes.search');
    expect(allow).toContain('openwop:feature.kb.nodes.rag');
    // No tool outside the KB feature surface.
    expect(allow.every((t) => t.startsWith('openwop:feature.kb.nodes.'))).toBe(true);
  });
});
