/**
 * ADR 0879 D7 — the chat-append RATCHET.
 *
 * S7/S8 were one defect class: a lane that writes a message into a conversation id it
 * was handed, without asking whether the caller may write THERE. The fix sits at the
 * shared seam (`host/runConversationWrite.ts`, called by the agent-runner append and
 * `ctx.chat.sendMessage`), but a seam only holds if a NEW writer cannot appear beside
 * it unnoticed. This test pins every call site that persists or publishes a chat
 * message, file by file, with the gate that authorizes it. A new call site — or a
 * second call in an existing file — fails here until someone names its gate.
 *
 * Shrinking is allowed only by editing the table (a removed caller must be removed
 * here too, so the table never vouches for code that no longer exists).
 *
 * Tracker TST-BHC-3. Red when (sabotage-witnessed, wave 62): a new chat-message write
 * call appears in src. Case 3 is a SOURCE PIN (a behaviour-preserving respelling of
 * the gate call also reds it); the behaviour it stands for is S7/S8 in
 * adr0879-channels-security, which go red when a run-lane gate leg is removed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CALL = /\b(appendChatMessageLive|appendChatMessage|publishChatMessageAppended)\s*\(/g;

/** file → { calls, gate }. `calls` counts every match of CALL outside `src/storage/`
 *  and outside the function definitions themselves. */
const SANCTIONED: Record<string, { calls: number; gate: string }> = {
  'features/channels/channelService.ts': { calls: 1, gate: 'postChannelMessage: canAccessChannel + requireChannelWrite + postingPolicy (ADR 0879 D1/D8)' },
  'host/agentRunnerNode.ts': { calls: 1, gate: 'authorizeRunConversationWrite with agentId (ADR 0879 D7)' },
  'host/chatSurface.ts': { calls: 2, gate: 'sendMessage: authorizeRunConversationWrite (D7); emitCard writes only the per-tenant activity session' },
  'host/chatMessageBus.ts': { calls: 2, gate: 'the bus itself (appendChatMessageLive); callers carry the gate' },
  'host/projectConversations.ts': { calls: 2, gate: 'host-composed SYSTEM notices into a project\'s own chat + bound channels, tenant-checked session (ADR 0854/0855)' },
  'routes/chatSessions.ts': { calls: 3, gate: 'generic append refuses channels + requireVisibleAsync; branch refuses channels and copies only into the caller\'s new session' },
  'features/chat-export/importService.ts': { calls: 1, gate: 'import writes into a session it just created for the importer' },
  'features/voice/realtime/openaiSideband.ts': { calls: 6, gate: 'session bound at mint via scopedConversationIdOf — refuses channels (ADR 0879 H3) + isVisibleToAsync' },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function measure(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (rel.startsWith('storage/')) continue;
    const text = readFileSync(file, 'utf8')
      // drop the definitions (`function appendChatMessageLive(`), keep calls
      .replace(/\bfunction\s+(appendChatMessageLive|publishChatMessageAppended)\s*\(/g, '')
      // and the Storage interface declaration shape `appendChatMessage(record: …)`
      .replace(/^\s*appendChatMessage\(record:.*$/gm, '');
    const n = (text.match(CALL) ?? []).length;
    if (n > 0) found[rel] = n;
  }
  return found;
}

describe('ADR 0879 D7 — every chat-message writer is named with its gate', () => {
  it('the measured call sites equal the sanctioned table exactly', () => {
    const found = measure();
    const expected = Object.fromEntries(Object.entries(SANCTIONED).map(([f, v]) => [f, v.calls]));
    expect(found).toEqual(expected);
  });

  it('is not vacuous: the scan finds the two run lanes the seam guards', () => {
    const found = measure();
    expect(found['host/agentRunnerNode.ts']).toBeGreaterThan(0);
    expect(found['host/chatSurface.ts']).toBeGreaterThan(0);
  });

  it('both run lanes call the shared gate (the seam, not a per-caller copy)', () => {
    for (const f of ['host/agentRunnerNode.ts', 'host/chatSurface.ts']) {
      expect(readFileSync(join(SRC, f), 'utf8')).toContain('authorizeRunConversationWrite(');
    }
  });
});
