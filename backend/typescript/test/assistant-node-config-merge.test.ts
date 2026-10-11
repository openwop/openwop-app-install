/**
 * ADR 0862 D5 (`WF-COS-11`) — the assistant nodes honour their CONFIG.
 *
 * Every handler read `ctx.inputs` only. RFC 0013 Path A freezes a chain's params into
 * node `config`, and all 18 nodes are builder-palette primitives, so a user who set
 * `description` on an upsert-commitment node got `validation_error` for a value that was
 * right there. Inputs still win, so a wired edge keeps overriding config.
 *
 * Sabotage-witnessed (wave 11): drop `ctx.config` from the pack's `I` merge → case 1 red;
 * swap the spread order so config wins → case 2 red.
 */
import { describe, expect, it } from 'vitest';
import { nodes } from '../../../packs/feature.assistant.nodes/index.mjs';

function stubAssistant(seen: Array<Record<string, unknown>>) {
  return {
    upsertCommitment: async (args: Record<string, unknown>) => { seen.push(args); return { commitment: { description: args.description }, created: true }; },
  };
}

describe('D5 — config is merged under inputs', () => {
  it('a description set in node CONFIG reaches the surface', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await nodes['feature.assistant.nodes.upsert-commitment']!({
      config: { description: 'From config' },
      inputs: {},
      features: { assistant: stubAssistant(seen) },
    });
    expect(out.status).toBe('success');
    expect(seen[0]?.description).toBe('From config');
  });

  it('a wired INPUT still overrides config', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await nodes['feature.assistant.nodes.upsert-commitment']!({
      config: { description: 'From config' },
      inputs: { description: 'From the edge' },
      features: { assistant: stubAssistant(seen) },
    });
    expect(out.status).toBe('success');
    expect(seen[0]?.description).toBe('From the edge');
  });
});
