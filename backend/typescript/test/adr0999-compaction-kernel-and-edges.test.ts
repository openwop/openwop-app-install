/**
 * ADR 0999 — tool-output compaction: the kernel's remaining defects and the two
 * edges of the model round trip (an error result going in, a marker coming back).
 *
 * Each case names the sabotage that turns it red (all witnessed 2026-10-28):
 *  - D5.1: build `record()` as `{}` instead of `Object.create(null)` → the
 *    `__proto__` case reds (the key vanishes, and nothing discloses it).
 *  - D5.2: drop `isElidableRowList(v)` from `elideArrays` → the scalar-array case
 *    reds (an object lands in a string enum).
 *  - D5.3: drop the `_elided` own-key check from `isElidableRowList` → the
 *    collision case reds.
 *  - D5.4: remove the try/catch around the lossy transform → both deep-nesting
 *    cases red (the kernel and the explicit surface throw `RangeError`).
 *  - D4: remove the `isError` downgrade in `applyToolResultTransform` → the
 *    error cases red (a validation-issue list is elided); drop the `isError`
 *    spread at the `agentDispatch` call site → the runChatToolLoop case reds.
 *  - D3.2: make `findCompactionMarkerPath` return `undefined` → the marker cases
 *    and the tool-loop refusal red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';
import { buildToolOutputCompactionSurface } from '../src/features/tool-output-compaction/surface.js';
import {
  applyToolResultTransform,
  registerToolResultTransform,
  __resetToolResultTransform,
  findCompactionMarkerPath,
  COMPACTION_MARKER_IN_INPUT,
} from '../src/host/toolResultTransform.js';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const LOSSY = { mode: 'lossy' as const, head: 1, tail: 1 };
const rows = (n: number): Array<{ id: string; label: string }> =>
  Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, label: `a fairly long label for row ${i}` }));

describe('ADR 0999 D5 — the lossy kernel', () => {
  it('D5.1 (TOCC-9) — a `__proto__` payload key survives as an ordinary key', () => {
    const src = JSON.stringify({ items: rows(8) }).replace('{"items"', '{"__proto__":{"x":1},"items"');
    const out = compactToolOutput(src, LOSSY);
    expect(out).not.toBe(src); // the rows were elided, so this is a real transform, not passthrough
    expect(out).toContain('"__proto__":{"x":1}');
  });

  it('D5.2 (TOCC-8) — an array of scalars is never elided (no object in a string enum)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `product-id-number-${i}`);
    const src = JSON.stringify({ productIds: ids, rows: rows(8) });
    const out = JSON.parse(compactToolOutput(src, LOSSY)) as { productIds: unknown[]; rows: unknown[] };
    expect(out.productIds).toEqual(ids);
    // ...while a row list in the same payload still is — the mode still does its job.
    expect(out.rows).toHaveLength(3);
    expect(out.rows[1]).toEqual({ _elided: 6 });
  });

  it('D5.3 (TOC2CD-7) — a row list that already carries an `_elided` row is left whole', () => {
    const own = [...rows(6), { _elided: 99, id: 'real' }];
    const src = JSON.stringify({ rows: own });
    const out = JSON.parse(compactToolOutput(src, LOSSY)) as { rows: unknown[] };
    expect(out.rows).toEqual(own);
  });

  it('D5.4 (TOCC-7) — a 20,000-deep payload never throws, from the kernel or the explicit surface', async () => {
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    expect(JSON.parse(deep)).toBeDefined(); // the validator accepts it, so the transform is reached
    expect(compactToolOutput(deep, LOSSY)).toBe(deep);
    const surface = buildToolOutputCompactionSurface({} as never);
    const compact = surface.compact as (a: Record<string, unknown>) => Promise<{ output: string }>;
    await expect(compact({ input: deep, mode: 'lossy' })).resolves.toMatchObject({ output: deep });
  });
});

describe('ADR 0999 D4 — an error result is never lossy-compacted', () => {
  beforeEach(() => registerToolResultTransform((c, ctx) => (ctx.decision ? compactToolOutput(c, ctx.decision) : c)));
  afterEach(() => __resetToolResultTransform());

  const issues = JSON.stringify({ error: 'validation_error', issues: rows(12) }, null, 2);

  it('keeps every issue (whitespace-only) when the result is an error', () => {
    const out = applyToolResultTransform(issues, { decision: LOSSY, toolName: 'openwop:x.persist', isError: true });
    expect(out).not.toContain('_elided');
    expect(JSON.parse(out)).toEqual(JSON.parse(issues));
    expect(out.length).toBeLessThan(issues.length); // lossless still applied
  });

  it('control — the same payload as a SUCCESS is elided (the downgrade is what kept it)', () => {
    expect(applyToolResultTransform(issues, { decision: LOSSY, toolName: 'openwop:x.persist' })).toContain('_elided');
  });

  /** Wired, not only the helper (review M1): the real tool loop passes `isError`. */
  async function loopWith(result: { content: string; isError?: boolean }) {
    const tool: CompiledTool = { def: { name: 'openwop:x.persist', description: 'd', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };
    const seen: AiToolCallRequest[] = [];
    let round = 0;
    const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
      seen.push(r);
      round += 1;
      return round === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'openwop:x.persist', input: {} }] } : { content: 'ok', toolCalls: [] };
    };
    await runChatToolLoop(
      { provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user' as const, content: 'save' }], tools: [tool], agentId: 'a', persona: 'P', compaction: LOSSY },
      { callAIWithTools, executeTool: vi.fn().mockResolvedValue(result) },
    );
    const last = [...seen[1]!.messages].reverse().find((m) => m.role === 'user');
    return typeof last?.content === 'string' ? last.content : '';
  }

  it('runChatToolLoop: a failed tool\'s issue list reaches the repair turn whole', async () => {
    const msg = await loopWith({ content: issues, isError: true });
    expect(msg).toContain('row-11'); // the LAST issue — the middle is what elision drops
    expect(msg).toContain('row-5');
    expect(msg).not.toContain('_elided');
  });

  it('runChatToolLoop control: the same content as a success IS elided', async () => {
    expect(await loopWith({ content: issues })).toContain('_elided');
  });
});

