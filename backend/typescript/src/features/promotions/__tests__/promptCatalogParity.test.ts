/**
 * XCH-PROMO-1 drift tripwire (LLM-EXCHANGE-AUDIT 2026-07-13): the Promotions
 * Manager prompt hand-carries the promotion-type vocabulary, and it had
 * drifted — `tiered`/`bogo` never reached the prompt, so the agent could not
 * propose two supported promotion types. Pin the prompt's "Promotion types"
 * list to PROMOTION_TYPES so the next type fails CI here instead of silently
 * underselling the model.
 *
 * grade-tests wave 102: the list is now read from the prompt's own
 * "## Promotion types" section (one backtick-quoted bullet per type) and must
 * EQUAL PROMOTION_TYPES. Before, a `toContain` over the whole prompt passed for
 * a type quoted anywhere, and a phantom type the engine refuses (offered to
 * the model as a bullet) passed too. Sabotage-witnessed: dropping a bullet,
 * adding a phantom bullet, and adding a type to PROMOTION_TYPES each turn it red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { PROMOTION_TYPES } from '../promotionsService.js';

/** The backtick-quoted bullet names under `## Promotion types`, up to the next heading. */
function promptTypeBullets(prompt: string): string[] {
  const start = prompt.indexOf('\n## Promotion types\n');
  expect(start, 'the prompt must keep its "## Promotion types" section').toBeGreaterThanOrEqual(0);
  const body = prompt.slice(start + '\n## Promotion types\n'.length);
  const next = body.search(/^## /m);
  const section = next === -1 ? body : body.slice(0, next);
  return [...section.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]!);
}

describe('promotions-manager prompt ↔ PROMOTION_TYPES parity (XCH-PROMO-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/vendor.openwop-app.promotions.agents/prompts/promotions-manager.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('documents exactly the PROMOTION_TYPES, one backtick-quoted bullet each, under "Promotion types"', () => {
    const bullets = promptTypeBullets(prompt);
    expect(bullets.length, 'the section must list at least one type').toBeGreaterThan(0);
    expect(new Set(bullets).size, 'no type is listed twice').toBe(bullets.length);
    expect([...bullets].sort()).toEqual([...PROMOTION_TYPES].sort());
  });
});
