import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentEventToEmit } from '../src/host/agentRunnerNode.js';

describe('ADR 0722 — the agent-event union discriminator never reaches a payload', () => {
  it('strips `type` and keeps every other field', () => {
    const [type, payload] = agentEventToEmit({ type: 'agent.reasoned', agentId: 'a1', summary: 'evaluated' } as never);
    expect(type).toBe('agent.reasoned');
    expect(payload).toEqual({ agentId: 'a1', summary: 'evaluated' });
    expect('type' in payload).toBe(false);
  });
  it('the emit loop goes through the helper — the spread is gone from the source', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'agentRunnerNode.ts'), 'utf8');
    expect(src).not.toMatch(/ctx\.emit\(ev\.type,\s*\{\s*\.\.\.ev\s*\}\)/);
    expect(src).toMatch(/agentEventToEmit\(ev\)/);
  });
});
