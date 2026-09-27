/**
 * UX_UPGRADE-assistant ROUND 2 — AST2-M1.
 *
 * The `compose-briefing` tool advertised "balanced (default) | deadline |
 * relationship". Neither `deadline` nor `relationship` has ever existed — the
 * keys are `conservative | balanced | aggressive`. A model doing exactly what
 * the schema told it produced a TypeError in `briefing.ts`, because that
 * dereference was unguarded while its sibling in `surface.ts` was not.
 *
 * This is the prompt↔SSoT drift class that `promptCatalogParity` and
 * `agent-prompt-tool-ids` exist to catch, in a place neither of them looks: an
 * inputSchema `description`. So the pin is DERIVATION — the tool now builds its
 * enum from `PRIORITY_PROFILES` — and this test asserts the derivation held,
 * which no restatement of the literal list could.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, upsertCommitmentBySource } from '../src/features/assistant/assistantService.js';
import { composeBriefing } from '../src/features/assistant/briefing.js';
import { PRIORITY_PROFILES } from '../src/features/assistant/prioritization.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';

const TENANT = 'org:assistant-profile';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18995, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
});

describe('AST2-M1 — the profile the model is offered is the profile that exists', () => {
  it('the tool enum IS the SSoT key set, not a restatement of it', () => {
    const tool = builtinAgentTool('openwop:assistant.compose-briefing');
    expect(tool, 'the compose-briefing tool should be registered').toBeTruthy();
    const props = (tool!.def.inputSchema as { properties?: Record<string, { enum?: string[]; description?: string }> }).properties;
    const offered = props?.profile?.enum ?? [];
    expect([...offered].sort()).toEqual(Object.keys(PRIORITY_PROFILES).sort());

    // …and the prose cannot contradict the enum, because it is built from it.
    // The literal strings that used to be advertised are gone.
    const text = props?.profile?.description ?? '';
    expect(text).not.toMatch(/\bdeadline\b/);
    expect(text).not.toMatch(/\brelationship\b/);
    for (const key of Object.keys(PRIORITY_PROFILES)) expect(text).toContain(key);
  });

  it('an unknown profile degrades to balanced instead of throwing', async () => {
    // The crash needed at least one open commitment — the scorer only runs when
    // there is something to score, which is why an empty workspace hid it.
    for (const [i, desc] of ['Send Dana the Q3 numbers', 'Draft the renewal note', 'Book the venue'].entries()) {
      await upsertCommitmentBySource(TENANT, {
        description: desc,
        owner: { kind: 'email', address: 'me@acme.test' },
        source: { kind: 'gmail', externalId: `m-${i}`, contentHash: `h${i}`, capturedAt: new Date(1754000000000 + i * 1000).toISOString() },
        dueAt: new Date(1754000000000 + i * 86_400_000).toISOString(),
        confidence: 0.5 + i * 0.15,
      });
    }

    const brief = await composeBriefing(TENANT, { profile: 'deadline' as never });
    expect(brief.topCommitments.length).toBeGreaterThan(0);

    // Degrading means degrading to the DEFAULT, not to some other ordering:
    // the same input under `balanced` must give the same scores.
    const baseline = await composeBriefing(TENANT, { profile: 'balanced' });
    expect(brief.topCommitments.map((c: { score: number }) => c.score)).toEqual(baseline.topCommitments.map((c: { score: number }) => c.score));
  });

  it('a REAL profile still changes the scoring (the negative control)', async () => {
    // Without this, "unknown degrades to balanced" is satisfied by a briefing
    // that ignores the profile entirely.
    const conservative = await composeBriefing(TENANT, { profile: 'conservative' });
    const aggressive = await composeBriefing(TENANT, { profile: 'aggressive' });
    expect(conservative.topCommitments.map((c: { score: number }) => c.score))
      .not.toEqual(aggressive.topCommitments.map((c: { score: number }) => c.score));
  });
});
