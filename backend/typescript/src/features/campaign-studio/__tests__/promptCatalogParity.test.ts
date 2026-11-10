/**
 * XCH-CS-1 (LLM-EXCHANGE-AUDIT Wave 3): the Campaign Strategist prompt
 * hand-carries the channel-type and stage vocabularies that
 * validateCampaignDoc enforces. They matched by manual discipline only —
 * pin them so the next enum change fails CI here instead of silently
 * underselling (or over-promising) the model. The vocabulary lines are parsed and must
 * EQUAL the SSoT: a substring check could not lose `pr`, which occurs all over the prompt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CAMPAIGN_CHANNEL_TYPES, CAMPAIGN_STAGES } from '../validateCampaignDoc.js';

describe('campaign-strategist prompt ↔ validateCampaignDoc parity (XCH-CS-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/vendor.openwop-app.campaign-studio.agents/prompts/campaign-strategist.md');
  const prompt = readFileSync(promptPath, 'utf8');

  const vocabulary = (line: RegExp): string[] => (line.exec(prompt)?.[1] ?? '').split('|').map((x) => x.trim()).sort();

  it('names every channel type, and no type the validator refuses', () => {
    expect(vocabulary(/`type` ∈ ([^.]+)\./)).toEqual([...CAMPAIGN_CHANNEL_TYPES].sort());
  });

  it('names every funnel stage, and no stage the validator refuses', () => {
    expect(vocabulary(/stages ∈ ([^.]+)\./)).toEqual([...CAMPAIGN_STAGES].sort());
  });
});
