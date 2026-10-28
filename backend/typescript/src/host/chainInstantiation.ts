/**
 * ADR 0959 P0 (architect H1) — instantiate a workflow chain as an OWNED, builder-editable
 * workflow: expand (RFC 0013), co-expand + stage sub-chains (RFC 0133), check disabled packs,
 * then commit children, the parent, its first revision (ADR 0474) and its ownership record.
 *
 * Extracted VERBATIM from the `POST /workflows/from-chain` route so the route and the
 * campaign-playbooks install share ONE sequence; neither may grow its own copy. The caller
 * passes the chain OBJECT (the route reads the registry; a playbook passes its immutable
 * version row's chain, never the registry's newest — ADR 0959 P-G1).
 */
import { OpenwopError } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { expandChain, coRegisterSubChains, SubChainError, type SubChainDeps, type WorkflowChain } from './workflowChainPackLoader.js';
import { requiredConfigKeysFor } from './nodeCatalogBuilder.js';
import { getRegisteredWorkflowAsync, registerWorkflowDurable, readRegisteredWorkflowFresh, registerWorkflowIfUnchanged } from './workflowsRegistry.js';
import { recordRevision, listRevisions, revisionVisibleTo } from './workflowRevisions.js';
import { recordOwnership, getOwned, uniqueOwnedName, isAuthoredByOtherTenant } from './workflowOwnership.js';
import { lifecycleOf, withLifecycle } from './workflowLifecycle.js';
import { revisionHashOf } from './definitionHash.js';
import { workflowRoomLive } from './collab/workflowCollabResource.js';
import { assertNoDisabledPacks } from './packEnablement.js';
import { copyWorkflowId, mintUnique, workflowIdOrigin } from './workflowId.js';

export interface InstantiateOwnedChainInput {
  tenantId: string;
  chain: WorkflowChain;
  params: Record<string, unknown>;
  deferred?: boolean;
  createdBy?: string;
  /** ADR 0913 — a feature-owned erasure label on the PARENT only. */
  subject?: string;
  /** ADR 0959 D2 — sub-chain resolution hooks (see `SubChainDeps`); absent = the registry. */
  resolve?: Pick<SubChainDeps, 'resolveSibling' | 'resolveExternal' | 'mintChildId'>;
  /** Host-only random copy id reserved in a durable install claim before this call. */
  reservedCopyId?: string;
  /**
   * ADR 0959 D6.4 — re-expand INTO an existing owned workflow (an upgrade or rollback) instead
   * of minting a new one: same id, the owned name kept, a new revision appended. The parent is
   * written with a compare-and-swap against the FRESH head; `expectHead` (a revision hash) is
   * the head the caller planned against, and a head that moved since is a 409
   * `workflow_head_moved`. `null` overwrites whatever the head is (a person accepted losing it).
   */
  into?: {
    workflowId: string; expectHead: string | null;
    /** Host-only durable intent, recorded after expansion/checks and before the head CAS. */
    beforeCommit?: (revision: string) => Promise<void>;
    /** Reconcile an acknowledgement loss only when the fresh head is exactly this expansion. */
    resumeIdentical?: boolean;
  };
}

export interface InstantiatedChain {
  def: WorkflowDefinition;
  workflowId: string;
  name: string;
  coRegisteredChildIds: string[];
  reusedChildIds: string[];
}

