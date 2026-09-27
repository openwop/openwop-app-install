/**
 * XCH-VOICE-1 / XCH-VOICE-3 (LLM-EXCHANGE-AUDIT Wave 5): the ADR 0324
 * "parity" test pins execution SCOPE; nothing pinned the offered tool SET.
 * A regression dropping five of the six ADR 0315 baseline tools from voice
 * (or the '_decls' synthetic-tenant resolution diverging from a real
 * tenant's) shipped green. Pin both:
 *  1. voice-offered decls == chat-compiled tools for the same agent
 *     (name-for-name, modulo the #578 wire sanitization);
 *  2. every DEFAULT_ON_AGENT_TOOL_IDS baseline tool is offered over voice;
 *  3. the '_decls' synthetic tenant resolves the same defs a real tenant does.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { resolveAgentToolDecls } from '../src/features/voice/realtime/toolBridge.js';
import { sanitizeToolName } from '../src/providers/dispatchProviderTools.js';
import { compileAgentTools } from '../src/host/agentDispatch.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { effectiveToolAllowlist, DEFAULT_ON_AGENT_TOOL_IDS } from '../src/host/agentToolAllowlistService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  getAgentRegistry().register({
    agentId: 'probe.setparity.agent', persona: 'Set Parity Probe', modelClass: 'chat',
    systemPrompt: 'x', toolAllowlist: ['openwop:knowledge.search'], packName: 'test.setparity', packVersion: '0.0.1',
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('voice-offered tool SET == chat-compiled tool SET (XCH-VOICE-1)', () => {
  it('matches name-for-name for the same agent (modulo wire sanitization)', async () => {
    const agent = getAgentRegistry().get('probe.setparity.agent');
    expect(agent).toBeTruthy();
    const { resolveTool } = createAgentToolProvider({ tenantId: 'default' });
    const chatCompiled = compileAgentTools(agent!, builtinAgentToolIds(), resolveTool, effectiveToolAllowlist(agent!.toolAllowlist, undefined));
    const chatNames = chatCompiled.map((t) => sanitizeToolName(t.def.name)).sort();
    const voiceNames = (await resolveAgentToolDecls('default', 'probe.setparity.agent')).map((d) => d.name).sort();
    expect(voiceNames).toEqual(chatNames);
  });

  it('offers EVERY ADR 0315 baseline tool over voice', async () => {
    const voiceNames = (await resolveAgentToolDecls('default', 'probe.setparity.agent')).map((d) => d.name);
    for (const id of DEFAULT_ON_AGENT_TOOL_IDS) {
      expect(voiceNames, `baseline tool ${id} must be offered over voice`).toContain(sanitizeToolName(id));
    }
    expect(DEFAULT_ON_AGENT_TOOL_IDS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the '_decls' synthetic tenant resolves like a real tenant (XCH-VOICE-3)", () => {
  it('builtin defs are tenant-independent for the offered set', () => {
    const synthetic = createAgentToolProvider({ tenantId: '_decls' });
    const real = createAgentToolProvider({ tenantId: 'default' });
    for (const id of builtinAgentToolIds()) {
      const a = synthetic.resolveTool(id);
      const b = real.resolveTool(id);
      expect(!!a, `synthetic '_decls' must resolve ${id}`).toBe(!!b);
      if (a && b) expect(a.name).toBe(b.name);
    }
  });
});
