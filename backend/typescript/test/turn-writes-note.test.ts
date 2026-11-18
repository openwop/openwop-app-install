/**
 * #5908 (ADR 0834 D4 correction) — a turn that changed state tells the model so,
 * in the host's words, before it writes its reply.
 *
 * MEASURED on a downstream deployment (2026-11-12): an agent in safe mode filed
 * a todo and sent a notification, then closed with "Nothing approved, nothing
 * changed" directly under the turn's "2 changes" receipt. Both writes are
 * deliberate no-ask writes in safe mode (the census's own-board / own-inbox
 * reasons); the defect was the reply denying them.
 *
 * Pins: after a round with successful `write` calls, the next model call ends
 * with a host note naming every write so far, counted; reads and failed writes
 * add nothing; a turn with no writes never sees the note.
 * The note is APPENDED, never inserted earlier, so each model call's messages extend
 * the previous call's byte for byte and a provider prefix cache stays warm (ADR 0315).
 * Red when (sabotage): the note push is removed; reads are counted as writes;
 * a failed write is counted; the note is inserted ahead of earlier messages.
 */
import { describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, turnWritesNote, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const tool = (name: string): CompiledTool => ({ def: { name, description: name, inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) });
const EFFECT: Record<string, 'read' | 'write'> = { 'kanban.add-todo': 'write', 'notify-me': 'write', 'runs.list': 'read' };
const opts = {
  provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
  messages: [{ role: 'user' as const, content: 'what is waiting on me? do not change anything' }],
  tools: [tool('kanban.add-todo'), tool('notify-me'), tool('runs.list')], agentId: 'a', persona: 'Riley', maxRounds: 6,
  toolEffect: (n: string) => EFFECT[n],
};
type Step = { calls: string[] } | { text: string };
function scripted(script: Step[]) {
  const seen: AiToolCallRequest[] = [];
  let i = 0;
  const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    seen.push(r);
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return 'calls' in step
      ? { content: '', toolCalls: step.calls.map((name, k) => ({ id: `c${i}-${k}`, name, input: { k, i } })) }
      : { content: step.text, toolCalls: [] };
  };
  return { callAIWithTools, seen };
}
const notesIn = (r: AiToolCallRequest): string[] => r.messages
  .filter((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('Host record of this turn'))
  .map((x) => x.content as string);

describe('#5908 — the turn-writes note', () => {
  it('the closing call sees every write the turn made, named and counted', async () => {
    const m = scripted([{ calls: ['runs.list'] }, { calls: ['kanban.add-todo', 'notify-me'] }, { calls: ['notify-me'] }, { text: 'Filed a todo and sent you two notes.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: '{"ok":true}' });
    const res = await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool });
    expect(res.finalText).toBe('Filed a todo and sent you two notes.');
    expect(notesIn(m.seen[1]!), 'a read-only round adds no note').toEqual([]);
    const last = m.seen[m.seen.length - 1]!;
    const lastMsg = last.messages[last.messages.length - 1]!;
    expect(lastMsg.content, 'the note is the last thing before the reply').toBe(turnWritesNote(['kanban.add-todo', 'notify-me', 'notify-me']));
    expect(String(lastMsg.content)).toContain('notify-me (2 calls)');
    expect(String(lastMsg.content)).toContain('Never say that nothing changed');
  });

  it('is append-only: every model call extends the previous one byte for byte (prefix cache stays warm)', async () => {
    const m = scripted([{ calls: ['kanban.add-todo'] }, { calls: ['runs.list'] }, { calls: ['notify-me'] }, { text: 'Done.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: '{"ok":true}' });
    await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool });
    expect(m.seen.length).toBe(4);
    for (let k = 1; k < m.seen.length; k++) {
      const prev = JSON.stringify(m.seen[k - 1]!.messages);
      const next = JSON.stringify(m.seen[k]!.messages);
      expect(next.startsWith(prev.slice(0, -1)), `call ${k} rewrote an earlier message`).toBe(true);
      expect(m.seen[k]!.systemPrompt).toBe(m.seen[0]!.systemPrompt);
    }
  });

  it('a failed write adds nothing, and a turn with no writes never sees the note', async () => {
    const m = scripted([{ calls: ['kanban.add-todo'] }, { calls: ['runs.list'] }, { text: 'Nothing changed.' }]);
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ content: '{"error":"no_todo_column"}', isError: true })
      .mockResolvedValue({ content: '{"runs":[]}' });
    await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool });
    for (const r of m.seen) expect(notesIn(r)).toEqual([]);
  });
});
