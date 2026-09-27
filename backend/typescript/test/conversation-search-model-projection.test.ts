/**
 * ADR 0685 D1 (`CSWF-2`, upgraded from the instance to its generator) — the conversation-search
 * agent tool projects an EXPLICIT allowlist, so the engine's internal shape is no longer the
 * model-facing contract by default.
 *
 * Born red: `agentTools.ts` returned `JSON.stringify({ hits })` — the engine's `SearchHit`
 * verbatim. `matchedAt` was declared, populated, typed on the FE client and read by NOTHING
 * (zero consumers repo-wide), so it shipped to every model calling the tool as an undocumented
 * timestamp. Removing that one field would have left the NEXT internal field to reach a model
 * silently, which is why the fix is the allowlist rather than the deletion.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'features', 'conversation-search');

/** The keys a model may see. Adding one here is the deliberate edit the ADR asks for. */
const MODEL_FACING_KEYS = ['conversationId', 'title', 'type', 'messageId', 'snippet', 'score', 'role'];

describe('ADR 0685 D1 — the tool projects an allowlist, not the engine shape', () => {
  it('leg 1: the projection emits exactly the allowlisted keys', () => {
    const src = readFileSync(join(SRC, 'agentTools.ts'), 'utf8');
    const block = src.slice(src.indexOf('hits: hits.map('), src.indexOf('}),\n        }),'));
    expect(block, 'the tool must map hits explicitly, not serialize them verbatim').toBeTruthy();
    for (const k of MODEL_FACING_KEYS) {
      expect(block, `${k} must be projected`).toContain(`${k}:`);
    }
  });

  it('leg 2: `matchedAt` reaches NO model — the filed instance', () => {
    // Comments are STRIPPED first: this file's own rationale names the field, and asserting
    // against raw source tested the comment rather than the code (it went red on the first
    // run for exactly that reason — the "ratchets count comments" trap).
    const src = readFileSync(join(SRC, 'agentTools.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
    expect(code, 'matchedAt must not appear in the model-facing projection').not.toContain('matchedAt');
  });

  it('leg 3: the tool no longer serializes the engine hit verbatim — the GENERATOR', () => {
    // This is the leg that matters. `JSON.stringify({ hits })` is what made every future
    // `SearchHit` field a model-facing field with no decision; its absence is the fix.
    const src = readFileSync(join(SRC, 'agentTools.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/JSON\.stringify\(\s*\{\s*hits\s*\}\s*\)/);
  });

  it('leg 4: the engine still declares matchedAt — the FE client types it; only the MODEL lane drops it', () => {
    // Non-vacuity guard in the other direction: this must not silently become a wholesale
    // removal. The ADR chose "drop it from the tool projection", not "delete the field".
    const engine = readFileSync(join(SRC, 'searchEngine.ts'), 'utf8');
    expect(engine, 'the engine keeps the field for the FE consumer that types it').toContain('matchedAt');
  });
});
