/**
 * ADR 1003 D4 / ADR 0148 guardrail 3 — a lever that acts says so, in counts.
 *
 * ADR 0148 promised "budgets are configurable and observable" and shipped no
 * record at all: nothing said how many turns the window dropped, how many
 * retrieved items the memory budget cut, or what the tool diet saved. Guardrail
 * 4 ("flip on once measured") had no instrument. These cases pin the one line,
 * `context_economy_applied`, on the tool-diet and memory funnels (the transcript
 * funnel's line, `conversationExchange.ts`, is asserted by no test — a recorded
 * gap, TST-EWF-G1, not claimed here): it fires only when a lever
 * changed something, carries counts and the plain `tenantId` only, and never a
 * tool name or a byte of retrieved content.
 *
 * Sabotage (witnessed 2026-10-29): deleting the log call in `dietToolSurface`
 * or in the memory composition reds its case; logging the tool names or the
 * content reds the "counts only" assertions. Re-witnessed w80, plus: the diet
 * running with its lever off, a negative byte count, a dropped `tenantId`, and
 * the memory budget applied with its lever off (the off case sets a 50-char cap
 * that WOULD drop items, so it can tell off from on).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dietToolSurface } from '../src/providers/toolSchemaCompaction.js';
import { resolveSubjectKnowledgeRetrieve, type SubjectKnowledgeBinding } from '../src/host/agentKnowledgeComposition.js';
import type { AgentMemoryPort } from '../src/host/agentDispatch.js';

const ENV_KEYS = ['OPENWOP_CONTEXT_ECONOMY', 'OPENWOP_CONTEXT_ECONOMY_TOOL_DIET', 'OPENWOP_CONTEXT_ECONOMY_MEMORY', 'OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS'];
const saved: Record<string, string | undefined> = {};
let lines: Array<Record<string, unknown>> = [];

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try { lines.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not a log line */ }
    }
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const MEMORY_ONLY: SubjectKnowledgeBinding = { collectionIds: [], retrieval: { sources: ['memory'] } };
const memoryPort = (contents: string[]): AgentMemoryPort => ({
  read: async () => contents.map((content) => ({ content })),
  write: async () => {},
});

const applied = (): Array<Record<string, unknown>> => lines.filter((l) => l.msg === 'context_economy_applied');

const tools = () => [
  { name: 'secret-tool-name', description: 'd', inputSchema: { type: 'object', title: 'An annotation that costs tokens', properties: { q: { type: 'string', examples: ['x'] } } } },
  { name: 'other', description: 'd', inputSchema: { type: 'object', properties: {} } },
];

describe('context_economy_applied (ADR 1003 D4)', () => {
  it('tool diet off → the same tool objects and no line', () => {
    const input = tools();
    const out = dietToolSurface(input, 't1');
    expect(out[0]).toBe(input[0]);
    expect(applied()).toEqual([]);
  });

  it('tool diet on → one counts-only line per surface', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TOOL_DIET = 'on';
    dietToolSurface(tools(), 't1');
    const got = applied();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ lever: 'tool_diet', tenantId: 't1', toolSchemasCompacted: 2 });
    expect(got[0].toolSchemaBytesSaved).toBeGreaterThan(0);
    // Counts only: no tool name, no schema text.
    expect(JSON.stringify(got[0])).not.toContain('secret-tool-name');
    expect(JSON.stringify(got[0])).not.toContain('annotation');
  });

  it('memory budget drops items → one line with kept/dropped and no content', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY = 'on';
    process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS = '50';
    const memory = memoryPort(['PRIVATE-FACT-ONE '.repeat(3), 'PRIVATE-FACT-TWO '.repeat(3), 'PRIVATE-FACT-THREE '.repeat(3)]);
    const retrieve = resolveSubjectKnowledgeRetrieve('t1', MEMORY_ONLY, memory, 'agent:a');
    expect(retrieve).toBeDefined();
    const items = await retrieve!('q');
    expect(items).toHaveLength(1);
    const got = applied();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ lever: 'memory', tenantId: 't1', memoryKept: 1, memoryDropped: 2 });
    expect(JSON.stringify(got[0])).not.toContain('PRIVATE-FACT');
  });

  it('memory budget off → no line', async () => {
    // The cap is set and WOULD drop two of three items; only the lever is off.
    process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS = '50';
    const memory = memoryPort(['PRIVATE-FACT-ONE '.repeat(3), 'PRIVATE-FACT-TWO '.repeat(3), 'PRIVATE-FACT-THREE '.repeat(3)]);
    const retrieve = resolveSubjectKnowledgeRetrieve('t1', MEMORY_ONLY, memory, 'agent:a');
    expect(retrieve).toBeDefined();
    expect(await retrieve!('q')).toHaveLength(3);
    expect(applied()).toEqual([]);
  });
});
