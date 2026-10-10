/**
 * `interrupt.requested` for every interrupt kind — interrupt.md §Events ("Every
 * kind uses two registered types"), §Re-entry (openwop#1697), loop row 3, P2 — interrupt.md §Events.
 *
 * The payload is the InterruptPayload (`suspend-request.schema.json`):
 * `{ kind, key, data, resumeSchema?, timeoutMs? }`, closed on BOTH majors, with
 * a closed per-kind `data` shape on v2. This host's nodes raise host-shaped
 * data (`core.approvalGate`: `{prompt, actions: ['approve','reject'],
 * approverRefs, …}`), so the payload is a PROJECTION per kind, not a copy.
 * Nothing is lost by projecting: the interrupt RECORD keeps the full host data,
 * and every surface a UI or agent reads (`GET …/interrupts`, the run snapshot's
 * `interrupt`, `/reviews`) reads the record, not this event.
 *
 * The kind list is `InterruptRecord['kind']`, and `PROJECTORS` is a total map
 * over it: a new host kind without a projector is a COMPILE error here.
 */
import type { InterruptRecord } from '../types.js';
import { normalizeApprovalAction } from './interruptActions.js';

type HostKind = InterruptRecord['kind'];
type Data = Record<string, unknown>;

export interface InterruptPayload {
  kind: string;
  key: string;
  data: Data;
  resumeSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

/** The approval preview every approval `interrupt.requested` names (see `ensureApprovalPreview`). */
export interface GatePreview { artifactId: string; artifactType: string }

/** The artifact type of a gate preview (the ADR 0083 `gate-preview` role, vendor-namespaced). */
export const GATE_PREVIEW_ARTIFACT_TYPE = 'openwop-app.gate-preview';

/**
 * interrupt.md §Re-entry: `key` is derived from at least the run, the node and
 * the node's VISIT index. A ctx.suspend / ctx.interrupt node supplies its own
 * deterministic per-invocation key (`__resumeKey`), which already
 * distinguishes two suspensions of one execution. A native return-and-resume
 * node runs once per visit, and today's scheduler visits each node once (it
 * refuses cycles), so its visit index is 0.
 *
 * Loop row 3 replaces `visit` with the executor's visit ordinal
 * when bounded loopback lands. THIS is the one function that changes.
 */
export function interruptRequestKey(runId: string, nodeId: string, data: unknown, visit = 0): string {
  const rk = (data as { __resumeKey?: unknown } | null | undefined)?.__resumeKey;
  return typeof rk === 'string' && rk.length > 0 ? `${runId}:${nodeId}:${rk}` : `${runId}:${nodeId}:${visit}`;
}

const APPROVAL_ACTIONS: ReadonlySet<string> = new Set(['accept', 'reject', 'refine', 'edit-accept', 'ask']);
const REJECTION_POLICIES: ReadonlySet<string> = new Set(['single-veto', 'majority']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** The host's engine-routing keys, which never reach the wire. */
function hostData(data: unknown): Data {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const { __resumeKey: _k, __resumeStyle: _s, ...rest } = data as Data;
  return rest;
}

function custom(kind: string, data: Data): { kind: string; data: Data } {
  return { kind: 'custom', data: { customKind: kind, payload: data } };
}

type Projector = (d: Data, ctx: { nodeId: string; preview?: GatePreview }) => { kind: string; data: Data };

const PROJECTORS: { readonly [K in HostKind]: Projector } = {
  approval: (d, { nodeId, preview }) => {
    // The same approve/override → accept normalisation `interrupt.resolved`
    // records (ADR 0725), so the requested and resolved vocabularies agree.
    const listed = strArr(d.actions);
    const mapped = listed ? [...new Set(listed.map(normalizeApprovalAction))].filter((a) => APPROVAL_ACTIONS.has(a)) : ['accept', 'reject'];
    // No listed action has a protocol spelling, or there is no preview to name:
    // an ApprovalData would have to invent one, so the honest shape is `custom`.
    if (mapped.length === 0 || !preview) return custom('approval', d);
    const out: Data = {
      artifactId: preview.artifactId,
      artifactType: preview.artifactType,
      title: str(d.title) ?? str(d.prompt) ?? str(d.question) ?? `Approve ${nodeId}`,
      actions: mapped,
    };
    const description = str(d.description);
    if (description !== undefined) out.description = description;
    if (typeof d.requiredApprovals === 'number' && Number.isInteger(d.requiredApprovals) && d.requiredApprovals >= 1) out.requiredApprovals = d.requiredApprovals;
    if (typeof d.rejectionPolicy === 'string' && REJECTION_POLICIES.has(d.rejectionPolicy)) out.rejectionPolicy = d.rejectionPolicy;
    if (typeof d.overrideBypassesQuorum === 'boolean') out.overrideBypassesQuorum = d.overrideBypassesQuorum;
    for (const k of ['approversList', 'approverGroupRefs', 'approverRoleRefs'] as const) {
      const v = strArr(d[k]);
      if (v !== undefined) out[k] = v;
    }
    return { kind: 'approval', data: out };
  },
  clarification: (d, { nodeId }) => {
    const qs = Array.isArray(d.questions)
      ? (d.questions as unknown[]).flatMap((q, i) => {
          const r = (q ?? {}) as Data;
          const question = str(r.question);
          return question ? [{ id: str(r.id) ?? `${nodeId}-${i + 1}`, question, ...(r.schema && typeof r.schema === 'object' ? { schema: r.schema } : {}) }] : [];
        })
      : [];
    const single = str(d.question);
    if (qs.length === 0 && single) qs.push({ id: nodeId, question: single, ...(d.schema && typeof d.schema === 'object' ? { schema: d.schema as Data } : {}) });
    return qs.length > 0 ? { kind: 'clarification', data: { questions: qs } } : custom('clarification', d);
  },
  'external-event': (d) => {
    const eventType = str(d.eventType);
    const correlation = d.correlation && typeof d.correlation === 'object' && !Array.isArray(d.correlation) ? d.correlation : undefined;
    return eventType && correlation ? { kind: 'external-event', data: { eventType, correlation } } : custom('external-event', d);
  },
  // The multi-turn node suspends ONCE, at the start of the exchange — the
  // `conversation.start` seat (the same mapping `interruptKindProjection` reads).
  conversation: (d) => {
    const conversationId = str(d.conversationId);
    if (!conversationId) return custom('conversation', d);
    const title = str(d.title);
    return { kind: 'conversation.start', data: { conversationId, ...(title ? { title } : {}) } };
  },
  // RFC 0199 §C.4 — already a closed wire object; routing keys stripped above.
  credential: (d) => ({ kind: 'credential', data: d }),
  refinement: (d) => custom('refinement', d),
  cancellation: (d) => custom('cancellation', d),
  timer: (d) => custom('timer', d),
  'tour-step': (d) => custom('tour-step', d),
  'walkthrough-step': (d) => custom('walkthrough-step', d),
};

/** Every host kind this module projects — the SoT a test enumerates. */
export const PROJECTED_HOST_KINDS: readonly HostKind[] = Object.keys(PROJECTORS) as HostKind[];

export function buildInterruptRequestedPayload(input: {
  runId: string;
  nodeId: string;
  kind: HostKind;
  data: unknown;
  resumeSchema?: Record<string, unknown>;
  preview?: GatePreview;
}): InterruptPayload {
  const d = hostData(input.data);
  const { kind, data } = PROJECTORS[input.kind](d, { nodeId: input.nodeId, ...(input.preview ? { preview: input.preview } : {}) });
  const timeoutMs = (input.data as { timeoutMs?: unknown } | null | undefined)?.timeoutMs;
  return {
    kind,
    key: interruptRequestKey(input.runId, input.nodeId, input.data),
    data,
    ...(input.resumeSchema !== undefined ? { resumeSchema: input.resumeSchema } : {}),
    ...(typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs >= 0 ? { timeoutMs } : {}),
  };
}
