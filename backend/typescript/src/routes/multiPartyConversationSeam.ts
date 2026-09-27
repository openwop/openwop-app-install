/**
 * RFC 0101 multi-party conversation — host-sample conformance seam
 * (`spec/v1/host-sample-test-seams.md` §"Multi-party conversation seam").
 *
 * WHY A SEAM AND NOT A ROUTE. RFC 0101 standardizes the multi-party SHAPE — the
 * participant roster, the per-turn `speakerId`, the capability — but
 * deliberately mints **no normative client wire-route to open a conversation**:
 * opening, turn order and round protocol are host product policy. This host's
 * multi-party enforcement is bound to exactly such a product flow (ADR 0040's
 * advisory-board council, where the roster is the `agent:<id>` cohort of a
 * board group and the rule fires inside `conversationExchange` on a live run).
 * The suite cannot drive that host-agnostically, so the spec defines this seam
 * as the host-agnostic way to open a council and submit turns — and names THIS
 * host's board-group flow as the motivating case.
 *
 * WHAT THIS IS NOT. It is not a second multi-party implementation. The three
 * MUSTs are enforced by calling the SAME primitives the production path calls —
 * `participantRosterOf` (roster derivation), `isParticipant` (membership) and
 * `MAX_MULTI_PARTY_PARTICIPANTS` (the advertised cap). The council registry
 * holds a `ConversationMeta` of exactly the shape a board group produces, so
 * the roster is DERIVED by the real function rather than read from a field this
 * file invented. If the production rule changes, this seam changes with it or
 * goes red — which is the property that makes it evidence.
 *
 * The spec permits the seam to be self-contained ("a host MAY back it with a
 * small in-memory council registry"); it does not require the RFC 0005
 * conversation gate, a run, or a provider. So the registry is per-process and
 * tenant-scoped, and nothing here writes durable conversation state.
 *
 * The host advertised `multiPartyConversation.supported: true` without serving
 * this seam, so the behavioural leg had nothing to drive and soft-skipped —
 * an advertised capability with no suite-executable witness. That is what this
 * closes.
 *
 * @see spec/v1/host-sample-test-seams.md §"Multi-party conversation seam"
 * @see ../openwop/RFCS/0101-multi-party-group-conversation.md
 * @see src/host/multiPartyConversation.ts (the enforcement this routes through)
 * @see docs/adr/0040-board-of-advisors.md (the product flow it mirrors)
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import type { ConversationMeta } from '../host/conversationStore.js';
import { agentRef } from '../host/conversationStore.js';
import {
  MAX_MULTI_PARTY_PARTICIPANTS,
  isParticipant,
  participantRosterOf,
} from '../host/multiPartyConversation.js';

interface AgentRefBody {
  agentId?: unknown;
}

/** Per-process council registry. Keyed by tenant so two tenants cannot read or
 *  drive each other's council, matching the tenant scoping every conversation
 *  read already has. */
const councils = new Map<string, ConversationMeta>();

const key = (tenantId: string, conversationId: string): string => `${tenantId}::${conversationId}`;

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

/** Test-only: drop every council (suite teardown / `test/reset`). */
export function __resetMultiPartyCouncils(): void {
  councils.clear();
}

/**
 * Build the `ConversationMeta` a board group would have produced, so
 * `participantRosterOf` — the REAL derivation — can read the roster off it.
 * `type:'group'` + a `boardId` are exactly what that function requires before
 * it will report a roster at all; anything else reports `null`, which means
 * "not multi-party" and would silently disable the speaker rule.
 */
