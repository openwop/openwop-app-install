/**
 * `conformance.callai.echo-attempts` — the node behind the
 * `conformance-callai-attempt-accounting` fixture (RFC 0248, ADR 0966), with its
 * own operator switch (ADR 0967).
 *
 * The node makes exactly one `ctx.callAI` call through the conformance `mock`
 * provider, serving the caller's `script` to that call's provider requests, and
 * outputs the result's `attempts` verbatim. It never returns model text, never
 * reaches a real provider, credential or spend, and is not an agent.
 *
 * Until ADR 0967 it was registered inside `registerConformanceNodes()`, which
 * production leaves off, so the production cut (165c) found the fixture
 * withheld and every `0248.*` row inapplicable while `callAccounting` was
 * advertised. It now registers under `conformanceNodesEnabled()` OR the
 * operator opt-in `OPENWOP_CONFORMANCE_CALLAI_FIXTURE=true`. The opt-in is
 * ignored, with a boot warning, in the enterprise (`auth`) posture: LEAK-4
 * already refuses `provider:'mock'` there, and LEAK-8 fails the conformance
 * posture closed there for the same reason.
 *
 * Read once, at registration — like the conformance-nodes switch, a change
 * needs a new boot. The fixture's advertisement follows on its own:
 * `listLoadedConformanceFixtures` lists a fixture only when its node resolves.
 */
import type { NodeModule } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';
import { enterprisePosture } from '../host/deployPosture.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('bootstrap.conformanceCallAiFixture');

export const CALLAI_ECHO_ATTEMPTS_TYPE_ID = 'conformance.callai.echo-attempts';

/** ADR 0967 — the operator opt-in (exactly `true`, case-insensitive). */
export function callAiFixtureOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENWOP_CONFORMANCE_CALLAI_FIXTURE ?? '').trim().toLowerCase() === 'true';
}

/** Whether the node registers: the conformance posture, or the opt-in outside `auth`. */
export function callAiFixtureEnabled(): boolean {
  if (conformanceNodesEnabled()) return true;
  return callAiFixtureOptIn() && !enterprisePosture();
}

type Req = { prompt?: unknown; responseSchema?: unknown; maxTokens?: unknown; retry?: unknown; script?: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const callAiEchoAttemptsNode: NodeModule = {
  typeId: CALLAI_ECHO_ATTEMPTS_TYPE_ID,
  version: '1.0.0',
  async execute(ctx) {
    // The fixture passes `request` and `script` as RUN INPUTS (`POST /runs
    // {inputs: {request, script}}`, its declared variables), so they are read
    // from the variable bag first, then `ctx.inputs`; a host-registered workflow
    // may instead put the request's fields and `script` in `config`.
    const inputs = isObj(ctx.inputs) ? ctx.inputs : {};
    const fromRun = (name: string): unknown => ctx.variables?.get(name) ?? inputs[name];
    const runRequest = fromRun('request');
    const cfg = (isObj(runRequest) ? runRequest : (ctx.config ?? {})) as Req;
    const runScript = fromRun('script');
    const { programMockForRun, minimalInstance } = await import('../providers/dispatchMock.js');
    const script = (Array.isArray(runScript) ? runScript : Array.isArray((ctx.config as Req | undefined)?.script) ? (ctx.config as Req).script : []) as Array<Record<string, unknown>>;
    const structured = cfg.responseSchema !== undefined;
    // The fixture contract: past the end of the script the LAST entry repeats.
    // 32 covers the 16-attempt ceiling plus a natural-language fallback.
    const served = script.length === 0 ? [] : Array.from({ length: Math.max(script.length, 32) }, (_, i) => script[Math.min(i, script.length - 1)]!);
    // ADR 0967 — scoped to THIS run: the fixture's node id is the same in every
    // run of it, in every tenant.
    programMockForRun(ctx.runId, ctx.nodeId, served.map((e) => ({
      ...(e.kind === 'invalid-json' ? { content: '{ this is not json }', stopReason: 'end_turn' as const } : {}),
      ...(e.kind === 'truncated' ? { content: '{"partial":', stopReason: 'max_tokens' as const } : {}),
      // The reply is built from the schema itself: a truncation retry drops the
      // prompt's schema hint, which the mock's default reply is derived from.
      ...(e.kind === 'valid' ? { stopReason: 'end_turn' as const, content: structured ? JSON.stringify(minimalInstance(cfg.responseSchema)) : 'ok' } : {}),
      ...(typeof e.outputTokens === 'number' ? { outputTokens: e.outputTokens } : {}),
      ...(e.usage === false ? { noUsage: true } : {}),
      ...(e.structuredMode === 'native' || e.structuredMode === 'prompt' ? { structuredMode: e.structuredMode } : {}),
      clampOutputToMaxTokens: true,
    })));
    if (!ctx.callAI) return { status: 'failure', error: { code: 'host_capability_missing', message: 'ctx.callAI is not available' } };
    const result = await ctx.callAI({
      provider: 'mock',
      model: 'mock-mini',
      messages: [{ role: 'user', content: typeof cfg.prompt === 'string' ? cfg.prompt : 'echo' }],
      ...(structured ? { responseSchema: cfg.responseSchema as Record<string, unknown> } : {}),
      ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens as number } : {}),
      ...(cfg.retry !== undefined ? { retry: cfg.retry as NonNullable<Parameters<NonNullable<typeof ctx.callAI>>[0]['retry']> } : {}),
    });
    return { status: 'success', outputs: { attempts: result.attempts } };
  },
};

let registered = false;

export function registerCallAiFixtureNode(): void {
  if (registered) return;
  if (!callAiFixtureEnabled()) {
    if (callAiFixtureOptIn() && enterprisePosture()) {
      log.warn('callai_fixture_opt_in_ignored', { reason: 'OPENWOP_CONFORMANCE_CALLAI_FIXTURE is ignored in the auth posture (LEAK-3/LEAK-4)' });
    }
    return;
  }
  getNodeRegistry().register(callAiEchoAttemptsNode);
  registered = true;
}

/** Test-only: forget the registration so a test can re-boot under other env. */
export function resetCallAiFixtureRegistrationForTests(): void {
  registered = false;
}
