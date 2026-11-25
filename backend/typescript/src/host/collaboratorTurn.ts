/**
 * ADR 1099 D5 (P2) — the collaborator turn: an outside person (a firm's client, a
 * builder) talks to an agent about the ONE resource a grant gives them.
 *
 * The run is the firm's: it lives in the grant's tenant, is owned by
 * `collab:<collaboratorId>` (no `principalKind`, so it is neither the anonymous
 * actor nor a member), spends the firm's credential by the outsider rule (ADR 1018
 * D8, `outsiderTurnCredential.ts`), and runs with `actingUserId` undefined.
 *
 * What the model may do is exactly the client tools registered for the grant's
 * kind whose action the grant holds (`clientProjectTools.ts`). The tool source is
 * built from that registry alone, so no member tool and no ADR 0315 baseline tool
 * can resolve. Before EVERY call `checkGrantUse` runs again, so a grant revoked
 * mid-conversation refuses the next call. The scope a tool runs on is read from
 * the grant, and any scope key the model wrote is dropped.
 *
 * No member session in the firm's tenant is needed: `checkGrantUse` reads only
 * storage (the grant, the collaborator, the kind's switch, the org rule, the
 * people check and `exists`).
 *
 * P2 is one turn with no history: the collaborator's thread (and the messages a
 * member reviews before they count) is P3, D7. A history supplied by the caller is
 * not accepted, because a client could then write the assistant's past turns.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import type { Storage } from '../storage/storage.js';
import type { AiToolCallRequest, AiToolCallResult } from '../executor/types.js';
import type { ChatMessage } from '../providers/dispatch.js';
import { OpenwopError } from '../types.js';
import { auditCollaboratorToolCall, checkGrantUse, grantResourceKind, kindCollaborationOn, viewerOf, type GrantUse } from './externalCollaborators.js';
import { clientToolDef, clientToolsFor, withoutScopeKeys, type ClientProjectTool, type ClientToolScope } from './clientProjectTools.js';
import { resolveOutsiderCredential, outsiderToolsRound, type OutsiderSpend } from './outsiderTurnCredential.js';
import { runScopedToolTurn } from './scopedToolTurn.js';
import { collabOwnerStamp } from './runOwner.js';
import { resolveServedAgent } from './agentServing.js';
import { fenceUntrustedBlock } from './untrustedContent.js';
import { toolRoundResult } from '../aiProviders/aiProvidersHost.js';
import { toolError } from './agentToolKit.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import { holdProposals } from './collabProposals.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.collaboratorTurn');

/** The synthetic workflow id a collaborator turn's run carries. */
export const COLLAB_TURN_WORKFLOW_ID = 'openwop-app.collab.turn';
export const COLLAB_MESSAGE_MAX_CHARS = 4000;

/** A collaborator turn's run. It stands for an outsider's conversation, not a graph:
 *  a member must never fork or replay it, which would re-dispatch the outsider's
 *  message under the member's own authority. */
export function isCollaboratorTurnRun(run: { workflowId?: string; metadata?: Record<string, unknown> }): boolean {
  return run.workflowId === COLLAB_TURN_WORKFLOW_ID || typeof run.metadata?.collabPrincipal === 'string';
}
const DEFAULT_TURNS_PER_GRANT_DAY = 50;
const DEFAULT_TURNS_PER_TENANT_DAY = 500;
/** Propose calls per grant per day (each holds at most MAX_PROPOSALS_PER_CALL items),
 *  so one collaborator cannot flood the firm's approvals inbox. */
const DEFAULT_PROPOSE_CALLS_PER_GRANT_DAY = 20;
const MAX_ROUNDS = 4;

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});

// ── caps: turns per grant per day, and per firm per day ──

interface CollabTurnDay { cKey: string; turns: number; tenantId: string; updatedAt: string }
const turnDays = new DurableCollection<CollabTurnDay>('collab:turn:day', (d) => d.cKey);
// A counter's window is one day; two days loses nothing a live cap needs.
registerKvAgeOut({ id: 'collab:turn:day', prefix: 'hostext:collab:turn:day:', ttlDays: 2, timestampField: 'updatedAt' });

function capFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

type Claim = 'claimed' | 'full' | 'contended';

/** Claim one turn on `cKey`, unless it already has `limit`. CAS, so two instances
 *  cannot both take the last turn. */
async function claimTurn(cKey: string, tenantId: string, limit: number): Promise<Claim> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cur = await turnDays.get(cKey);
    if ((cur?.turns ?? 0) >= limit) return 'full';
    const next: CollabTurnDay = { cKey, turns: (cur?.turns ?? 0) + 1, tenantId, updatedAt: new Date().toISOString() };
    if (await turnDays.compareAndSwap(cur ?? null, next)) return 'claimed';
  }
  return 'contended'; // fail closed, but not as "the limit for today"
}

/** The firm's cap is checked before the grant's, so a firm at its limit never spends
 *  a grant's turn. Only a contended or full GRANT row after a firm claim spends one. */
