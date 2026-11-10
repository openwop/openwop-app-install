/**
 * ADR 0986 D1 (architect B1) — the backend `conversationMessageId` twin must stay
 * identical to the SPA's. The SPA rates a turn under this id; the host keys its
 * per-turn attribution on it. If the two drift, every rating silently stops
 * matching its attribution row and the leaderboard empties again (EV2-1).
 *
 * Two layers: the function BODIES are compared as source (comments and whitespace
 * stripped), so one twin cannot drift alone; and literal outputs pin the function, so
 * both twins cannot drift together. The hash literals were computed by a standalone
 * FNV-1a, never by this function. Sabotage (wave 77, each red in both cases): the
 * twin's sanitiser, its hash constant, or its 64-character threshold.
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
    expect(id).toBe('cm_2hlw6m_xxxxxxxxxxxxxxxxxxxxxxxx_gate_0_12_agent');
    expect(id.length).toBeLessThanOrEqual(64);
    // The boundary: 64 sanitised characters stay readable, 65 are hashed.
    expect(conversationMessageId(`${'a'.repeat(59)}:gate`)).toBe(`${'a'.repeat(59)}_gate`);
    expect(conversationMessageId(`${'a'.repeat(60)}:gate`)).toBe('cm_jzual2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_gate');
  });
});
