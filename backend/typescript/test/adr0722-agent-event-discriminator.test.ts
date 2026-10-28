import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentEventToEmit } from '../src/host/agentRunnerNode.js';
import type { AgentEvent } from '../src/host/agentDispatch.js';

/**
 * ADR 0722 — the RFC 0064 `agent.*` union discriminator (`type`) is the event's
 * NAME, never part of its payload: the closed payload defs refuse a stray `type`.
 *
 * Tracker TST-BGF-22. Red when `agentEventToEmit` keeps `type` in the payload, or
 * when the agent-runner emit loop stops emitting the helper's payload (e.g. emits
 * `{ ...ev }` again).
 *
 * CEILING: leg 2 is a source check of the emit loop. A behavioural leg needs a
 * provider-backed agent run (the helper is exported precisely to avoid that).
 */
describe('ADR 0722 — the agent-event union discriminator never reaches a payload', () => {
  it('strips `type` and keeps every other field', () => {
    const ev: AgentEvent = { type: 'agent.reasoned', agentId: 'a1', summary: 'evaluated' };
    const [type, payload] = agentEventToEmit(ev);
    expect(type).toBe('agent.reasoned');
    expect(payload).toEqual({ agentId: 'a1', summary: 'evaluated' });
    expect('type' in payload).toBe(false);
  });
  it('the emit loop goes through the helper — the spread is gone from the source', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'agentRunnerNode.ts'), 'utf8');
    expect(src).not.toMatch(/ctx\.emit\(ev\.type,\s*\{\s*\.\.\.ev\s*\}\)/);
    // The PAIR: the helper's split AND the emit of exactly what it returned.
    expect(src).toMatch(/const \[type, payload\] = agentEventToEmit\(ev\);\s*await ctx\.emit\(type, payload\);/);
  });
});