function councilMeta(tenantId: string, conversationId: string, agentIds: string[]): ConversationMeta {
  const now = new Date().toISOString();
  return {
    conversationId,
    tenantId,
    type: 'group',
    boardId: `conformance-council:${conversationId}`,
    participants: agentIds.map((agentId) => ({
      subjectRef: agentRef(agentId),
      role: 'member' as const,
      addedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  } as ConversationMeta;
}

/**
 * BOTH spellings, and that is load-bearing rather than belt-and-braces.
 *
 * `routes/testSeam.ts` installs a namespace rewrite when the test seam is
 * enabled: any `/v1/host/sample/*` url is rewritten to `/v1/host/openwop-app/*`
 * before route matching, because the product surface is the latter and the
 * pinned suite calls the former. So a seam registered ONLY under `sample` is
 * unreachable exactly when the test seam is on — i.e. under the conformance
 * boot, and only there. MEASURED: registering `sample` alone passed a host test
 * (rewrite off) and 404'd the conformance leg (rewrite on), which reads as
 * `seamAbsent` — the same "advertised but unobservable" failure the seam was
 * built to clear. Every other host-sample seam in this repo is registered as a
 * pair for this reason; `test/multi-party-conversation-seam.test.ts` drives
 * both spellings so the pair cannot rot back to one.
 */
const OPEN_PATHS = ['/v1/host/openwop-app/conversation/multi-party/open', '/v1/host/sample/conversation/multi-party/open'];
const EXCHANGE_PATHS = ['/v1/host/openwop-app/conversation/multi-party/exchange', '/v1/host/sample/conversation/multi-party/exchange'];

export function registerMultiPartyConversationSeamRoutes(app: Express): void {
  app.post(OPEN_PATHS, (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { conversationId?: unknown; participants?: unknown; maxParticipants?: unknown };
      const conversationId = body.conversationId;
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        throw new OpenwopError('validation_error', 'Field `conversationId` is required.', 400, { field: 'conversationId' });
      }
      if (!Array.isArray(body.participants)) {
        throw new OpenwopError('validation_error', 'Field `participants` MUST be an array of AgentRef.', 400, { field: 'participants' });
      }
      const agentIds: string[] = [];
      for (const p of body.participants as AgentRefBody[]) {
        const agentId = p?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          throw new OpenwopError('validation_error', 'Each participant MUST be an AgentRef with a string `agentId`.', 400, { field: 'participants' });
        }
        agentIds.push(agentId);
      }

      // MUST 3 — the cap. The REQUEST may narrow the advertised cap but never
      // widen it, so the effective limit is the smaller of the two: a caller
      // asking for `maxParticipants: 999` on a host advertising 8 still gets 8.
      const requested = typeof body.maxParticipants === 'number' && Number.isFinite(body.maxParticipants)
        ? body.maxParticipants
        : MAX_MULTI_PARTY_PARTICIPANTS;
      const cap = Math.min(requested, MAX_MULTI_PARTY_PARTICIPANTS);
      if (agentIds.length > cap) {
        throw new OpenwopError(
          'validation_error',
          `A council may seat at most ${cap} participants (requested ${agentIds.length}).`,
          422,
          { field: 'participants', maxParticipants: cap },
        );
      }

      councils.set(key(tenantOf(req), conversationId), councilMeta(tenantOf(req), conversationId, agentIds));
      res.status(200).json({ conversationId, accepted: true });
    } catch (err) {
      next(err);
    }
  });

  app.post(EXCHANGE_PATHS, (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { conversationId?: unknown; turn?: unknown };
      const conversationId = body.conversationId;
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        throw new OpenwopError('validation_error', 'Field `conversationId` is required.', 400, { field: 'conversationId' });
      }
      const meta = councils.get(key(tenantOf(req), conversationId));
      if (!meta) {
        throw new OpenwopError('not_found', `No open council for conversation '${conversationId}'.`, 404, { conversationId });
      }
      const turn = (body.turn ?? {}) as { role?: unknown; speakerId?: unknown };
      if (typeof turn.role !== 'string') {
        throw new OpenwopError('validation_error', 'Field `turn.role` is required.', 400, { field: 'turn.role' });
      }

      // The roster is DERIVED by the production function from the stored meta —
      // not read from a field this seam kept alongside it.
      const roster = participantRosterOf(meta);

      if (turn.role === 'agent') {
        const speakerId = typeof turn.speakerId === 'string' && turn.speakerId.length > 0 ? turn.speakerId : undefined;
        // MUST 1 — attribution. An agent turn without a speaker cannot be
        // attributed, and an unattributable turn in a multi-party transcript is
        // exactly what RFC 0101 exists to prevent.
        if (speakerId === undefined) {
          throw new OpenwopError('validation_error', "A role:'agent' turn MUST carry a `speakerId`.", 422, {
            conversationId,
            field: 'turn.speakerId',
          });
        }
        // MUST 2 — membership, fail-closed. `roster` is null only for a
        // non-multi-party conversation, which a council never is; treating null
        // as "allow" here would disable the rule the seam exists to witness.
        if (!roster || !isParticipant(roster, speakerId)) {
          throw new OpenwopError('validation_error', `Agent ${speakerId} is not a participant of this multi-party conversation.`, 422, {
            conversationId,
            speakerId,
          });
        }
      }

      res.status(200).json({ accepted: true });
    } catch (err) {
      next(err);
    }
  });
}
