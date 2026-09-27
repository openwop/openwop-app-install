/**
 * `core.conformance.a2a-invoke` — the reference host's mapping of the
 * conformance-RESERVED A2A node the `conformance-a2a-task-roundtrip` fixture
 * declares (H25; `a2a-integration.md` §"State projection", RFC 0152 register
 * G6/G7).
 *
 * ── Why this node exists ────────────────────────────────────────────────────
 *
 * The fixture's node used to be spelled `core.a2a.invoke`. No host shipped it,
 * the corpus never defined it, and multi-segment `core.*` ids are pack-tier by
 * convention — so the suite renamed it on 2026-08-16 (openwop#1028) to the
 * conformance-reserved `core.conformance.a2a-invoke`, following the
 * `core.conformance.side-effect` precedent, and stated the rule with it:
 *
 *   a host that consumes A2A **MUST** map this typeId to its own A2A invoke
 *   bridge; a host that does not **MUST NOT** advertise the fixture.
 *
 * Until this node existed the openwop-app took the third, dishonest option: it
 * advertised the fixture (`capabilities.fixtures`) and failed at dispatch,
 * because the typeId resolved to nothing. That was invisible only because
 * `conformance/run.ts` never started the suite's fake peer, so drift points #3
 * and #4 returned early — neither passing nor `blocked`. H25 starts the peer,
 * which is what makes this node's absence a real red.
 *
 * ── What it does (a bridge, never a stub) ───────────────────────────────────
 *
 * It calls the peer through `createA2aSurface().sendMessage` — the SAME client
 * `ctx.a2a.*` uses from the `core.openwop.a2a` pack, with the same negotiation,
 * the same RFC 0093 egress guard and the same 1.0/0.3 codec split. A stub that
 * returned a canned state would satisfy the fixture's shape while proving
 * nothing about the reverse projection the scenario is measuring.
 *
 * The peer's terminal state is then projected per `a2a-integration.md`
 * §"State projection (reverse)":
 *
 *   - `AUTH_REQUIRED` → suspend on a `clarification` interrupt, which the
 *     executor surfaces as run status `waiting-input` (drift point #3 — v1 has
 *     no native auth-required interrupt kind, so the subkind rides the
 *     interrupt data).
 *   - `REJECTED`      → typed failure `rejected_by_remote` (drift point #4), so
 *     an observer can attribute the failure to the remote peer rather than to
 *     this host.
 *   - `FAILED` / `CANCELED` → a typed failure naming the peer state.
 *   - anything else   → success, carrying the task id and projected state.
 *
 * ── Peer address ────────────────────────────────────────────────────────────
 *
 * `OPENWOP_A2A_CONFORMANCE_PEER_URL` (base URL; the card GET resolves the RPC
 * endpoint from it). The suite's peer is in-process to the SUITE, so its port
 * is pinned by `conformance/run.ts` and handed to both sides. With no peer
 * configured the node fails TYPED rather than silently succeeding — a run that
 * "passed" without ever reaching a peer is the failure mode this whole item
 * exists to remove.
 *
 * Gated behind `conformanceNodesEnabled()` — never registered on a real deploy.
 */

import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { createA2aSurface } from '../host/a2aSurface.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';

/** The conformance-reserved typeId, corpus ≥ 1.122.0. */
export const CONFORMANCE_A2A_INVOKE_TYPE_ID = 'core.conformance.a2a-invoke';

/*
 * H47 — the legacy alias `core.a2a.invoke` is GONE.
 *
 * It existed because the host pinned a suite (1.106.0) whose vendored fixture
 * still spelled the node the pre-1.122.0 way, so registering only the reserved
 * id would have left the gate as uncovered as before while looking fixed. The
 * constant was written to be deleted by a later pin bump, on the stated
 * condition "when the pin moves past the rename, not before".
 *
 * That condition is now met and MEASURED, not assumed: the pin is `^1.136.0`,
 * `grep -l 'core\.a2a\.invoke' node_modules/@openwop/openwop-conformance/
 * fixtures/*.json` returns nothing, and `conformance-a2a-task-roundtrip.json`
 * has been re-vendored from the corpus at that version (byte-identical to the
 * installed copy) so the fixture this host actually LOADS carries the reserved
 * id too. The vendored copy is the load-bearing half — the host reads
 * `conformance-fixtures/`, never `node_modules` — which is why the npm pin alone
 * would not have justified this deletion.
 */