describe('ADR 0999 D3.2 — a compaction marker sent back to a tool is refused', () => {
  it('finds the marker element the kernel writes, with its path', () => {
    const elided = JSON.parse(compactToolOutput(JSON.stringify({ steps: rows(9) }), LOSSY)) as unknown;
    expect(findCompactionMarkerPath({ funnelId: 'f1', ...(elided as object) })).toBe('$.steps[1]');
  });

  it('does not fire on ordinary data', () => {
    expect(findCompactionMarkerPath({ steps: rows(9), _elided: 3, meta: { _elided: 2 } })).toBeUndefined();
    expect(findCompactionMarkerPath({ rows: [{ _elided: 1, id: 'x' }] })).toBeUndefined(); // more than one key
    expect(findCompactionMarkerPath({ rows: [{ _elided: 'n' }] })).toBeUndefined(); // not a number
  });

  /** A real `runChatToolLoop` round: the model sends a marker back; the tool must not run. */
  async function loop(decision: { mode: 'lossy' | 'lossless' }) {
    const tool: CompiledTool = { def: { name: 'openwop:funnels.draft', description: 'd', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };
    let round = 0;
    const callAIWithTools = async (_r: AiToolCallRequest): Promise<AiToolCallResult> => {
      round += 1;
      return round === 1
        ? { content: '', toolCalls: [{ id: 'c1', name: 'openwop:funnels.draft', input: { funnelId: 'f1', steps: [{ id: 's0' }, { _elided: 4 }, { id: 's5' }] } }] }
        : { content: 'done', toolCalls: [] };
    };
    const executeTool = vi.fn().mockResolvedValue({ content: '{"ok":true}' });
    const res = await runChatToolLoop(
      {
        provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user' as const, content: 'revise the funnel' }],
        tools: [tool], agentId: 'a', persona: 'P', compaction: decision,
      },
      { callAIWithTools, executeTool },
    );
    return { executeTool, events: res.events as unknown as Array<Record<string, unknown>> };
  }

  it('under a lossy decision the write tool never runs, and the refusal is a typed tool error', async () => {
    const { executeTool, events } = await loop({ mode: 'lossy' });
    expect(executeTool).not.toHaveBeenCalled();
    const returned = events.find((e) => e.type === 'agent.toolReturned');
    expect(returned).toMatchObject({ status: 'error', error: { code: COMPACTION_MARKER_IN_INPUT } });
    expect(returned).not.toHaveProperty('durationMs'); // the tool never ran
  });

  it('control — without a lossy decision the same input runs (no marker can have come from us)', async () => {
    const { executeTool } = await loop({ mode: 'lossless' });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
