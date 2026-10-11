/**
 * ADR 0858 P3 — a fixture that needs a LIVE-MODEL supervisor is not advertised
 * while this host's supervisor is the conformance mock.
 *
 * `conformance/fixtures.md` row `conformance-context-budget-live`: "A host whose
 * supervisor has no live model MUST NOT advertise this fixture". This host listed
 * it anyway: its node types all resolve, which was the only thing the advert
 * checked. So `v2-provider-usage-emission`, which uses this fixture to see a
 * provider invocation, found a completed run with no `provider.usage` and
 * reported a providerUsage defect. The real defect was the `fixtures[]` claim.
 *
 * The fact "the supervisor calls a live model" is ONE export
 * (`SUPERVISOR_CALLS_LIVE_MODEL`, next to the supervisor in `bootstrap/nodes.ts`).
 * `test/rfc0111-context-budget-non-advert.test.ts` leg 2 ties it to what the
 * supervisor actually does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', '..', 'conformance-fixtures');
const LIVE = 'conformance-context-budget-live';

interface FixtureDoc { id?: string; nodes?: { typeId?: string }[]; metadata?: { tags?: unknown } }

function fixtures(): FixtureDoc[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as FixtureDoc);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
});

describe('ADR 0858 P3 — live-model fixtures follow the supervisor fact', () => {
  it('the host set is derived from the corpus: every live-model-tagged fixture with a supervisor is in it', async () => {
    const { FIXTURES_REQUIRING_LIVE_MODEL_SUPERVISOR } = await import('../src/host/index.js');
    const derived = fixtures()
      .filter((d) => Array.isArray(d.metadata?.tags) && (d.metadata.tags as unknown[]).includes('live-model'))
      .filter((d) => (d.nodes ?? []).some((n) => n.typeId === 'core.orchestrator.supervisor'))
      .map((d) => d.id);
    expect(derived, 'the corpus must still carry the live fixture, else this leg is vacuous').toContain(LIVE);
    expect([...FIXTURES_REQUIRING_LIVE_MODEL_SUPERVISOR].sort()).toEqual(derived.sort());
  });

  it('while the supervisor is a mock, the root does not list the live fixture', async () => {
    const { SUPERVISOR_CALLS_LIVE_MODEL } = await import('../src/bootstrap/nodes.js');
    const { buildV2Advertisement } = await import('../src/routes/discovery.js');
    const { loadConfigFromEnv } = await import('../src/index.js');
    expect(SUPERVISOR_CALLS_LIVE_MODEL, 'the documented state; flipping it is a decision, see nodes.ts').toBe(false);
    const config = loadConfigFromEnv();
    // ADR 0812 P4: the v1 leg went with the v1 builder; v2 is the only root.
    for (const [major, doc] of [['v2', buildV2Advertisement(config)]] as const) {
      const listed = doc['fixtures'] as string[];
      expect(listed.length, `${major} fixtures[] is non-empty (else this leg is vacuous)`).toBeGreaterThan(10);
      expect(listed, `${major} fixtures[] must not claim ${LIVE} with a mock supervisor`).not.toContain(LIVE);
    }
  }, 60_000); // a cold discovery build; measured 8-15 s for two on a loaded machine

  it('non-vacuity: with the fact true, the live fixture IS listed (it is otherwise advertisable)', async () => {
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    expect(listLoadedConformanceFixtures(true)).toContain(LIVE);
    expect(listLoadedConformanceFixtures(false)).not.toContain(LIVE);
  });
});
