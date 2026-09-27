/**
 * RFC 0199 §C — the `credential` interrupt (ADR 0753 D8).
 *
 * A node whose config declares `auth: { type: "oauth2", provider, scopes }` is
 * checked on EVERY invocation, before it executes, while this host advertises
 * `oauth.credentialInterrupt`:
 *
 *  1. A RECORDED resolution for this node wins over the live state, always.
 *     `declined` fails the node (`connector_auth_declined`) even if a credential
 *     appeared since; `authorized` re-checks and fails (`connector_auth_expired`)
 *     rather than suspending a second time on the same key. Without this order a
 *     user's decline is silently overridden by a later connect — and a replay
 *     would take a different path than the live run did.
 *  2. With no recorded resolution: a credential that resolves lets the node run;
 *     otherwise the node suspends with a closed `CredentialData` — after emitting
 *     `connector.auth_expired` when the cause is a terminal refresh failure.
 *
 * The credential answer comes from `credentialStatusFor`, the same resolver the
 * node's own token fetch uses. The interrupt key is the node id.
 *
 * Only the host raises this kind: a pack's `ctx.suspend({kind:'credential'})`
 * still maps to `external-event` (`mapSuspendKind`), so no pack can mint an
 * interrupt that sends a user to a URL it chose.
 */
import { SuspendSignal } from '../executor/suspendSignal.js';
import { credentialStatusFor } from '../features/connections/connectionsService.js';
import { connectUrlFor, credentialInterruptAdvertised } from '../features/connections/oauthAdvertisement.js';

/** §E.3 — the fixed, closed resume schema for the kind: it carries no credential. */
export const CREDENTIAL_RESUME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome'],
  properties: { outcome: { enum: ['authorized', 'declined'] } },
} as const;

export interface NodeOAuthDeclaration {
  provider: string;
  scopes: string[];
}

/** The node's declared `auth`, when it is an oauth2 declaration; else null. */
export function nodeOAuthDeclarationOf(config: unknown): NodeOAuthDeclaration | null {
  if (!config || typeof config !== 'object') return null;
  const auth = (config as { auth?: unknown }).auth;
  if (!auth || typeof auth !== 'object') return null;
  const a = auth as { type?: unknown; provider?: unknown; scopes?: unknown };
  if (a.type !== 'oauth2' || typeof a.provider !== 'string' || a.provider === '') return null;
  const scopes = Array.isArray(a.scopes) ? a.scopes.filter((s): s is string => typeof s === 'string' && s !== '') : [];
  return { provider: a.provider, scopes: [...new Set(scopes)] };
}

/** A typed node failure the executor surfaces with its own code. */
export class CredentialGateError extends Error {
  constructor(readonly code: 'connector_auth_declined' | 'connector_auth_expired', message: string) {
    super(message);
    this.name = 'CredentialGateError';
  }
}

export async function runCredentialGate(args: {
  runId: string;
  nodeId: string;
  tenantId: string;
  actingUserId?: string;
  declaration: NodeOAuthDeclaration;
  suspendResolution?: { resumeKey: string; value: unknown };
  emit: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  if (!(await credentialInterruptAdvertised())) return;
  const { declaration } = args;
  const check = (): ReturnType<typeof credentialStatusFor> =>
    credentialStatusFor({
      tenantId: args.tenantId,
      provider: declaration.provider,
      scopes: declaration.scopes,
      ...(args.actingUserId !== undefined ? { actingUserId: args.actingUserId } : {}),
    });

  const seeded = args.suspendResolution?.resumeKey === args.nodeId ? args.suspendResolution.value : undefined;
  if (seeded !== undefined) {
    const outcome = (seeded as { outcome?: unknown } | null)?.outcome;
    if (outcome === 'declined') {
      throw new CredentialGateError('connector_auth_declined', `The user declined to authorize ${declaration.provider}.`);
    }
    const after = await check();
    if (after.status !== 'ok') {
      throw new CredentialGateError('connector_auth_expired', `No credential for ${declaration.provider} resolves after authorization.`);
    }
    return;
  }

  const status = await check();
  if (status.status === 'ok') return;

  const connectUrl = connectUrlFor(args.runId, args.nodeId);
  if (connectUrl === null) {
    // Unreachable while advertised (the predicate requires an https base); kept
    // fail-closed rather than emitting a CredentialData that violates its schema.
    throw new CredentialGateError('connector_auth_expired', `No credential for ${declaration.provider}, and no https connect URL can be issued.`);
  }
  if (status.status === 'expired') {
    // §C.2(b) — the auth-expired event precedes the interrupt.
    await args.emit('connector.auth_expired', { provider: declaration.provider, credentialRef: status.connectionId, reason: 'refresh_failed' });
  }
  const reason = status.status === 'insufficient_scope' ? 'insufficient_scope' : status.status === 'expired' ? 'expired' : 'missing';
  throw new SuspendSignal({
    kind: 'credential',
    resumeKey: args.nodeId,
    data: {
      provider: declaration.provider,
      scopes: declaration.scopes,
      reason,
      connectUrl,
      ...(status.status !== 'missing' ? { credentialRef: { ref: status.connectionId } } : {}),
    },
    resumeSchema: { ...CREDENTIAL_RESUME_SCHEMA, properties: { outcome: { enum: ['authorized', 'declined'] } } },
  });
}
