/**
 * Assistant workflow surface (ADR 0023 / ADR 0014) — `ctx.features.assistant`.
 *
 * The typed surface the loop node-pack calls. Reads project out host-internal
 * columns; writes are tenant-guarded at the SERVICE layer (CTI-1) and intended
 * for `role:action` nodes (recorded → replay-safe). Tenant comes from the run
 * scope; a cross-tenant id reads/writes as not-found.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import {
  listProjects,
  getProject,
  listCommitments,
  upsertCommitmentBySource,
  updateCommitment,
  listDecisions,
  logDecision,
  listMeetings,
  getMeeting,
  recordMeeting,
  listStakeholders,
  upsertStakeholder,
  listPendingActions,
  projectCommitmentToBoard,
  contentHashOf,
  type PersonRef,
  type SourceRef,
  type CommitmentStatus,
} from './assistantService.js';
import { prioritize, PRIORITY_PROFILES, type PriorityProfile } from './prioritization.js';
import { composeBriefing } from './briefing.js';
import { enqueueActionWithApproval } from './actionApproval.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';

const INTERNAL = new Set(['tenantId', 'createdAt', 'updatedAt']);
function project<T extends object>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

/** Coerce a node-supplied person arg into a PersonRef; defaults to 'self'. */
function personRefOf(v: unknown): PersonRef {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.kind === 'crm-contact' && typeof o.orgId === 'string' && typeof o.contactId === 'string') {
      return { kind: 'crm-contact', orgId: o.orgId, contactId: o.contactId };
    }
    if (o.kind === 'email' && typeof o.address === 'string') return { kind: 'email', address: o.address };
  }
  return { kind: 'self' };
}

