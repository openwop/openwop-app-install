/**
 * ADR 0894 D3 — proving that a person approved THIS action.
 *
 * Before this, `decide({approve: true})` was a boolean input: a chain could wire
 * the literal, or wire it from an LLM node that had read page text, and the step
 * was recorded `decidedBy: 'human'` with no human anywhere. The decide node now
 * raises its own approval interrupt for the pending action (`ctx.suspend`, key
 * {@link approvalResumeKey}, `approverRefs: [opener]`), and on resume the
 * surface asks THIS module whether the run's own record shows that interrupt
 * resolved to `accept`. Nothing the run passes in is believed except the node
 * id, and the node id is checked against the run's definition.
 *
 * The record is authoritative because only the ONE resolve path writes it
 * (`routes/interrupts.ts`), and that path authorises the resolver — with
 * `approverRefs` set, only the opener (or the opener's declared delegate,
 * ADR 0198) is eligible on the SIGNED-IN lane (ADR 0894 A1), and since ADR 0899
 * D1 the token lane requires the opener's signed emailed binding. A resolution
 * carrying `voter` is still refused below (CU2CD-2, defence in depth); the
 * opener's emailed decide-link is refused with it.
 */
import { OpenwopError } from '../../types.js';
import { normalizeApprovalAction } from '../../executor/interruptActions.js';
import { resolveRunDefinition } from '../../host/resolveRunDefinition.js';
import type { Storage } from '../../storage/storage.js';
import type { WorkflowDefinition } from '../../executor/types.js';
import type { CuSession } from './sessionStore.js';
import { shownAction, shownDigest } from './computerUseService.js';

/** The decide node's typeId (any version). */
export const DECIDE_NODE_TYPE = 'feature.computer-use.nodes.decide';

/** The per-action resume key the decide node suspends under. One action, one
 *  key — and the key carries the action's DIGEST (addendum G-A), so an approval
 *  for one action can never be replayed onto another the provider re-issued
 *  under the same id. */
export const approvalResumeKey = (sessionId: string, actionId: string, digest: string): string => `cu-approve:${sessionId}:${actionId}:${digest}`;

type Catalog = { getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> };

let reader: { storage: Storage; catalog: Catalog } | null = null;

/** Bound at route registration (the same process builds every run's surface).
 *  Unbound ⇒ every approve is refused: there is no record to prove it with. */
export function bindApprovalRecordReader(storage: Storage, catalog: Catalog): void {
  reader = { storage, catalog };
}

const EVENT_PAGE = 500;

/**
 * The id of the approval interrupt that authorises `session`'s pending action,
 * raised by `nodeId` in `runId`. Throws `approval_required` (409) for every
 * reason one does not exist; the caller must not branch on which.
 */
export async function verifiedApprovalInterrupt(input: { runId: string | undefined; nodeId: string; session: CuSession }): Promise<string> {
  const refuse = (): never => {
    throw new OpenwopError('approval_required', 'This action needs your approval in the run before the browser agent may take it.', 409, { sessionId: input.session.sessionId });
  };
  const action = input.session.pendingAction;
  if (!reader || !input.runId || !input.nodeId || !action) return refuse();
  const { storage, catalog } = reader;

  const run = await storage.getRun(input.runId);
  if (!run || run.tenantId !== input.session.tenantId) return refuse();
  // The node must be a computer-use decide node IN THIS RUN'S DEFINITION: a
  // `core.interrupt` node can forge any `data`, including the resume key below.
  const def = await resolveRunDefinition(run, catalog);
  const node = def?.definition.nodes.find((x) => x.nodeId === input.nodeId);
  if (!node || node.typeId.split('@')[0] !== DECIDE_NODE_TYPE) return refuse();

  const shown = shownAction(action, input.session.startUrl);
  const digest = shownDigest(shown);
  const key = approvalResumeKey(input.session.sessionId, action.actionId, digest);
  const consumed = new Set(input.session.consumedApprovals ?? []);
  for (let fromSeq = -1; ;) {
    const page = await storage.listEvents(input.runId, { fromSeq, limit: EVENT_PAGE });
    for (const e of page) {
      if (e.type !== 'node.suspended' || e.nodeId !== input.nodeId) continue;
      const interruptId = (e.payload as { interruptId?: unknown } | null)?.interruptId;
      if (typeof interruptId !== 'string' || consumed.has(interruptId)) continue;
      const rec = await storage.getInterrupt(interruptId);
      if (!rec || rec.runId !== input.runId || rec.nodeId !== input.nodeId || rec.kind !== 'approval' || !rec.resolvedAt) continue;
      const data = (rec.data ?? {}) as Record<string, unknown>;
      if (data.__resumeKey !== key || data.__resumeStyle !== 'reinvoke') continue;
      // Addendum 2 — the RECORDED fields the card rendered must be exactly the
      // shown action, and must themselves hash to the digest: the approval is of
      // what the approver saw, recomputed from what they saw.
      const cu = (data.computerUse ?? null) as { kind?: unknown; url?: unknown; digest?: unknown } | null;
      const note = typeof data.providerNote === 'string' ? data.providerNote : '';
      if (!cu || cu.digest !== digest || cu.kind !== shown.kind || cu.url !== shown.url || note !== shown.note) continue;
      if (shownDigest({ kind: cu.kind, url: cu.url, note }) !== digest) continue;
      // A1 — the recorded approver list must be exactly the opener, so a
      // re-shaped interrupt that admitted other approvers proves nothing.
      const refs = data.approverRefs;
      if (!Array.isArray(refs) || refs.length !== 1 || refs[0] !== input.session.createdBy) continue;
      // Grade-code CU2CD-2 — the capability-token lane (a bearer key, an emailed
      // link) used to admit an ACL'd single-approver gate on a body-declared
      // `voter` that was never verified (host residue ISWF-23, closed by ADR 0899
      // D1: the host now requires the per-recipient signature). Kept as defence in
      // depth, and as this feature's own decision (ADR 0894 C1): that lane is the
      // only one that carries `voter` (the session lane pins the signed-in user and
      // no app client sends it), so a resolution naming a voter never authorises a
      // browser commit — the opener approves signed in.
      const value = (rec.resolvedValue ?? null) as { action?: unknown; voter?: unknown } | null;
      if (value && Object.prototype.hasOwnProperty.call(value, 'voter')) continue;
      const verb = value?.action;
      if (typeof verb === 'string' && normalizeApprovalAction(verb) === 'accept') return interruptId;
    }
    if (page.length < EVENT_PAGE) break;
    fromSeq = page[page.length - 1]!.sequence;
  }
  return refuse();
}
