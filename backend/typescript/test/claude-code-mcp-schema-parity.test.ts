/**
 * ADR 0785 P3 — CLAUDE.md non-negotiable: schema text reaching a model is
 * generated from its SSoT or TEST-PINNED to it. The Claude Code MCP tools' input
 * schemas exist in three places (the TS specs, the mcp-tool-projections chain
 * pack the registry actually SERVES, and — for schema-lookup — the chat tool
 * `openwop:schema.lookup` it mirrors). This pins all three together, reading
 * what the MCP registry serves, not what a source file claims.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { listTools } from '../src/host/mcpServerRegistry.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { claudeCodeMcpToolWorkflows } from '../src/features/claude-code/mcpTools.js';

type Schema = { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties?: boolean };

/** The contract a model acts on — types, enums, items, required — without prose. */
function shape(s: Schema): unknown {
  const props = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => {
    const { description: _d, ...rest } = v;
    return [k, rest];
  }));
  return { type: s.type, properties: props, required: [...(s.required ?? [])].sort(), additionalProperties: s.additionalProperties };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('ADR 0785 P3 — Claude Code MCP tool schemas are pinned', () => {
  const sourceSchema = (name: string): Schema => {
    const wf = claudeCodeMcpToolWorkflows.find((w) => (w.metadata as { mcpTool?: string }).mcpTool === name);
    return (wf?.nodes.find((n) => n.nodeId === 'expose')?.config as { inputSchema: Schema }).inputSchema;
  };

  it('what the registry SERVES (from the chain pack) equals the TS source, tool by tool', () => {
    const served = listTools().filter((t) => t.name.startsWith('claude-code-'));
    expect(served.map((t) => t.name).sort()).toEqual(['claude-code-add-todo', 'claude-code-my-todos', 'claude-code-permission', 'claude-code-schema-lookup']);
    for (const t of served) {
      expect(t.inputSchema, t.name).toEqual(sourceSchema(t.name));
    }
  });

  it('claude-code-schema-lookup offers exactly the contract of openwop:schema.lookup (the lookup they share)', () => {
    const chat = builtinAgentTool('openwop:schema.lookup')?.def.inputSchema as Schema;
    expect(chat).toBeTruthy();
    expect(shape(sourceSchema('claude-code-schema-lookup'))).toEqual(shape(chat));
  });
});
