/**
 * `receivedMaxTokens` — the store behind `GET …/test/mock-ai/dispatch-budgets`
 * (host-sample-test-seams.md §28, RFC 0033 §C witness).
 *
 * The conformance leg compares each attempt's budget with the one before it, so
 * the history must be per attempt (what that call carried, never a running
 * total), in call order, and cleared when the program is re-seeded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatchMock, programMock, receivedMaxTokens, lastReceivedMaxTokens, resetMockPrograms } from '../src/providers/dispatchMock.js';
import type { DispatchRequest } from '../src/providers/dispatch.js';

const NODE = 'dispatch-budgets-probe';

function call(maxTokens: number | undefined): Promise<unknown> {
  const req = { provider: 'mock', model: 'mock-mini', messages: [{ role: 'user', content: 'x' }], maxTokens, nodeId: NODE } as unknown as DispatchRequest & { nodeId: string };
  return dispatchMock(req);
}

describe('mock-ai dispatch-budgets history', () => {
  beforeEach(() => resetMockPrograms());

  it('records every call’s own maxTokens in call order, not a running total', async () => {
    programMock(NODE, [{ content: 'a' }, { content: 'b' }, { content: 'c' }]);
    await call(256);
    await call(256);
    await call(512);
    expect(receivedMaxTokens(NODE)).toEqual([256, 256, 512]);
    expect(lastReceivedMaxTokens(NODE)).toBe(512);
  });

  it('records null for a call that carried no budget', async () => {
    programMock(NODE, [{ content: 'a' }]);
    await call(undefined);
    expect(receivedMaxTokens(NODE)).toEqual([null]);
  });

  it('re-seeding the program clears the history; an unseeded node reports none', async () => {
    programMock(NODE, [{ content: 'a' }]);
    await call(100);
    programMock(NODE, [{ content: 'b' }]);
    expect(receivedMaxTokens(NODE)).toEqual([]);
    expect(receivedMaxTokens('never-seeded')).toEqual([]);
  });
});
