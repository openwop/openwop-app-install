import { describe, it, expect } from 'vitest';
import { planInterruptResolution, mergeOpenInterrupts, removeInterruptByNode } from '../interruptResolution.js';
import type { ChatSession, ChatMessage } from '../../types.js';
import type { OpenInterrupt } from '../../../client/interruptsClient.js';

const interrupt = (over: Partial<OpenInterrupt> = {}): OpenInterrupt =>
  ({ interruptId: 'i1', nodeId: 'approve', kind: 'approval', ...over } as OpenInterrupt);

function session(messages: ChatMessage[]): ChatSession {
  return { id: 's', title: 'T', messages, createdAt: '2026-01-01T00:00:00Z' };
}
function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: '', createdAt: '2026-01-01T00:00:00Z', ...over };
}

describe('planInterruptResolution', () => {
  it('plans using workflowRun.runId when present (single open interrupt)', () => {
    const s = session([msg('a', { activeInterrupts: [interrupt()], workflowRun: { runId: 'run-1' } as never })]);
    expect(planInterruptResolution(s, 'a')).toEqual({ runId: 'run-1', nodeId: 'approve', interrupt: interrupt() });
  });

  it('falls back to meta.runId', () => {
    const s = session([msg('a', { activeInterrupts: [interrupt({ nodeId: 'n2' })], meta: { runId: 'run-2' } as never })]);
    expect(planInterruptResolution(s, 'a')?.runId).toBe('run-2');
    expect(planInterruptResolution(s, 'a')?.nodeId).toBe('n2');
  });

  it('returns null when there is no active interrupt', () => {
    const s = session([msg('a', { workflowRun: { runId: 'run-1' } as never })]);
    expect(planInterruptResolution(s, 'a')).toBeNull();
  });

  it('returns null when there is no runId to resume', () => {
    const s = session([msg('a', { activeInterrupts: [interrupt()] })]);
    expect(planInterruptResolution(s, 'a')).toBeNull();
  });

  it('returns null for an unknown message id', () => {
    expect(planInterruptResolution(session([]), 'missing')).toBeNull();
  });

  describe('parallel-gate fan-out', () => {
    const a = interrupt({ interruptId: 'i-a', nodeId: 'legal' });
    const b = interrupt({ interruptId: 'i-b', nodeId: 'brand' });
    const c = interrupt({ interruptId: 'i-c', nodeId: 'risk' });

    it('targets a specific open interrupt by nodeId', () => {
      const s = session([msg('a', { activeInterrupts: [a, b, c], workflowRun: { runId: 'run-1' } as never })]);
      expect(planInterruptResolution(s, 'a', 'brand')?.nodeId).toBe('brand');
      expect(planInterruptResolution(s, 'a', 'risk')?.interrupt.interruptId).toBe('i-c');
    });

    it('returns null when several are open and no nodeId disambiguates', () => {
      const s = session([msg('a', { activeInterrupts: [a, b, c], workflowRun: { runId: 'run-1' } as never })]);
      expect(planInterruptResolution(s, 'a')).toBeNull();
    });

    it('returns null for a nodeId that is not open', () => {
      const s = session([msg('a', { activeInterrupts: [a, b], workflowRun: { runId: 'run-1' } as never })]);
      expect(planInterruptResolution(s, 'a', 'risk')).toBeNull();
    });
  });
});

describe('mergeOpenInterrupts', () => {
  const a = interrupt({ interruptId: 'i-a', nodeId: 'legal' });
  const b = interrupt({ interruptId: 'i-b', nodeId: 'brand' });

  it('unions by interruptId, preserving first-seen order', () => {
    expect(mergeOpenInterrupts([a], [a, b]).map((i) => i.interruptId)).toEqual(['i-a', 'i-b']);
  });

  it('treats undefined existing as empty', () => {
    expect(mergeOpenInterrupts(undefined, [a, b])).toEqual([a, b]);
  });

  it('does not duplicate an interrupt already present', () => {
    expect(mergeOpenInterrupts([a, b], [b])).toHaveLength(2);
  });
});

describe('removeInterruptByNode', () => {
  const a = interrupt({ interruptId: 'i-a', nodeId: 'legal' });
  const b = interrupt({ interruptId: 'i-b', nodeId: 'brand' });

  it('drops only the matching node, leaving siblings open', () => {
    expect(removeInterruptByNode([a, b], 'legal')).toEqual([b]);
  });

  it('is a no-op for an unknown node', () => {
    expect(removeInterruptByNode([a, b], 'risk')).toEqual([a, b]);
  });

  it('treats undefined as empty', () => {
    expect(removeInterruptByNode(undefined, 'legal')).toEqual([]);
  });
});