/**
 * ADR 0770 D3 (`WBWF-1`) — commit ONE staged sub-chain child. The child id is
 * deterministic per `(tenant, chain, version)` (RFC 0133 §1.3 convergence), so
 * a repeat instantiation lands on a child the tenant may already have EDITED.
 * The old commit was an unconditional overwrite: a fresh `params:{}` expansion
 * replaced the user's edits and rename, un-archived it, ignored a live room,
 * and changed what every earlier parent run replays against. Three outcomes:
 *
 *  - `created` — not owned here, or owned but the definition does not resolve
 *    (a lost fire-and-forget write): register + first revision + ownership,
 *    stamping `mintedRevision`.
 *  - `refreshed` — owned, and the head is still exactly what the host minted
 *    (`mintedRevision`), and no room is live: re-register the fresh expansion.
 *    This keeps re-instantiation as the heal for a child an OLDER host minted —
 *    expansion output changes under a fixed chain version. Lifecycle carries
 *    over (`revisionHashOf` strips it, so an archived-but-pristine child stays
 *    archived).
 *  - `reused` — anything else (edited, a legacy child with no stamp, or a live
 *    room): bound as-is, no write at all.
 *
 * No compensating delete on a later failure: a concurrent request may already
 * have reused a child this request created (architect H3). The worst case is an
 * owned, unreferenced child, as before.
 */
async function commitSubChainChild(
  tenantId: string,
  childDef: WorkflowDefinition,
  childName: string,
): Promise<'created' | 'refreshed' | 'reused'> {
  const id = childDef.workflowId;
  const owned = await getOwned(tenantId, id);
  // grade-code WBCD-2 — decide AND write against one FRESH read, with an atomic
  // swap: deciding from the per-instance cache and then writing blind let an
  // edit made on another instance (or between the read and the write) be
  // replaced by the refresh.
  const fresh = await readRegisteredWorkflowFresh(id);
  const head = owned ? fresh.def : null;
  let toWrite = childDef;
  let outcome: 'created' | 'refreshed' = 'created';
  if (owned && head) {
    const headRevision = revisionHashOf(head);
    // grade-code WBCD-8 — a child minted before `mintedRevision` existed carries
    // no stamp; it is provably pristine when its history is exactly the one
    // revision the mint recorded and the head still is that revision.
    const pristine = owned.mintedRevision !== undefined
      ? headRevision === owned.mintedRevision
      : await isSingleRevisionHead(id, tenantId, headRevision);
    if (!pristine || (await workflowRoomLive(id))) return 'reused';
    const lc = lifecycleOf(head);
    toWrite = withLifecycle(childDef, { transient: lc.transient, archivedAt: lc.archivedAt, generatedBy: lc.generatedBy });
    outcome = 'refreshed';
  }
  if (!(await registerWorkflowIfUnchanged(toWrite, fresh.raw))) return 'reused'; // it moved under us — keep theirs
  await recordRevision(tenantId, toWrite);
  const lc = lifecycleOf(toWrite);
  // grade-data D-7 — a chain-version bump rightly mints a NEW child (the id keys
  // on version), but it must not be a second workflow with the same name: a new
  // child takes a unique name; a child already owned keeps the one it has.
  const name = owned?.name ?? await uniqueOwnedName(tenantId, childName);
  await recordOwnership(tenantId, id, {
    name,
    nodeCount: toWrite.nodes.length,
    ...(lc.transient !== undefined ? { transient: lc.transient } : {}),
    ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : {}),
    mintedRevision: revisionHashOf(toWrite),
  });
  return outcome;
}

/** grade-code WBCD-8 — true when `workflowId`'s visible history is exactly one
 *  revision and it is the current head (a legacy, never-edited mint). */
async function isSingleRevisionHead(workflowId: string, tenantId: string, headRevision: string): Promise<boolean> {
  const rows = (await listRevisions(workflowId)).filter((r) => revisionVisibleTo(tenantId, r));
  return rows.length === 1 && rows[0]!.revisionHash === headRevision;
}

