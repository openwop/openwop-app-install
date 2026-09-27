/**
 * XCH-CC-1 (LLM-EXCHANGE-AUDIT Wave 3): the five-channel vocabulary
 * (CAMPAIGN_CHANNELS, campaign-brief/types.ts) is hand-copied into the
 * brand-steward and channel-generator prompts — one enum change means N
 * prompt edits, silently missable. Pin every prompt that carries the copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CAMPAIGN_CHANNELS } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const CARRIERS = [
  '../../../../../../packs/feature.brand.agents/prompts/brand-steward.md',
  '../../../../../../packs/feature.campaign-channels.agents/prompts/channel-generator.md',
];

describe('campaign channel enum ↔ carrier prompts parity (XCH-CC-1)', () => {
  for (const rel of CARRIERS) {
    const promptPath = join(here, rel);
    const name = rel.split('/').slice(-3, -2)[0];
    it(`${name} names all ${CAMPAIGN_CHANNELS.length} channels`, () => {
      const prompt = readFileSync(promptPath, 'utf8');
      for (const ch of CAMPAIGN_CHANNELS) {
        expect(prompt, `${name} prompt must document channel '${ch}'`).toContain(ch);
      }
    });
  }
});
