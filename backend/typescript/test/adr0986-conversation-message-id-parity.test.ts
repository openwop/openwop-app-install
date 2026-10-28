/**
 * ADR 0986 D1 (architect B1) — the backend `conversationMessageId` twin must stay
 * identical to the SPA's. The SPA rates a turn under this id; the host keys its
 * per-turn attribution on it. If the two drift, every rating silently stops
 * matching its attribution row and the leaderboard empties again (EV2-1).
 *
 * Two layers: the function BODIES are compared as source (comments and whitespace
 * stripped), and fixed fixtures — including a >64-character id on the hash branch —
 * pin the output. Sabotage: changing the twin's sanitiser or hash constant reds both.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversationMessageId } from '../src/host/conversationMessageId.js';

const body = (file: string): string => {
  const src = readFileSync(file, 'utf8');
  const m = /export function conversationMessageId\(wireId: string\): string \{([\s\S]*?)\n\}/.exec(src);
  if (!m) throw new Error(`conversationMessageId not found in ${file}`);
  return m[1]!.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
};

describe('conversationMessageId — backend twin = SPA', () => {
  it('has the same body as the SPA function', () => {
    const fe = join(__dirname, '..', '..', '..', 'frontend', 'react', 'src', 'chat', 'hooks', 'chatSession', 'lib.ts');
    const be = join(__dirname, '..', 'src', 'host', 'conversationMessageId.ts');
    expect(body(be)).toBe(body(fe));
  });

  it('sanitises a normal wire id and hashes a long one, keeping the discriminating tail', () => {
    expect(conversationMessageId('2b7c4f1e-aaaa-bbbb-cccc-0123456789ab:gate:0:2:agent')).toBe('2b7c4f1e-aaaa-bbbb-cccc-0123456789ab_gate_0_2_agent');
    const long = `${'x'.repeat(70)}:gate:0:12:agent`;
    const id = conversationMessageId(long);
    expect(id).toMatch(/^cm_[0-9a-z]+_/);
    expect(id.endsWith('_gate_0_12_agent')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});