export async function instantiateOwnedChain(input: InstantiateOwnedChainInput): Promise<InstantiatedChain> {
  let expanded;
  let coRegisteredChildIds: string[] = [];
  // ADR 0770 D3 — STAGE, CHECK, then COMMIT. `coRegisterSubChains` keeps its
  // deps interface, but `register`/`own` now only COLLECT: nothing is written
  // until the parent and every child have expanded and passed the disabled-
  // pack gate. Before, children were registered + owned first and the gate
  // ran after (children never at all), so a refusal left owned orphans in
  // `/builder` and the `/` picker.
  const staged: Array<{ def: WorkflowDefinition; name: string }> = [];
  if (input.chain.subChains?.length) {
    try {
      // §Correction (grade-code MEDIUM-3 / grade-ux TPI-15 / grade-data DOC-1):
      // this comment used to claim the route ENFORCES required params and
      // refuses with `chain_missing_required_param`. It does NOT — that
      // enforcement was reverted in the same commit because it broke "Use
      // template = just copy", and the error code exists nowhere in the
      // codebase. Both branches are permissive by design; the config check
      // below is a REPORT only. Left corrected rather than deleted so the
      // next reader knows the honesty gap is still open, not half-closed.
      const result = await coRegisterSubChains(input.chain, { params: input.params, deferred: input.deferred === true, tenantId: input.tenantId, requiredConfigKeysFor }, {
        register: (childDef) => {
          if (!staged.some((st) => st.def.workflowId === childDef.workflowId)) staged.push({ def: childDef, name: childDef.workflowId });
        },
        own: async (wid, nm) => {
          const st = staged.find((x) => x.def.workflowId === wid);
          if (st) st.name = nm;
        },
        supported: process.env.OPENWOP_CHAIN_SUBCHAINS !== '0',
        ...(input.resolve ?? {}),
      });
      expanded = result.definition;
      coRegisteredChildIds = result.registeredChildIds;
    } catch (err) {
      if (err instanceof SubChainError) {
        const status = err.code === 'sub_chain_unsupported' ? 422 : 400;
        throw new OpenwopError('validation_error', err.message, status, { code: err.code });
      }
      throw err;
    }
  } else {
    // §Correction (code-review HIGH #1) — the config REPORT must cover this
    // branch: 167 of 169 shipped chains have no sub-chains, including
    // `exec-ops.daily-briefing` (the incident chain), so wiring it only to
    // the sub-chain branch left the check unreachable for the case that
    // motivated it.
    //
    // Required-param ENFORCEMENT is deliberately NOT applied here. It was,
    // briefly, and it broke a documented product contract: "Use template =
    // just copy — copies without a form" (this route's own test) and the
    // preflight modal's "Confirm never blocks on blanks". A template must be
    // copyable with blanks and completed in the builder. The incident is
    // fixed by the AI nodes carrying real defaults, not by refusing the copy.
    expanded = expandChain(input.chain, { params: input.params, deferred: input.deferred === true, requiredConfigKeysFor });
  }
  const into = input.into;
  const intoOwned = into ? await getOwned(input.tenantId, into.workflowId) : null;
  if (into && !intoOwned) throw new OpenwopError('not_found', 'workflow not found', 404, { workflowId: into.workflowId });
  if (input.reservedCopyId && (into || workflowIdOrigin(input.reservedCopyId) !== 'copy' || await isAuthoredByOtherTenant(input.tenantId, input.reservedCopyId))) {
    throw new OpenwopError('conflict', 'This reserved workflow cannot be used for the installation.', 409, { reason: 'workflow_head_moved' });
  }
  // R2 — a fresh owned instance id (the published chain id is not the instance id).
  const workflowId = into
    ? into.workflowId
    : input.reservedCopyId ?? await mintUnique(() => copyWorkflowId(input.chain.chainId), async (id) => Boolean(await getRegisteredWorkflowAsync(id)));
  const reservedHead = input.reservedCopyId ? await readRegisteredWorkflowFresh(workflowId) : null;
  const reservedOwner = input.reservedCopyId ? await getOwned(input.tenantId, workflowId) : null;
  // Preserve the template's name; on a collision with an existing owned
  // workflow append -2/-3/… (never the raw workflowId). Stamp the resolved
  // name on BOTH the definition (builder canvas) and the ownership record
  // (dashboard list) so the two surfaces never disagree. An upgrade keeps the name it has.
  const baseName = (typeof expanded.metadata?.name === 'string' && expanded.metadata.name.trim())
    ? expanded.metadata.name : input.chain.label;
  const reservedName = reservedHead?.def?.metadata?.name;
  const name = intoOwned?.name ?? reservedOwner?.name ?? (typeof reservedName === 'string' ? reservedName : await uniqueOwnedName(input.tenantId, baseName));
  const def = { ...expanded, workflowId, metadata: { ...expanded.metadata, name } };
  // ADR 0194 P3 — the POST choke, now over the parent AND every child, and
  // BEFORE anything is written (ADR 0770 D3, `WBWF-7`/`WBWF-8`).
  for (const d of [...staged.map((st) => st.def), def]) await assertNoDisabledPacks(d, input.tenantId);
  // Children first (depth-first staging order), so the parent's rewritten
  // `config.workflowId` always resolves.
  const reusedChildIds: string[] = [];
  for (const st of staged) {
    const outcome = await commitSubChainChild(input.tenantId, st.def, st.name);
    if (outcome === 'reused') reusedChildIds.push(st.def.workflowId);
  }
  if (into) {
    // ADR 0481 — a live room owns the head; an upgrade waits, as the builder rollback does.
    if (await workflowRoomLive(workflowId)) {
      throw new OpenwopError('conflict', 'This workflow is in a live collaboration session; upgrade it after everyone leaves.', 409, { workflowId, reason: 'workflow_room_live' });
    }
    const fresh = await readRegisteredWorkflowFresh(workflowId);
    const identical = into.resumeIdentical === true && fresh.def !== null && revisionHashOf(fresh.def) === revisionHashOf(def);
    if (!identical && into.expectHead !== null && (!fresh.def || revisionHashOf(fresh.def) !== into.expectHead)) {
      throw new OpenwopError('conflict', 'This workflow changed since the upgrade was planned.', 409, { workflowId, reason: 'workflow_head_moved' });
    }
    await into.beforeCommit?.(revisionHashOf(def));
    if (!identical && !(await registerWorkflowIfUnchanged(def, fresh.raw))) {
      throw new OpenwopError('conflict', 'This workflow changed while it was being upgraded.', 409, { workflowId, reason: 'workflow_head_moved' });
    }
  } else if (reservedHead) {
    if (reservedOwner?.archivedAt || (reservedHead.def && lifecycleOf(reservedHead.def).archivedAt)
      || (reservedHead.def && revisionHashOf(reservedHead.def) !== revisionHashOf(def))
      || (!reservedHead.def && !(await registerWorkflowIfUnchanged(def, null)))) {
      throw new OpenwopError('conflict', 'The reserved workflow changed; review it before retrying the installation.', 409, { reason: 'workflow_head_moved' });
    }
  } else {
    await registerWorkflowDurable(def); // ADR 0770 D2
  }
  // ADR 0474 — the instantiation IS the first revision (an upgrade appends one).
  await recordRevision(input.tenantId, def, { ...(input.createdBy ? { createdBy: input.createdBy } : {}) });
  const lc2 = lifecycleOf(def);
  await recordOwnership(input.tenantId, workflowId, {
    name, nodeCount: def.nodes.length,
    ...(intoOwned?.subject ? { subject: intoOwned.subject } : {}),
    ...(lc2.transient !== undefined ? { transient: lc2.transient } : {}),
    ...(lc2.archivedAt !== undefined ? { archivedAt: lc2.archivedAt } : {}),
    // ADR 0913 — the parent only. Sub-chain children are shared across
    // instantiations (their id keys on the chain version), so labelling one
    // would let one subject's erasure delete another's child.
    ...(input.subject ? { subject: input.subject } : {}),
  });
  return { def, workflowId, name, coRegisteredChildIds, reusedChildIds };
}
