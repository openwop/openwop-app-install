/**
 * XCH-CC-1 (LLM-EXCHANGE-AUDIT Wave 3): the five-channel vocabulary
 * (CAMPAIGN_CHANNELS, campaign-brief/types.ts) is hand-copied into the
 * brand-steward and channel-generator prompts — one enum change means N
 * prompt edits, silently missable. Pin every prompt that carries the copy,
 * in BOTH directions: a channel ADDED to the enum must be documented, and a
 * channel REMOVED from the enum must leave the prompt's channel list (a stale
 * entry tells the model about a channel the brief rejects).
 * Sabotage-witnessed (wave 30): adding a channel to the enum reds both cases;
 * renaming one in a prompt reds that prompt's case; removing one from the enum
 * reds both through the set-equality leg.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CAMPAIGN_CHANNELS } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const CARRIERS = [
  '../../../../../../packs/vendor.openwop-app.brand.agents/prompts/brand-steward.md',
  '../../../../../../packs/vendor.openwop-app.campaign-channels.agents/prompts/channel-generator.md',
];

/** The parenthesised, backticked channel list each carrier prompt holds:
 *  "(`landing_page`, `ad_variants`, …)" — possibly wrapped across lines. */
const CHANNEL_LIST = /\((`[a-z_]+`(?:,\s*`[a-z_]+`)+)\)/g;

describe('campaign channel enum ↔ carrier prompts parity (XCH-CC-1)', () => {
  for (const rel of CARRIERS) {
    const promptPath = join(here, rel);
    const name = rel.split('/').slice(-3, -2)[0];
    it(`${name} names all ${CAMPAIGN_CHANNELS.length} channels`, () => {
      const prompt = readFileSync(promptPath, 'utf8');
      for (const ch of CAMPAIGN_CHANNELS) {
        expect(prompt, `${name} prompt must document channel '${ch}'`).toContain(ch);
      }
      // The reverse direction: the prompt's channel list is EXACTLY the enum.
      const lists = [...prompt.matchAll(CHANNEL_LIST)].map((m) => m[1]!.match(/`([a-z_]+)`/g)!.map((t) => t.slice(1, -1)));
      expect(lists, `${name} prompt must carry exactly one backticked channel list`).toHaveLength(1);
      expect(new Set(lists[0])).toEqual(new Set(CAMPAIGN_CHANNELS));
    });
  }
});
