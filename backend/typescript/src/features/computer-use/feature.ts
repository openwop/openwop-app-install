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
import { startTask, decide, sessionStatus, resumeSession, pollWaitSeconds } from './computerUseService.js';
import { registerComputerUseRoutes } from './routes.js';
import { registerComputerUseAgentTools } from './agentTools.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';
import { getSession, type CuSession } from './sessionStore.js';
import { verifiedApprovalInterrupt } from './approvalBinding.js';
import { registerComputerUseRevocation } from './revocation.js';
import { registerComputerUseErasure } from './erasure.js';

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

/**
 * ADR 0894 D2 — load a session for the run's person, applying authority to the
 * ROW's org (never a caller argument, which the seam floor would have checked
 * instead). No `workspace:read` there is the same 404 as no session, so the id
 * is not an existence oracle across orgs.
 */
async function sessionForRun(scope: BundleScope, sessionId: string): Promise<CuSession> {
  const notFound = () => new OpenwopError('not_found', 'Session not found.', 404, { sessionId });
  // A run with no person passes the org floor tenant-trusted, which would read
  // any session in the tenant by id (grade-code CU2CD-6). Sessions are a
  // person's; a personless run has none.
  if (!scope.actingUserId && !scope.orgScopeSubject) throw notFound();
  const s = sessionId ? await getSession(scope.tenantId, sessionId) : null;
  if (!s) throw notFound();
  try {
    await assertRunScopeOrg(scope, s.orgId, 'workspace:read');
  } catch (err) {
    if (err instanceof OpenwopError && (err.httpStatus === 403 || err.httpStatus === 404)) throw notFound();
    throw err;
  }
  return s;
}

export function buildComputerUseSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const { tenantId } = scope;
  return {
    startTask: async (args) => {
      // ADR 0894 D1 — a browser acts on third-party sites as somebody; a run with
      // no person (a webhook, a system job) has nobody to act for. The org and
      // `runs:create` there are the seam's floor (`orgPolicy` below), which an
      // EMPTY orgId would skip, so the service refuses that too.
      if (!scope.actingUserId) {
        throw new OpenwopError('forbidden', 'A browser session needs a person behind the run.', 403, { capability: 'computer-use' });
      }
      // ADR 0894 addendum G-B — and a SIGNED-IN person. An anonymous session
      // (`session:` principal, `anon:` sandbox) is nobody accountable for what a
      // browser does on a third-party site, and would approve its own commits.
      if (scope.actingUserId.startsWith('session:') || scope.tenantId.startsWith('anon:')) {
        throw new OpenwopError('forbidden', 'Sign in to run a browser agent — an anonymous session cannot drive one.', 403, { capability: 'computer-use' });
      }
      return {
        session: await startTask(resolveAdapter(), {
          tenantId,
          orgId: str(args.orgId),
          task: str(args.task),
          startUrl: str(args.startUrl),
          allowedOrigins: args.allowedOrigins,
          createdBy: scope.actingUserId,
          ...(scope.runId ? { runId: scope.runId } : {}),
          // ADR 0541 — a campaign passes its grant context here. Normalised
          // CLOSED-WORLD: a caller cannot smuggle extra fields, and an
          // unrecognised tier falls back to 'C', which is never grantable. The
          // safe direction is the one that requires a human. ADR 0894 D7: the
          // grant it names must also be the opener's own, in this org.
          ...(applyContextOf(args.applyContext) ? { applyContext: applyContextOf(args.applyContext)! } : {}),
        }),
      };
    },
    decide: async (args) => {
      const s = await sessionForRun(scope, str(args.sessionId));
      // `runs:create` in the session's org, re-asked on every decision (D4).
      await assertRunScopeOrg(scope, s.orgId, 'runs:create');
      const approve = args.approve === true;
      // D3 — an approve must be the opener's recorded resolution of the approval
      // the decide node raised for exactly this action.
      const approvalInterruptId = approve && s.createdBy === scope.actingUserId && s.status === 'awaiting_approval'
        ? await verifiedApprovalInterrupt({ runId: scope.runId, nodeId: str(args.nodeId), session: s })
        : undefined;
      return {
        session: await decide(resolveAdapter(), {
          tenantId, sessionId: s.sessionId, approve, actor: scope.actingUserId ?? '',
          ...(approvalInterruptId ? { approvalInterruptId } : {}),
        }),
      };
    },
    /** CU2CD-1 — advance a session the provider is still working on. */
    resume: async (args) => {
      const s = await sessionForRun(scope, str(args.sessionId));
      await assertRunScopeOrg(scope, s.orgId, 'runs:create');
      return { session: await resumeSession(resolveAdapter(), { tenantId, sessionId: s.sessionId, actor: scope.actingUserId ?? '' }) };
    },
    status: async (args) => {
      const s = await sessionForRun(scope, str(args.sessionId));
      const view = await sessionStatus(tenantId, s.sessionId);
      // `approverRef` lets the decide node name the one eligible approver, and
      // `decidable` lets it fail fast in someone else's run instead of asking
      // the opener a question that run can never act on (D2).
      return { session: view ? { ...view, startUrl: s.startUrl, approverRef: s.createdBy, decidable: s.createdBy === scope.actingUserId, waitSeconds: pollWaitSeconds() } : null };
    },
  };
}

export const computerUseFeature: BackendFeature = {
  id: 'computer-use',
  registerRoutes: (deps) => {
    registerComputerUseRoutes(deps);
    registerComputerUseRevocation(deps.storage); // ADR 0894 D4 + CU2UX-2/CU2CD-5 — membership loss, run end and the ceiling sweep end sessions
    registerComputerUseErasure(); // ADR 0894 D9
    // CFP-1 — the Browser Operator agent's real STATUS read tool. Starting a task
    // and deciding a commit-tier action stay on the governed run (the decide
    // node raises the approval; not chat tools), so only the read is registered here.
    registerComputerUseAgentTools();
  },
  requiredPacks: [
    { name: 'feature.computer-use.nodes', version: '1.1.2' }, // ADR 0894 D3 — decide raises its own approval
    { name: 'vendor.openwop-app.computer-use.agents', version: '1.0.3' }, // CFP-1 status read tool; task/decide pruned to the governed run path
  ],
  // ADR 0894 D1 — starting a browser session is a run's worth of authority:
  // the seam asks `runs:create` in the named org instead of `workspace:read`.
  surface: { id: 'computer-use', build: buildComputerUseSurface, orgPolicy: { methodScopes: { startTask: 'runs:create' } } },
  toggleDefault: {
    id: 'computer-use',
    label: 'Computer-use browser agents',
    description:
      'Agent-driven browser sessions via provider computer-use APIs — risk-tiered human approval on every commit-class action, fail-closed origin allowlist, recorded replay-safe trajectories, per-tenant daily session budget.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'computer-use',
  },
};
