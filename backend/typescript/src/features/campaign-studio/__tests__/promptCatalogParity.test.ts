/**
 * XCH-CS-1 (LLM-EXCHANGE-AUDIT Wave 3): the Campaign Strategist prompt
 * hand-carries the channel-type and stage vocabularies that
 * validateCampaignDoc enforces. They matched by manual discipline only —
 * pin them so the next enum change fails CI here instead of silently
 * underselling (or over-promising) the model.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CAMPAIGN_CHANNEL_TYPES, CAMPAIGN_STAGES } from '../validateCampaignDoc.js';

describe('campaign-strategist prompt ↔ validateCampaignDoc parity (XCH-CS-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/feature.campaign-studio.agents/prompts/campaign-strategist.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('names every channel type', () => {
    for (const t of CAMPAIGN_CHANNEL_TYPES) {
      expect(prompt, `prompt must document channel type '${t}'`).toContain(t);
    }
  });

  it('names every funnel stage', () => {
    for (const s of CAMPAIGN_STAGES) {
      expect(prompt, `prompt must document stage '${s}'`).toContain(s);
    }
  });
});
