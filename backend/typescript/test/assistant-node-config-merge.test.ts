/**
 * ADR 0862 D5 (`WF-COS-11`) — the assistant nodes honour their CONFIG.
 *
 * Every handler read `ctx.inputs` only. RFC 0013 Path A freezes a chain's params into
 * node `config`, and all 18 nodes are builder-palette primitives, so a user who set
 * `description` on an upsert-commitment node got `validation_error` for a value that was
 * right there. Inputs still win, so a wired edge keeps overriding config.
 */
import { describe, expect, it } from 'vitest';

type Ctx = { config?: Record<string, unknown>; inputs?: Record<string, unknown>; features: { assistant: Record<string, unknown> } };

async function nodesModule() {
  return (await import('../../../packs/feature.assistant.nodes/index.mjs')) as unknown as {
    nodes: Record<string, (ctx: Ctx) => Promise<{ status: string; outputs: Record<string, unknown> }>>;
  };
}

function stubAssistant(seen: Array<Record<string, unknown>>) {
  return {
    upsertCommitment: async (args: Record<string, unknown>) => { seen.push(args); return { commitment: { description: args.description }, created: true }; },
  };
}

describe('D5 — config is merged under inputs', () => {
  it('a description set in node CONFIG reaches the surface', async () => {
    const { nodes } = await nodesModule();
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
    const { nodes } = await nodesModule();
    const seen: Array<Record<string, unknown>> = [];
    await nodes['feature.assistant.nodes.upsert-commitment']!({
      config: { description: 'From config' },
      inputs: { description: 'From the edge' },
      features: { assistant: stubAssistant(seen) },
    });
    expect(seen[0]?.description).toBe('From the edge');
  });
});