/** The suite's fake peer, or a real one an operator points us at. */
function peerBaseUrl(): string | null {
  const raw = process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/$/, '') : null;
}

/** Read `status.state` off a normalized Task (`a2aSurface` already folds the
 *  0.3 `input-required` and the 1.0 `TASK_STATE_INPUT_REQUIRED` spellings into
 *  the UPPERCASE_UNDERSCORE vocabulary the packs reason over). */
function projectedState(reply: unknown): { state: string | null; taskId: string | null } {
  if (!reply || typeof reply !== 'object') return { state: null, taskId: null };
  const r = reply as { status?: unknown; id?: unknown };
  const status = r.status;
  const state =
    status && typeof status === 'object' && typeof (status as { state?: unknown }).state === 'string'
      ? ((status as { state: string }).state)
      : null;
  return { state, taskId: typeof r.id === 'string' ? r.id : null };
}

async function invokePeer(ctx: NodeContext): Promise<NodeOutcome> {
  const baseUrl = peerBaseUrl();
  if (!baseUrl) {
    // TYPED, never success-with-empty: the scenario would otherwise record a
    // reverse projection that no peer ever produced.
    return {
      status: 'failure',
      error: {
        code: 'a2a_peer_not_configured',
        message: 'No A2A peer configured — set OPENWOP_A2A_CONFORMANCE_PEER_URL to the peer base URL.',
      },
    };
  }
  const skill = typeof (ctx.config as { skill?: unknown } | undefined)?.skill === 'string'
    ? (ctx.config as { skill: string }).skill
    : 'echo';
  // RFC 0207 §B — this node builds its OWN surface (it needs no run-scoped
  // state), so the run's trace context has to be handed to it explicitly;
  // `ctx.a2a` gets the same value from the executor's surface bundle.
  const surface = createA2aSurface({
    tenantId: ctx.tenantId,
    ...(ctx.traceContext ? { traceContext: ctx.traceContext } : {}),
  });
  const reply = await surface.sendMessage({
    baseUrl,
    message: {
      kind: 'message',
      role: 'ROLE_USER',
      text: skill,
      parts: [{ kind: 'text', text: skill }],
    },
  });
  const { state, taskId } = projectedState(reply);

  // Drift point #3 — no native auth-required interrupt kind in v1, so the
  // projection is `waiting-input` (executor `inferWaitingKind`) and the
  // auth-ness rides the interrupt data as a subkind.
  if (state === 'AUTH_REQUIRED') {
    return {
      status: 'suspended',
      interrupt: {
        kind: 'clarification',
        data: {
          subkind: 'auth',
          reason: 'a2a_peer_auth_required',
          ...(taskId ? { taskId } : {}),
        },
      },
    };
  }
  // Drift point #4 — attribute the failure to the REMOTE peer. A bare `failed`
  // would leave an observer unable to tell a peer refusal from a host defect.
  if (state === 'REJECTED') {
    return {
      status: 'failure',
      error: {
        code: 'rejected_by_remote',
        message: `A2A peer rejected the task${taskId ? ` (${taskId})` : ''}`,
      },
    };
  }
  if (state === 'FAILED' || state === 'CANCELED') {
    return {
      status: 'failure',
      error: { code: 'a2a_peer_terminal', message: `A2A peer ended the task in state ${state}` },
    };
  }
  return { status: 'success', outputs: { state, ...(taskId ? { taskId } : {}) } };
}

function bridgeNode(typeId: string): NodeModule {
  return {
    typeId,
    version: '1.0.0',
    // The call leaves this host and starts work on a peer — ADR 0341's
    // classifier must treat a replay as a recorded-outcome read, not a re-send.
    sideEffecting: true,
    execute: invokePeer,
  };
}

let registered = false;

/** Register the A2A invoke bridge under the reserved typeId. Idempotent. */
export function registerConformanceA2aInvokeNode(): void {
  if (registered) return;
  if (!conformanceNodesEnabled()) return;
  getNodeRegistry().register(bridgeNode(CONFORMANCE_A2A_INVOKE_TYPE_ID));
  registered = true;
}