/** Coerce a node-supplied source arg into a SourceRef (hashing text if needed). */
function sourceRefOf(v: unknown): SourceRef {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const kind = (['drive', 'gmail', 'calendar', 'transcript', 'kb-doc', 'manual'] as const).find((k) => k === o.kind) ?? 'manual';
  const externalId = typeof o.externalId === 'string' ? o.externalId : '';
  const contentHash = typeof o.contentHash === 'string' && o.contentHash.length > 0
    ? o.contentHash
    : contentHashOf(`${externalId}:${typeof o.text === 'string' ? o.text : ''}`);
  return {
    kind,
    externalId,
    contentHash,
    capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : new Date().toISOString(),
    ...(typeof o.kbDocumentId === 'string' ? { kbDocumentId: o.kbDocumentId } : {}),
    ...(typeof o.url === 'string' ? { url: o.url } : {}),
    // ADR 0027 — taint survives the surface coercion: a perception node's
    // 'untrusted' stamp must reach the stored row (laundering here would
    // un-taint every provider-derived entity).
    ...(o.contentTrust === 'trusted' || o.contentTrust === 'untrusted' ? { contentTrust: o.contentTrust } : {}),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function buildAssistantSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // ── reads ──
    listProjects: async () => ({ projects: (await listProjects(tenantId)).map(project) }),
    getProject: async (args) => ({ project: projectOne(await getProject(tenantId, str(args.projectId))) }),
    listCommitments: async (args) => {
      const filter: { status?: CommitmentStatus; projectId?: string } = {};
      if (optStr(args.status)) filter.status = str(args.status) as CommitmentStatus;
      if (optStr(args.projectId)) filter.projectId = str(args.projectId);
      return { commitments: (await listCommitments(tenantId, filter)).map(project) };
    },
    listDecisions: async (args) => ({ decisions: (await listDecisions(tenantId, optStr(args.projectId))).map(project) }),
    getMeeting: async (args) => ({ meeting: projectOne(await getMeeting(tenantId, str(args.meetingId))) }),
    listMeetings: async () => ({ meetings: (await listMeetings(tenantId)).map(project) }),
    listStakeholders: async () => ({ stakeholders: (await listStakeholders(tenantId)).map(project) }),
    listPendingActions: async (args) => ({
      pendingActions: (await listPendingActions(tenantId, optStr(args.status) as 'pending' | undefined)).map(project),
    }),

    // ── writes (role:action; idempotent where the service derives the key) ──
    upsertCommitment: async (args) => {
      const { commitment, created } = await upsertCommitmentBySource(tenantId, {
        owner: personRefOf(args.owner),
        description: str(args.description),
        source: sourceRefOf(args.source),
        ...(optStr(args.dueAt) ? { dueAt: str(args.dueAt) } : {}),
        ...(num(args.confidence) !== undefined ? { confidence: num(args.confidence) } : {}),
        ...(optStr(args.projectId) ? { projectId: str(args.projectId) } : {}),
      });
      return { commitment: project(commitment), created };
    },
    setCommitmentCard: async (args) => {
      const c = await updateCommitment(tenantId, str(args.commitmentId), { kanbanCardId: str(args.kanbanCardId) });
      return { commitment: projectOne(c) };
    },
    logDecision: async (args) => {
      const d = await logDecision(tenantId, {
        statement: str(args.statement),
        decidedBy: personRefOf(args.decidedBy),
        source: sourceRefOf(args.source),
        ...(optStr(args.rationale) ? { rationale: str(args.rationale) } : {}),
        ...(optStr(args.projectId) ? { projectId: str(args.projectId) } : {}),
      });
      return { decision: project(d) };
    },
    recordMeeting: async (args) => {
      const m = await recordMeeting(tenantId, {
        calendarEventId: str(args.calendarEventId),
        title: str(args.title),
        startAt: str(args.startAt),
        ...(optStr(args.endAt) ? { endAt: str(args.endAt) } : {}),
        ...(optStr(args.prepBriefRef) ? { prepBriefRef: str(args.prepBriefRef) } : {}),
        ...(optStr(args.transcriptKbDocId) ? { transcriptKbDocId: str(args.transcriptKbDocId) } : {}),
      });
      return { meeting: project(m) };
    },
    upsertStakeholder: async (args) => {
      const s = await upsertStakeholder(tenantId, {
        person: personRefOf(args.person),
        ...(num(args.importance) !== undefined ? { importance: num(args.importance) } : {}),
        ...(num(args.intendedCadenceDays) !== undefined ? { intendedCadenceDays: num(args.intendedCadenceDays) } : {}),
        ...(optStr(args.lastMeaningfulContactAt) ? { lastMeaningfulContactAt: str(args.lastMeaningfulContactAt) } : {}),
      });
      return { stakeholder: project(s) };
    },
    enqueueAction: async (args) => {
      // §12 T4 — enqueue ALSO creates the PendingApproval (the single loop)
      // and the inbox notification; card metadata rides through additively.
      const riskLevel = args.riskLevel === 'low' || args.riskLevel === 'medium' || args.riskLevel === 'high' ? args.riskLevel : undefined;
      const sourceRefs = Array.isArray(args.sourceRefs) ? args.sourceRefs.map((s) => sourceRefOf(s)) : undefined;
      const a = await enqueueActionWithApproval(tenantId, {
        kind: str(args.kind) as 'email.send',
        payload: (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>,
        draft: str(args.draft),
        ...(optStr(args.sourceCommitmentId) ? { sourceCommitmentId: str(args.sourceCommitmentId) } : {}),
        ...(riskLevel !== undefined ? { riskLevel } : {}),
        ...(Array.isArray(args.requiredScopes) ? { requiredScopes: args.requiredScopes.filter((x): x is string => typeof x === 'string') } : {}),
        ...(optStr(args.reason) ? { reason: str(args.reason) } : {}),
        ...(sourceRefs !== undefined ? { sourceRefs } : {}),
        ...(args.derivedFromUntrusted === true ? { derivedFromUntrusted: true } : {}),
      });
      return { pendingAction: project(a) };
    },

    // Loop 5 (ADR 0023 §12 T3) — the ONE briefing composer (briefing.ts),
    // shared with the GET /assistant/briefing route. `notify: true` (the
    // scheduled morning run) also drops an inbox notification (ADR 0010) —
    // emitted HOST-side here, never from pack code; best-effort like every
    // notification emit.
    composeBriefing: async (args) => {
      const brief = await composeBriefing(tenantId, {
        ...(optStr(args.profile) ? { profile: str(args.profile) as PriorityProfile['key'] } : {}),
      });
      if (args.notify === true) {
        try {
          await getNotificationEmitter().emit({
            tenantId,
            type: 'assistant.briefing',
            priority: 'normal',
            title: 'Your briefing is ready',
            message: sanitizeFreeText(brief.headline),
            actionUrl: '/inbox',
            metadata: { generatedAt: brief.generatedAt },
          });
        } catch {
          /* best-effort — the brief itself is the recorded output */
        }
      }
      return { brief };
    },

    // Loop 3 — project a commitment onto the owner's board (idempotent by back-ref).
    projectToBoard: async (args) => {
      const res = await projectCommitmentToBoard(tenantId, str(args.commitmentId), {
        ...(optStr(args.boardId) ? { boardId: str(args.boardId) } : {}),
        ...(optStr(args.ownerUserId) ? { ownerUserId: str(args.ownerUserId) } : {}),
      });
      if (!res) return { card: null, created: false };
      // §11 Q4 — `status` distinguishes created / reused / drifted / dismissed.
      // A dismissed (human-deleted) card returns no card and is NOT recreated.
      if (!res.card) return { card: null, created: false, status: res.status };
      return {
        card: { cardId: res.card.id, boardId: res.card.boardId, columnId: res.card.columnId, priority: res.card.priority },
        created: res.created,
        status: res.status,
      };
    },

    // Prioritization (ADR §4) — score a surface item and bucket it.
    prioritize: async (args) => {
      const profileKey = (optStr(args.profile) as PriorityProfile['key'] | undefined) ?? 'balanced';
      const profile = PRIORITY_PROFILES[profileKey] ?? PRIORITY_PROFILES.balanced;
      const { score, bucket } = prioritize(
        {
          senderImportance: num(args.senderImportance) ?? 0,
          deadlineProximity: num(args.deadlineProximity) ?? 0,
          projectPriority: num(args.projectPriority) ?? 0,
          priorEngagement: num(args.priorEngagement) ?? 0,
        },
        profile,
      );
      return { score, bucket, profile: profile.key };
    },
  };
}
