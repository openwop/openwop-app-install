/**
 * ADR 0418 — computer-use browser agents (provider-API lane). P1 ships the
 * adapter seam + mock provider + the tiered/allowlisted/budgeted control loop
 * + the ctx surface the node pack wraps. P2 adds the Anthropic provider +
 * approval cards; P3 the agent pack + trajectory surface; P4 hardening.
 *
 * The surface resolves the adapter per call: `mock` (default until a real
 * provider is wired in P2) keeps every deployment honest-off — the toggle
 * gates reach, and a real provider needs explicit operator configuration.
 */
import { OpenwopError } from '../../types.js';
import type { BackendFeature } from '../types.js';
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { makeMockAdapter, type ComputerUseAdapter } from './adapter.js';
import { startTask, decide, sessionStatus } from './computerUseService.js';
import { registerComputerUseRoutes } from './routes.js';
import { registerComputerUseAgentTools } from './agentTools.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ONE mock adapter instance per process (sessions live in its map for the
// duration of a run; durable truth is the session store).
let mockAdapter: (ComputerUseAdapter & { calls: { start: number; poll: number; decide: number } }) | null = null;

/** P2 provider seam — HONEST-OFF by construction. The mock is reachable only
 *  by explicit operator/dev opt-in (`OPENWOP_COMPUTER_USE_PROVIDER=mock`); no
 *  provider configured ⇒ a typed `capability_not_provided`, never a guessed
 *  live integration (ADR 0418 §P2 correction: Anthropic computer-use is
 *  client-executed — there is no hosted-browser API to call today; a real
 *  hosted-session provider lands here behind BYOK + brokered egress once an
 *  operator supplies verified credentials/docs — the ADR 0404 P3c mock-seam
 *  rule, never a hand-invented API shape). */
export function resolveAdapter(): ComputerUseAdapter {
  const provider = process.env.OPENWOP_COMPUTER_USE_PROVIDER ?? '';
  if (provider === 'mock' || process.env.NODE_ENV === 'test' || process.env.VITEST) {
    if (!mockAdapter) mockAdapter = makeMockAdapter();
    return mockAdapter;
  }
  throw new OpenwopError(
    'capability_not_provided',
    'No computer-use provider is configured (OPENWOP_COMPUTER_USE_PROVIDER). A hosted-session provider requires operator configuration.',
    501,
    { capability: 'computer-use' },
  );
}
/** Test-only. */
export function __resetMockAdapter(): void { mockAdapter = null; }

/** Closed-world normalisation of a caller-supplied apply context (ADR 0541). */
function applyContextOf(v: unknown): { subjectId: string; campaignId: string; tier: 'A' | 'B' | 'C' } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const subjectId = typeof o.subjectId === 'string' ? o.subjectId : '';
  const campaignId = typeof o.campaignId === 'string' ? o.campaignId : '';
  if (!subjectId || !campaignId) return null;
  const tier = o.tier === 'A' || o.tier === 'B' ? o.tier : 'C';
  return { subjectId, campaignId, tier };
}

export function buildComputerUseSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const { tenantId } = scope;
  return {
    startTask: async (args) => ({
      session: await startTask(resolveAdapter(), {
        tenantId,
        orgId: str(args.orgId),
        task: str(args.task),
        startUrl: str(args.startUrl),
        allowedOrigins: args.allowedOrigins,
        createdBy: scope.actingUserId ?? `run:${scope.runId ?? 'unknown'}`,
        // ADR 0541 — a campaign passes its grant context here. Normalised
        // CLOSED-WORLD: a caller cannot smuggle extra fields, and an
        // unrecognised tier falls back to 'C', which is never grantable. The
        // safe direction is the one that requires a human.
        ...(applyContextOf(args.applyContext) ? { applyContext: applyContextOf(args.applyContext)! } : {}),
      }),
    }),
    decide: async (args) => ({
      session: await decide(resolveAdapter(), tenantId, str(args.sessionId), args.approve === true),
    }),
    status: async (args) => {
      const session = await sessionStatus(tenantId, str(args.sessionId));
      return { session };
    },
  };
}

export const computerUseFeature: BackendFeature = {
  id: 'computer-use',
  registerRoutes: (deps) => {
    registerComputerUseRoutes(deps);
    // CFP-1 — the Browser Operator agent's real STATUS read tool. Starting a task
    // and deciding a commit-tier action stay on the governed executor +
    // approvalGate run path (not chat tools), so only the read is registered here.
    registerComputerUseAgentTools();
  },
  requiredPacks: [
    { name: 'feature.computer-use.nodes', version: '1.0.1' },
    { name: 'feature.computer-use.agents', version: '1.0.1' }, // CFP-1 status read tool; task/decide pruned to the governed run path
  ],
  surface: { id: 'computer-use', build: buildComputerUseSurface },
  toggleDefault: {
    id: 'computer-use',
    label: 'Computer-use browser agents',
    description:
      'Agent-driven browser sessions via provider computer-use APIs — risk-tiered human approval on every commit-class action, fail-closed origin allowlist, recorded replay-safe trajectories, per-tenant daily session budget (ADR 0418).',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'computer-use',
  },
};
