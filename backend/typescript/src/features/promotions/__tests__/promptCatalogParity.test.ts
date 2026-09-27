/**
 * XCH-PROMO-1 drift tripwire (LLM-EXCHANGE-AUDIT 2026-07-13): the Promotions
 * Manager prompt hand-carries the promotion-type vocabulary, and it had
 * drifted — `tiered`/`bogo` never reached the prompt, so the agent could not
 * propose two supported promotion types. Pin the prompt's "Promotion types"
 * list to PROMOTION_TYPES so the next type fails CI here instead of silently
 * underselling the model.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { PROMOTION_TYPES } from '../promotionsService.js';

describe('promotions-manager prompt ↔ PROMOTION_TYPES parity (XCH-PROMO-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/feature.promotions.agents/prompts/promotions-manager.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('names every promotion type as a backtick-quoted bullet', () => {
    for (const type of PROMOTION_TYPES) {
      expect(prompt, `prompt must document promotion type '${type}'`).toContain(`\`${type}\``);
    }
  });
});
