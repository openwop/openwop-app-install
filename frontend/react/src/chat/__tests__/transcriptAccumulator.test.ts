import { describe, it, expect } from 'vitest';
import { TranscriptAccumulator } from '../voice/realtimeClient.js';

interface Emit { text: string; role: 'user' | 'assistant'; turnId: string; final: boolean }

/** RT-9/RT-9c — Gemini Live emits transcription FRAGMENTS. The accumulator streams
 *  them LIVE (interim `final:false` per fragment, same stable turnId) and settles the
 *  turn on flush (`final:true`), so the consumer upserts ONE bubble per turn. */
describe('TranscriptAccumulator (RT-9c)', () => {
  const collect = () => {
    const out: Emit[] = [];
    const acc = new TranscriptAccumulator((text, role, turnId, final) => out.push({ text, role, turnId, final }));
    return { out, acc };
  };
  const finals = (out: Emit[]) => out.filter((e) => e.final).map((e) => ({ text: e.text, role: e.role }));

  it('streams interim updates per fragment (same turnId), then a final on flush', () => {
    const { out, acc } = collect();
    acc.addUser('book a ');
    acc.addUser('table for two');
    acc.flushUser();
    const user = out.filter((e) => e.role === 'user');
    expect(user.map((e) => [e.text, e.final])).toEqual([
      ['book a', false],
      ['book a table for two', false],
      ['book a table for two', true],
    ]);
    expect(new Set(user.map((e) => e.turnId)).size).toBe(1); // ONE bubble
  });

  it('settles whole turns in user → assistant order with distinct turn ids', () => {
    const { out, acc } = collect();
    acc.addUser('hello'); acc.flushUser();
    acc.addAssistant('hi there'); acc.flushAssistant();
    expect(finals(out)).toEqual([
      { text: 'hello', role: 'user' },
      { text: 'hi there', role: 'assistant' },
    ]);
    expect(out.find((e) => e.role === 'user')?.turnId).toBe('u0');
    expect(out.find((e) => e.role === 'assistant')?.turnId).toBe('a0');
  });

  it('sequential turns get incrementing ids (u0/a0/u1/a1) — no bubble collisions', () => {
    const { out, acc } = collect();
    acc.addUser('one'); acc.flushUser();
    acc.addAssistant('first'); acc.flushAssistant();
    acc.addUser('two'); acc.flushUser();
    acc.addAssistant('second'); acc.flushAssistant();
    expect(out.filter((e) => e.final).map((e) => e.turnId)).toEqual(['u0', 'a0', 'u1', 'a1']);
  });

  it('never emits empty/whitespace turns', () => {
    const { out, acc } = collect();
    acc.flushUser();
    acc.addAssistant('   ');
    acc.flushAssistant();
    acc.flushAll();
    expect(out).toEqual([]);
  });

  it('a barge-in flush settles the assistant partial, then the next turn starts clean', () => {
    const { out, acc } = collect();
    acc.addAssistant('The weather today is');
    acc.flushAssistant();
    acc.addUser('actually, tomorrow');
    acc.flushUser();
    expect(finals(out)).toEqual([
      { text: 'The weather today is', role: 'assistant' },
      { text: 'actually, tomorrow', role: 'user' },
    ]);
  });

  it('flushAll at teardown drains both sides, user first', () => {
    const { out, acc } = collect();
    acc.addUser('and one more thing');
    acc.addAssistant('Certainly,');
    acc.flushAll();
    expect(finals(out).map((o) => o.role)).toEqual(['user', 'assistant']);
  });
});
