import { describe, it, expect } from 'vitest';
import { planInterruptResolution } from '../interruptResolution.js';
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
  it('plans using workflowRun.runId when present', () => {
    const s = session([msg('a', { activeInterrupt: interrupt(), workflowRun: { runId: 'run-1' } as never })]);
    expect(planInterruptResolution(s, 'a')).toEqual({ runId: 'run-1', nodeId: 'approve', interrupt: interrupt() });
  });

  it('falls back to meta.runId', () => {
    const s = session([msg('a', { activeInterrupt: interrupt({ nodeId: 'n2' }), meta: { runId: 'run-2' } as never })]);
    expect(planInterruptResolution(s, 'a')?.runId).toBe('run-2');
    expect(planInterruptResolution(s, 'a')?.nodeId).toBe('n2');
  });

  it('returns null when there is no active interrupt', () => {
    const s = session([msg('a', { workflowRun: { runId: 'run-1' } as never })]);
    expect(planInterruptResolution(s, 'a')).toBeNull();
  });

  it('returns null when there is no runId to resume', () => {
    const s = session([msg('a', { activeInterrupt: interrupt() })]);
    expect(planInterruptResolution(s, 'a')).toBeNull();
  });

  it('returns null for an unknown message id', () => {
    expect(planInterruptResolution(session([]), 'missing')).toBeNull();
  });
});