async function claimTurnCaps(use: GrantUse, day: string): Promise<{ refused: 'grant' | 'tenant'; claim: Exclude<Claim, 'claimed'> } | null> {
  const perGrant = capFromEnv('OPENWOP_COLLAB_TURNS_PER_GRANT_DAY', DEFAULT_TURNS_PER_GRANT_DAY);
  const perTenant = capFromEnv('OPENWOP_COLLAB_TURNS_PER_TENANT_DAY', DEFAULT_TURNS_PER_TENANT_DAY);
  const t = await claimTurn(`tenant:${use.tenantId}:${day}`, use.tenantId, perTenant);
  if (t !== 'claimed') return { refused: 'tenant', claim: t };
  const g = await claimTurn(`grant:${use.grant.grantId}:${day}`, use.tenantId, perGrant);
  if (g !== 'claimed') return { refused: 'grant', claim: g };
  return null;
}

// ── the turn ──

export interface CollaboratorTurnInput {
  storage: Storage;
  grantId: string;
  /** The signed-in collaborator's canonical user id (their own home tenant). */
  userId: string;
  message: unknown;
  /** Test seam: one tool round. Default: the firm's credential by the outsider rule. */
  callAIWithTools?: (r: AiToolCallRequest) => Promise<AiToolCallResult>;
}

export interface CollaboratorTurnResult { runId: string; reply: string; failed: boolean }

/** The grant's scope, for a tool. Every field comes from the grant. */
function scopeOf(use: GrantUse): ClientToolScope {
  const viewer = viewerOf(use);
  return {
    tenantId: use.tenantId, orgId: use.orgId,
    resourceKind: use.grant.resource.kind, resourceId: use.grant.resource.id,
    grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId,
    ...(viewer.audience ? { audience: viewer.audience } : {}),
  };
}

/** Test seam: the model round a route-level test drives the turn with. Honoured only
 *  under vitest, so a production process can never skip the firm's-credential rule. */
let testCallAIWithTools: CollaboratorTurnInput['callAIWithTools'];
export function __setCollabTurnModelForTests(fn: CollaboratorTurnInput['callAIWithTools']): void {
  if (fn && !process.env.VITEST) throw new Error('__setCollabTurnModelForTests is a test seam');
  testCallAIWithTools = fn;
}

