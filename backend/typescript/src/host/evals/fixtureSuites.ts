/**
 * ADR 0889 P5 — the conformance eval suites (RFC 0244 §Conformance, suite 2.46.8+).
 *
 * The suite runs `POST /runs {mode:"eval", evalSuiteRef:
 * "https://conformance.openwop.dev/eval-suites/<id>", agentId:
 * "core.conformance.agents.scripted"}` against suites it seeds from
 * `fixtures/eval-suites/` (vendored here under `conformance-fixtures/eval-suites/`).
 * This module loads them (closed-world validated like any tenant suite), and
 * registers the scripted agent the contract in `fixtures.md` defines. Both are
 * gated on `conformanceNodesEnabled()` — the same posture gate as
 * `core.conformance.mock-agent`, so a production (auth-posture) host neither
 * lists these fixtures nor resolves the agent.
 *
 * ADR 0898 — `OPENWOP_CONFORMANCE_EVAL_FIXTURES=true` lists and runs the
 * fixture SUITES without that posture, and WITHOUT registering the scripted
 * agent: a registry entry with no `ownerTenant` is public, so every surface that
 * reads the registry (`/agents`, chat, dispatch, workflow nodes, channels, voice,
 * the widget) would offer it as a live, model-calling agent. Under the flag the
 * agent exists only inside an eval run of a fixture suite
 * (`scriptedEvalAgentFor`, read by `createEvalRun`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { conformanceNodesEnabled } from '../../bootstrap/conformanceMockAgent.js';
import { validateEvalSuite, type AgentEvalSuite } from './suiteStore.js';

export const CONFORMANCE_SUITE_PREFIX = 'https://conformance.openwop.dev/eval-suites/';
/** `fixtures.md` §eval-suites — replays `task.input.script`, outputs `task.input.output`. */
export const SCRIPTED_AGENT_ID = 'core.conformance.agents.scripted';

/** ADR 0898 — the operator opt-in (env-read per call, like `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES`). */
export function conformanceEvalFixturesOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENWOP_CONFORMANCE_EVAL_FIXTURES ?? '').trim().toLowerCase() === 'true';
}

/** The fixture suites are listed and resolvable: the conformance posture, or the ADR 0898 opt-in. */
export function conformanceEvalFixturesEnabled(): boolean {
  return conformanceNodesEnabled() || conformanceEvalFixturesOptIn();
}

const fixtures = new Map<string, AgentEvalSuite>();

export function registerFixtureSuite(id: string, suite: AgentEvalSuite): void {
  fixtures.set(`${CONFORMANCE_SUITE_PREFIX}${id}`, suite);
}

export function resolveFixtureSuite(ref: string): AgentEvalSuite | null {
  if (!conformanceEvalFixturesEnabled()) return null;
  return fixtures.get(ref) ?? null;
}

/** The eval-suite fixture ids this host can run (for discovery `fixtures[]`). */
export function listFixtureSuiteIds(): string[] {
  if (!conformanceEvalFixturesEnabled()) return [];
  return [...fixtures.keys()].map((k) => k.slice(CONFORMANCE_SUITE_PREFIX.length)).sort();
}

/**
 * Vendored fixtures this host deliberately does NOT list. Listing a fixture in
 * discovery opts the host into its conformance legs, so a fixture whose contract
 * this host does not implement stays unlisted (honest `inapplicable`) rather
 * than listed and failing. Each entry names what is missing (ADR 0983 D6).
 */
export const UNLISTED_FIXTURE_SUITES: ReadonlyMap<string, string> = new Map([
  // RFC 0082 §E: listing it declares an eval-gated promotion policy, and this host
  // has no agents.deployment facet, so it would be a claim with nothing behind it.
  ['conformance-eval-gate-failing', 'declares an eval-gated promotion policy (RFC 0082 §E); this host advertises no agents.deployment'],
]);

/** Load `<fixturesDir>/eval-suites/*.json`. A fixture that fails validation is skipped, never half-loaded. */
export function loadConformanceEvalSuites(fixturesDir: string): number {
  let n = 0;
  let files: string[];
  try { files = readdirSync(join(fixturesDir, 'eval-suites')); } catch { return 0; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    if (UNLISTED_FIXTURE_SUITES.has(file.slice(0, -'.json'.length))) continue;
    try {
      const suite = validateEvalSuite(JSON.parse(readFileSync(join(fixturesDir, 'eval-suites', file), 'utf8')));
      registerFixtureSuite(file.slice(0, -'.json'.length), suite);
      n += 1;
    } catch { /* a malformed fixture is not advertised */ }
  }
  return n;
}

type AgentRegistration = Parameters<ReturnType<typeof getAgentRegistry>['register']>[0];

function scriptedEvalAgentManifest(): AgentRegistration {
  return {
    agentId: SCRIPTED_AGENT_ID,
    persona: 'Conformance scripted agent',
    modelClass: 'general',
    systemPrompt: 'Replays task.input.script as tool calls (conformance only).',
    packName: 'core.conformance',
    packVersion: '1.0.0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0 },
  } as AgentRegistration;
}

/**
 * Register the scripted conformance agent (idempotent; conformance posture ONLY —
 * never under the ADR 0898 opt-in, which must not put it in the public registry).
 */
export function registerScriptedEvalAgent(): void {
  if (!conformanceNodesEnabled()) return;
  const reg = getAgentRegistry();
  if (reg.get(SCRIPTED_AGENT_ID)) return;
  reg.register(scriptedEvalAgentManifest());
}

/**
 * ADR 0898 — the scripted agent for an eval run under the opt-in: only for
 * `agentId === SCRIPTED_AGENT_ID`, only when the suite came from a conformance
 * fixture, only while the opt-in is set. Anything else is `null` and the caller
 * falls through to the registry (where, under the opt-in alone, it is absent ⇒
 * the same 404 dispatch gives). The trial never reads this manifest: the runner
 * replays `task.input.script` (`runScriptedTrial`), no model, no live tool.
 */
export function scriptedEvalAgentFor(agentId: string, source: 'tenant' | 'fixture' | 'pack'): AgentRegistration | null {
  if (agentId !== SCRIPTED_AGENT_ID || source !== 'fixture' || !conformanceEvalFixturesOptIn()) return null;
  return scriptedEvalAgentManifest();
}