export async function runCollaboratorTurn(rawInput: CollaboratorTurnInput): Promise<CollaboratorTurnResult> {
  const seam = process.env.VITEST ? testCallAIWithTools : undefined;
  const input: CollaboratorTurnInput = seam && !rawInput.callAIWithTools ? { ...rawInput, callAIWithTools: seam } : rawInput;
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new OpenwopError('validation_error', '`message` is required.', 400, { field: 'message' });
  if (message.length > COLLAB_MESSAGE_MAX_CHARS) {
    throw new OpenwopError('validation_error', `\`message\` is longer than ${COLLAB_MESSAGE_MAX_CHARS} characters.`, 400, { field: 'message' });
  }

  // The one per-use check, then the kind's switch. Every refusal is the uniform 404.
  const use = await checkGrantUse({ grantId: input.grantId, via: { userId: input.userId }, action: 'view' });
  const kindName = use.grant.resource.kind;
  if (!(await kindCollaborationOn(kindName, use.tenantId))) throw notFound();
  const kind = grantResourceKind(kindName);
  if (!kind?.turnAgentId) throw notFound();

  // ADR 1018 D8 — the firm's key, asked BEFORE a cap is claimed. No fallback.
  const cred = await resolveOutsiderCredential(use.tenantId);
  if (!input.callAIWithTools && cred.kind === 'refused') {
    log.warn('collab_turn_credential_refused', { grantId: use.grant.grantId, reason: cred.reason });
    throw new OpenwopError('service_unavailable', 'This project assistant cannot respond right now.', 503, {});
  }

  const agent = await resolveServedAgent(kind.turnAgentId, use.tenantId, `collab:${use.grant.grantId}`);
  // Another tenant's authored agent never runs here (its prompt is that tenant's).
  if (!agent || (agent.ownerTenant && agent.ownerTenant !== use.tenantId)) {
    log.warn('collab_turn_agent_unavailable', { grantId: use.grant.grantId });
    throw notFound();
  }

  // Caps last, so a turn refused for any other reason spends nothing.
  const day = new Date().toISOString().slice(0, 10);
  const capped = await claimTurnCaps(use, day);
  if (capped) {
    log.info('collab_turn_capped', { grantId: use.grant.grantId, scope: capped.refused, claim: capped.claim });
    if (capped.claim === 'contended') throw new OpenwopError('service_unavailable', 'The project assistant is busy. Try again in a moment.', 503, {});
    throw new OpenwopError('rate_limited', 'The project assistant has reached its limit for today. Try again tomorrow.', 429, { reason: `collab_turns_per_${capped.refused}` });
  }

  const tools = clientToolsFor(kindName, use.grant.actions);
  const byId = new Map<string, ClientProjectTool>(tools.map((t) => [t.id, t]));
  const spend: OutsiderSpend = { featureId: kind.featureId ?? 'external-collaborators', budgetMessage: 'The project assistant has reached its limit for today. Try again tomorrow.' };
  const callAIWithTools = input.callAIWithTools ?? (async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    if (cred.kind === 'refused') throw new OpenwopError('service_unavailable', 'This project assistant cannot respond right now.', 503, {});
    const round = await outsiderToolsRound(use.tenantId, cred, [
      { role: 'system', content: r.systemPrompt ?? '' },
      ...r.messages.map((m): ChatMessage => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
    ], r.tools, spend);
    return toolRoundResult(round);
  });

  const audit = (runId: string, tool: string, allowed: boolean, reason: string): Promise<void> =>
    auditCollaboratorToolCall(use.tenantId, { grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId, orgId: use.orgId, runId, tool, allowed, reason });

  const turn = await runScopedToolTurn({
    storage: input.storage,
    tenantId: use.tenantId,
    lane: 'collab',
    workflowId: COLLAB_TURN_WORKFLOW_ID,
    // No `principalKind`: the run is not the anonymous actor's (RFC 0132) and not a member's.
    runMetadata: { collabPrincipal: `collab:${use.collaborator.collaboratorId}`, grantId: use.grant.grantId, resource: { kind: kindName, id: use.grant.resource.id } },
    owner: collabOwnerStamp(use.collaborator.collaboratorId),
    agent: { agentId: agent.agentId, persona: agent.persona, systemPrompt: agent.systemPrompt },
    toolIds: tools.map((t) => t.id),
    // Only the client-tool registry resolves; nothing else can.
    toolSource: () => ({
      resolveTool: (name) => { const t = byId.get(name); return t ? clientToolDef(t) : undefined; },
      // A host sentence only: the tool name is the model's text (TOC2CD-11).
      executeTool: async () => toolError('unknown_tool', 'This tool is not available here.'),
    }),
    messages: [{ role: 'user', content: fenceUntrustedBlock(message, 'an outside collaborator on this project') }],
    callAIWithTools,
    maxRounds: MAX_ROUNDS,
    executeTool: async (call, { runId }) => {
      const tool = byId.get(call.name);
      if (!tool) {
        await audit(runId, call.name, false, 'not-a-client-tool');
        return toolError('unknown_tool', 'This tool is not available here.');
      }
      // Re-checked live on every call: a revoke, an expiry or a switch turned off
      // between two calls refuses the second.
      let live: GrantUse;
      try {
        live = await checkGrantUse({ grantId: use.grant.grantId, via: { userId: input.userId }, action: tool.action });
        if (!(await kindCollaborationOn(kindName, live.tenantId))) throw notFound();
      } catch {
        await audit(runId, tool.id, false, 'grant-not-usable');
        return toolError('access_ended', 'Access to this project has ended. Tell the person their access was removed or has expired.');
      }
      await audit(runId, tool.id, true, 'grant-allowed');
      try {
        if (tool.effect === 'propose') {
          // ADR 1099 D6 — nothing is written: each item is held for a member's review.
          const day = new Date().toISOString().slice(0, 10);
          const limit = capFromEnv('OPENWOP_COLLAB_PROPOSE_CALLS_PER_GRANT_DAY', DEFAULT_PROPOSE_CALLS_PER_GRANT_DAY);
          if ((await claimTurn(`propose:${live.grant.grantId}:${day}`, live.tenantId, limit)) !== 'claimed') {
            await audit(runId, tool.id, false, 'propose-capped');
            return toolError('proposals_capped', 'This person has sent as many proposals as they can today. Tell them the firm will review what they sent, and they can send more tomorrow.');
          }
          const held = await holdProposals(live, tool, scopeOf(live), withoutScopeKeys(call.input ?? {}), runId);
          return { content: JSON.stringify({ status: 'pending_review', held: held.held, alreadySent: held.duplicates, message: 'These were sent to the firm for review and are NOT recorded yet. Tell the person the firm will review them.' }) };
        }
        const result = await tool.run(scopeOf(live), withoutScopeKeys(call.input ?? {}));
        return { content: JSON.stringify(result ?? null) };
      } catch (err) {
        log.warn('collab_turn_tool_failed', { grantId: use.grant.grantId, tool: tool.id, error: err instanceof Error ? err.message : String(err) });
        return toolError('tool_failed', 'This information could not be read right now.');
      }
    },
    onForbidden: async (toolName, run) => { await audit(run.runId, toolName, false, 'not-granted'); },
    onFirewallDecision: async (d, run) => { await audit(run.runId, d.toolName, false, `firewall-${d.decision}`); },
  });

  return { runId: turn.runId, reply: turn.failed ? '' : sanitizeFreeText(turn.finalText), failed: turn.failed };
}

/** Test seam: forget the day counters. */
export async function __resetCollabTurnCapsForTests(): Promise<void> {
  for (const row of await turnDays.list()) await turnDays.delete(row.cKey);
}
