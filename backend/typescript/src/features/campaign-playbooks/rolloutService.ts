/**
 * ADR 0959 D6/D7 (P2) — rollouts: plan an upgrade of a playbook across clients, approve the
 * plan on the ONE approvals queue (kind `playbook-rollout`), apply it client by client, and
 * roll a client back.
 *
 * - **Plan is pure.** Per target: the authored-graph diff (by original node id — expanded ids
 *   carry a params+version hash, so an expanded diff would call every node replaced), the
 *   config diff (`diffEntries`, the ADR 0387 helper), the conflicts the target version raises
 *   against the client's layers (`prepareInstall`'s typed refusals), and the drift. Class:
 *   `detached` (edited or deleted in the builder) > `conflicts` > `clean`. `planHash` covers
 *   every entry including each head revision, so a builder edit after planning changes it.
 * - **Gate.** The decide handler re-plans BEFORE resolving and refuses a plan that no longer
 *   hashes to what the approver saw (`plan_changed`, the review closes); separation of duties:
 *   the requester cannot approve while another agency admin can.
 * - **Apply** is manual per client, CAS'd per target (`pending → applying → applied`), and
 *   re-plans the ONE target: a class that changed since approval is `target_changed`.
 *   `conflicts` needs a replacement client layer valid for the target version; `detached`
 *   needs `overwrite: true` (and `missing` cannot be applied).
 * - **Rollback** re-installs the version the target came from with the layers it ran with
 *   (recorded on its history entry), in place — the head returns to the exact prior revision.
 * ADR 0942's single gate (#5051) is not merged; routing this kind through its
 * `playbook.rollout` action class is owed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { assertOrgScope, hasDistinctScopeHolder } from '../../host/accessControlService.js';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { createPlaybookRolloutApprovalOnce, getApproval, registerPlaybookRolloutApprovalHandler, resolveApproval, type PendingApproval } from '../../host/approvalService.js';
import { appendAudit } from '../../host/auditChainService.js';
import { diffEntries, type ConfigEntryDiff } from '../../host/configDomains.js';
import { readRegisteredWorkflowFresh } from '../../host/workflowsRegistry.js';
import { revisionHashOf } from '../../host/definitionHash.js';
import type { WorkflowChain } from '../../host/workflowChainPackLoader.js';
import { OpenwopError } from '../../types.js';
import { redactRows } from './redactRows.js';
import { createLogger } from '../../observability/logger.js';
import { getVersion, playbookHashOf } from './playbookStore.js';
import { getAgencyLayer, getInstallation, installationDrift, listPlaybookInstallations, mergeLayers, mergeSlots, parseLayer, prepareInstall, ringOf, upgradeInstallation } from './installService.js';
import { playbookResolution, subChainRefsOf, type PlaybookResolution } from './playbookResolver.js';
import { applyContent, planContent, type ContentApplyResult, type ContentItemPlan } from './contentService.js';
import { PLAYBOOK_RUN_STAMP_KEY, RING_ORDER, type ConfigLayer, type InstallationDrift, type PlaybookInstallation, type PlaybookRing, type PlaybookRunStamp, type PlaybookVersion } from './types.js';
import type { Storage } from '../../storage/storage.js';

const log = createLogger('features.campaign-playbooks.rollout');

export type TargetClass = 'clean' | 'conflicts' | 'detached';
export interface RolloutConflict { kind: string; key?: string; message: string }
export interface RolloutTargetPlan {
  orgId: string;
  fromVersion: string;
  class: TargetClass;
  drift: InstallationDrift;
  /** The head revision the plan was made against (null when the workflow is gone). */
  headRevision: string | null;
  chainDiff: { added: string[]; removed: string[]; changed: string[] };
  configDiff: ConfigEntryDiff;
  conflicts: RolloutConflict[];
  /** D5 — what the target version's content would do in this client org. */
  contentDiff: ContentItemPlan[];
}
export type TargetStatus = 'pending' | 'applying' | 'applied' | 'rolled_back';
/** D6.3 — one ring of a ring-mode rollout. */
export interface RolloutRing { name: Exclude<PlaybookRing, 'held'>; orgIds: string[]; soakHours: number; openedAt?: string }
/** OQ6 defaults (first guesses): canary 48 h, early 72 h, general none. */
export const DEFAULT_SOAK_HOURS: Record<Exclude<PlaybookRing, 'held'>, number> = { canary: 48, early: 72, general: 0 };
export interface PlaybookRollout {
  key: string;
  tenantId: string;
  rolloutId: string;
  playbookId: string;
  toVersion: string;
  plan: RolloutTargetPlan[];
  planHash: string;
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'closed' | 'halted' | 'completed';
  approvalId: string;
  requestedBy: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  closedReason?: string;
  /** D6.3 — ring mode: clients move one ring at a time; `ringIndex` is the open ring. */
  mode?: 'targets' | 'rings';
  rings?: RolloutRing[];
  ringIndex?: number;
  /** A failed health check stops the rollout (D6.3); rollback stays available. */
  haltReason?: string;
  haltedOrgIds?: string[];
  targets: Record<string, { status: TargetStatus; at?: string; by?: string; revision?: string }>;
}

const rollouts = new DurableCollection<PlaybookRollout>('campaign-playbooks:rollout', (r) => r.key, undefined, (r) => r.tenantId);
const rolloutKey = (tenantId: string, rolloutId: string): string => `${tenantId}::${rolloutId}`;
export const rolloutApprovalIdOf = (tenantId: string, rolloutId: string): string =>
  `appr:pbro:${createHash('sha256').update(JSON.stringify([tenantId, rolloutId])).digest('hex').slice(0, 32)}`;

function audit(tenantId: string, kind: string, payload: Record<string, unknown>): void {
  void appendAudit(tenantId, `campaign-playbooks.${kind}`, payload).catch((err) =>
    log.warn('campaign_playbooks_audit_failed', { kind, error: err instanceof Error ? err.message : String(err) }));
}

// ── the plan ──────────────────────────────────────────────────────────────────

/** The authored graph reachable from the entry chain, keyed by ref path + original node id. */
async function authoredGraph(resolution: PlaybookResolution, entry: WorkflowChain): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (chain: WorkflowChain, path: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const n of chain.dag.nodes) {
      out.set(`${path}${n.id}`, JSON.stringify({ typeId: n.typeId, config: n.config ?? {}, inputs: n.inputs ?? {} }));
    }
    for (const ref of subChainRefsOf(chain)) {
      const ext = (chain.subChains ?? []).map((s) => s.ref).find((r) => typeof r === 'object' && r.chainId === ref);
      const child = ext && typeof ext === 'object' ? await resolution.resolveExternal(ext, chain) : await resolution.resolveSibling(ref, chain);
      if (child) await walk(child, `${path}${ref}/`, depth + 1);
    }
  };
  await walk(entry, '', 0);
  return out;
}

function graphDiff(from: Map<string, string>, to: Map<string, string>): RolloutTargetPlan['chainDiff'] {
  const added = [...to.keys()].filter((k) => !from.has(k)).sort();
  const removed = [...from.keys()].filter((k) => !to.has(k)).sort();
  const changed = [...to.keys()].filter((k) => from.has(k) && from.get(k) !== to.get(k)).sort();
  return { added, removed, changed };
}

function conflictOf(err: unknown): RolloutConflict {
  if (err instanceof OpenwopError) {
    const d = (err.details ?? {}) as { reason?: string; code?: string; key?: string; ref?: string };
    return { kind: d.reason ?? d.code ?? err.code, ...(d.key ?? d.ref ? { key: d.key ?? d.ref } : {}), message: err.message };
  }
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
}

/** Plan ONE target. Pure: reads only. */
export async function planTarget(install: PlaybookInstallation, to: PlaybookVersion, agencyRow: ConfigLayer | null, clientOverride?: unknown): Promise<RolloutTargetPlan> {
  const tenantId = install.tenantId;
  const from = await getVersion(tenantId, install.playbookId, install.pinnedVersion);
  const drift = await installationDrift(install);
  let headRevision: string | null = null;
  if (install.workflowId && drift !== 'missing') {
    const fresh = await readRegisteredWorkflowFresh(install.workflowId).catch(() => null);
    headRevision = fresh?.def ? revisionHashOf(fresh.def) : null;
  }
  const clientRaw = clientOverride ?? install.layers.client ?? { params: {} };
  const conflicts: RolloutConflict[] = [];
  let toGraph = new Map<string, string>();
  let toConfig: Record<string, unknown> = {};
  try {
    const prepared = await prepareInstall(tenantId, to, clientRaw, agencyRow);
    toGraph = await authoredGraph(prepared.resolve, prepared.entry);
    toConfig = { params: prepared.params, slots: prepared.slots };
  } catch (err) {
    conflicts.push(conflictOf(err));
  }
  let fromGraph = new Map<string, string>();
  let fromConfig: Record<string, unknown> = {};
  if (from) {
    const client = install.layers.client;
    const agency = install.layers.agency;
    const entry = from.chains.find((c) => c.chainId === from.entryChainId);
    if (entry) fromGraph = await authoredGraph(playbookResolution(tenantId, from, mergeSlots(client, agency)), entry);
    fromConfig = { params: mergeLayers(from, client, agency), slots: mergeSlots(client, agency) };
  }
  const contentDiff = await planContent(install, to);
  // Content someone edited (or an owner now refuses to update) is a detached client: the person
  // must accept overwriting it, exactly as for an edited workflow.
  const contentEdited = contentDiff.some((c) => c.edited || c.locked);
  const cls: TargetClass = drift !== 'none' || contentEdited ? 'detached' : conflicts.length > 0 ? 'conflicts' : 'clean';
  return {
    orgId: install.orgId,
    fromVersion: install.pinnedVersion,
    class: cls,
    drift,
    headRevision,
    chainDiff: graphDiff(fromGraph, toGraph),
    configDiff: diffEntries(fromConfig, toConfig),
    conflicts,
    contentDiff,
  };
}

/** D6.1 — plan a rollout. Makes no writes. */
export async function planRollout(tenantId: string, playbookId: string, toVersion: string, orgIds: string[]): Promise<{ version: PlaybookVersion; plan: RolloutTargetPlan[]; planHash: string }> {
  const version = await getVersion(tenantId, playbookId, toVersion);
  if (!version) throw new OpenwopError('not_found', 'Playbook version not found.', 404, { playbookId, version: toVersion });
  const unique = [...new Set(orgIds)].sort();
  if (unique.length === 0) throw new OpenwopError('validation_error', 'Name at least one client.', 400, { field: 'orgIds' });
  const agencyRow = await getAgencyLayer(tenantId, playbookId);
  const plan: RolloutTargetPlan[] = [];
  for (const orgId of unique) {
    const install = await getInstallation(tenantId, orgId, playbookId);
    if (!install || install.status !== 'installed') throw new OpenwopError('validation_error', 'This playbook is not installed for one of the clients.', 400, { orgId, reason: 'playbook_not_installed' });
    if (install.pinnedVersion === toVersion) throw new OpenwopError('conflict', `One of the clients is already on ${toVersion}.`, 409, { orgId, reason: 'already_on_version' });
    if (ringOf(install) === 'held') throw new OpenwopError('conflict', 'One of the clients is held: every rollout skips it until it is released.', 409, { orgId, reason: 'install_held' });
    plan.push(await planTarget(install, version, agencyRow));
  }
  return { version, plan, planHash: playbookHashOf(plan) };
}

// ── the gate ──────────────────────────────────────────────────────────────────

export async function getRollout(tenantId: string, rolloutId: string): Promise<PlaybookRollout | null> {
  const r = await rollouts.get(rolloutKey(tenantId, rolloutId));
  return r && r.tenantId === tenantId ? r : null;
}

export async function listRollouts(tenantId: string, playbookId: string): Promise<PlaybookRollout[]> {
  return (await rollouts.listForTenant(tenantId)).filter((r) => r.tenantId === tenantId && r.playbookId === playbookId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** D6.2 — store the plan and open ONE review of it. */
export async function createRollout(tenantId: string, playbookId: string, toVersion: string, orgIds: string[], by: string, opts: { rings?: boolean; soakHours?: Partial<Record<Exclude<PlaybookRing, 'held'>, number>> } = {}): Promise<{ rollout: PlaybookRollout; approval: PendingApproval }> {
  let rings: RolloutRing[] | undefined;
  if (opts.rings) {
    // D6.3 — every installed client not held and not already on the version, grouped in ring order.
    const all = (await listPlaybookInstallations(tenantId, playbookId)).filter((i) => ringOf(i) !== 'held' && i.pinnedVersion !== toVersion);
    rings = RING_ORDER.map((name) => {
      const hours = opts.soakHours?.[name];
      return { name, orgIds: all.filter((i) => ringOf(i) === name).map((i) => i.orgId).sort(), soakHours: typeof hours === 'number' && hours >= 0 ? hours : DEFAULT_SOAK_HOURS[name] };
    }).filter((r) => r.orgIds.length > 0);
    orgIds = rings.flatMap((r) => r.orgIds);
  }
  const { plan, planHash } = await planRollout(tenantId, playbookId, toVersion, orgIds);
  const rolloutId = `ro_${randomUUID()}`;
  const approvalId = rolloutApprovalIdOf(tenantId, rolloutId);
  const rollout: PlaybookRollout = {
    key: rolloutKey(tenantId, rolloutId), tenantId, rolloutId, playbookId, toVersion, plan, planHash,
    status: 'awaiting_approval', approvalId, requestedBy: by, createdAt: new Date().toISOString(),
    targets: Object.fromEntries(plan.map((t) => [t.orgId, { status: 'pending' as const }])),
    ...(rings ? { mode: 'rings' as const, rings, ringIndex: 0 } : { mode: 'targets' as const }),
  };
  await rollouts.put(rollout);
  const counts = { clean: 0, conflicts: 0, detached: 0 };
  for (const t of plan) counts[t.class] += 1;
  const { approval } = await createPlaybookRolloutApprovalOnce({
    tenantId, approvalId, rolloutId, playbookId, planHash, requestedBy: by,
    proposal: `Roll out playbook "${playbookId}" ${toVersion} to ${plan.length} client(s): ${counts.clean} ready, ${counts.conflicts} with conflicts, ${counts.detached} edited since install.`,
  });
  audit(tenantId, 'rollout.requested', { rolloutId, playbookId, toVersion, planHash, approvalId, by, targets: plan.length });
  return { rollout, approval };
}

async function setRollout(cur: PlaybookRollout, patch: Partial<PlaybookRollout>): Promise<PlaybookRollout | null> {
  const next = { ...cur, ...patch };
  return (await rollouts.compareAndSwap(cur, next)) ? next : null;
}

async function isAgencyAdminUser(tenantId: string, userId: string): Promise<boolean> {
  try { await assertOrgScope(tenantId, userId, tenantId, 'host:members:manage'); return true; } catch { return false; }
}

async function decideRollout(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'playbook-rollout') return null;
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  if (!(await isAgencyAdminUser(tenantId, decidedBy))) {
    throw new OpenwopError('forbidden_scope', 'Only an agency admin can decide a playbook rollout.', 403, { requiredScope: 'host:members:manage' });
  }
  const rollout = await getRollout(tenantId, approval.playbookRolloutId ?? '');
  if (!rollout) return null;
  if (approval.playbookRolloutPlanHash !== rollout.planHash || rollout.approvalId !== approvalId) {
    throw new OpenwopError('conflict', 'This approval belongs to a different rollout plan.', 409, { reason: 'plan_changed' });
  }
  if (outcome === 'approved' && approval.status === 'pending') {
    // Separation of duties: the requester may not approve while another agency admin can.
    const requester = await canonicalDecider(tenantId, rollout.requestedBy);
    const decider = await canonicalDecider(tenantId, decidedBy);
    if ((!requester || !decider || requester === decider)
      && await hasDistinctScopeHolder(tenantId, 'host:members:manage', requester ?? rollout.requestedBy, { orgId: tenantId })) {
      throw new OpenwopError('forbidden', 'You requested this rollout, so another agency admin has to approve it.', 403, { reason: 'separation-of-duties' });
    }
    // Approve what you saw: the plan must still hash the same.
    const now = await planRollout(tenantId, rollout.playbookId, rollout.toVersion, rollout.plan.map((t) => t.orgId)).catch(() => null);
    if (!now || now.planHash !== rollout.planHash) {
      await resolveApproval(approvalId, { status: 'rejected', decidedBy, note: 'The plan changed after this review was opened (a client was edited, upgraded or reconfigured), so it was closed. Plan the rollout again.' });
      await setRollout(rollout, { status: 'closed', closedReason: 'plan_changed', decidedBy, decidedAt: new Date().toISOString() });
      audit(tenantId, 'rollout.refused', { rolloutId: rollout.rolloutId, reason: 'plan_changed' });
      throw new OpenwopError('conflict', 'The plan changed after this review was opened. Plan the rollout again.', 409, { reason: 'plan_changed' });
    }
  }
  const lock = await resolveApproval(approvalId, { status: outcome, decidedBy, ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!lock) return null;
  // The approval CAS is authoritative. Retry its original result rather than
  // letting a failed rollout-row write strand or reverse the decision.
  const resolved = lock.approval;
  if (resolved.status !== 'approved' && resolved.status !== 'rejected') return { approval: resolved, changed: false };
  let reconciled = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getRollout(tenantId, rollout.rolloutId);
    if (!cur || cur.planHash !== resolved.playbookRolloutPlanHash || cur.approvalId !== approvalId) break;
    if (cur.status !== 'awaiting_approval') { reconciled = true; break; }
    if (await setRollout(cur, { status: resolved.status, decidedBy: resolved.decidedBy, decidedAt: resolved.resolvedAt })) { reconciled = true; break; }
  }
  if (!reconciled) throw new OpenwopError('conflict', 'The approval is recorded; retry to finish updating its rollout.', 409, { reason: 'rollout_changed' });
  if (lock.changed) audit(tenantId, `rollout.${resolved.status}`, { rolloutId: rollout.rolloutId, planHash: rollout.planHash, approvalId, by: resolved.decidedBy });
  return { approval: resolved, changed: lock.changed };
}

export function registerPlaybookRolloutApproval(): void {
  registerPlaybookRolloutApprovalHandler(decideRollout);
}

// ── apply and rollback ────────────────────────────────────────────────────────

async function recordAppliedTarget(tenantId: string, rolloutId: string, orgId: string,
  status: 'applied' | 'rolled_back', install: PlaybookInstallation): Promise<void> {
  const history = [...install.history].reverse().find((h) => h.rolloutId === rolloutId && h.revision === install.expectedRevision);
  if (!history) throw new OpenwopError('conflict', 'The installation has no confirmed operation for this rollout.', 409, { reason: 'target_changed' });
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getRollout(tenantId, rolloutId);
    const target = cur?.targets[orgId];
    if (!cur || !target || (status === 'applied' && target.status === 'rolled_back')) break;
    if (target.status === status && target.revision === history.revision) return;
    if (await setRollout(cur, { targets: { ...cur.targets, [orgId]: { status, at: history.at, by: history.by, revision: history.revision } } })) return;
  }
  throw new OpenwopError('conflict', 'The installation is recorded; retry to finish updating its rollout.', 409, { reason: 'rollout_changed' });
}

/** D6.4 — apply an approved rollout to ONE client. Idempotent per (rollout, orgId). */
export async function applyRolloutTarget(input: { tenantId: string; rolloutId: string; orgId: string; by: string; clientLayer?: unknown; overwrite?: boolean }): Promise<{ installation: PlaybookInstallation; alreadyApplied: boolean; content?: ContentApplyResult }> {
  const { tenantId, rolloutId, orgId, by } = input;
  const rollout = await getRollout(tenantId, rolloutId);
  if (!rollout) throw new OpenwopError('not_found', 'Rollout not found.', 404, { rolloutId });
  const approved = rollout.plan.find((t) => t.orgId === orgId);
  const target = rollout.targets[orgId];
  if (!approved || !target) throw new OpenwopError('not_found', 'This client is not in the rollout.', 404, { orgId });
  const install = await getInstallation(tenantId, orgId, rollout.playbookId);
  if (!install) throw new OpenwopError('not_found', 'Installation not found.', 404, { orgId });
  if (target.status === 'applied') return { installation: install, alreadyApplied: true };
  if (rollout.status !== 'approved') throw new OpenwopError('conflict', rollout.status === 'halted' ? 'This rollout was stopped by a failed health check.' : 'This rollout is not approved.', 409, { reason: rollout.status === 'halted' ? 'rollout_halted' : 'rollout_not_approved', status: rollout.status });
  if (ringOf(install) === 'held') throw new OpenwopError('conflict', 'This client is held: release it before applying.', 409, { orgId, reason: 'install_held' });
  const open = openRing(rollout);
  if (rollout.mode === 'rings' && (!open || !open.orgIds.includes(orgId))) {
    throw new OpenwopError('conflict', 'This client is in a ring that is not open yet.', 409, { orgId, reason: 'ring_not_open', openRing: open?.name ?? null });
  }
  const version = await getVersion(tenantId, rollout.playbookId, rollout.toVersion);
  if (!version) throw new OpenwopError('not_found', 'Playbook version not found.', 404, {});
  // A previous attempt may have committed the installation and lost its final
  // rollout acknowledgement. Reconcile the recorded operation before re-planning.
  const completed = install.history.at(-1);
  if (completed?.rolloutId === rolloutId && completed.version === version.version && completed.revision === install.expectedRevision && install.contentHash === version.contentHash) {
    const content = await applyContent(install, version, by, { overwrite: input.overwrite === true });
    await recordAppliedTarget(tenantId, rolloutId, orgId, 'applied', install);
    return { installation: install, alreadyApplied: true, content };
  }
  const agencyRow = await getAgencyLayer(tenantId, rollout.playbookId);
  const pending = install.pendingUpgrade;
  const resuming = pending?.rolloutId === rolloutId && pending.version === version.version && pending.contentHash === version.contentHash;
  if (pending && !resuming) throw new OpenwopError('conflict', 'Finish the pending installation operation before applying another plan.', 409, { reason: 'playbook_install_changed' });
  // Re-plan this ONE target: approve-what-you-see holds per client.
  const now = await planTarget(install, version, agencyRow);
  if (!resuming && (now.class !== approved.class || now.headRevision !== approved.headRevision)) {
    throw new OpenwopError('conflict', 'This client changed since the rollout was approved. Plan it again.', 409, { reason: 'target_changed', approvedClass: approved.class, class: now.class });
  }
  if (!resuming && now.class === 'detached') {
    if (now.drift === 'missing') throw new OpenwopError('conflict', 'The installed workflow was deleted; install the playbook again instead.', 409, { reason: 'playbook_install_missing' });
    if (input.overwrite !== true) throw new OpenwopError('conflict', 'This client\'s workflow was edited in the builder. Applying replaces those edits; confirm with overwrite.', 409, { reason: 'detached_needs_overwrite' });
  }
  if (!resuming && now.class === 'conflicts' && input.clientLayer === undefined) {
    throw new OpenwopError('conflict', 'This client\'s values do not fit the new version. Provide replacement values.', 409, { reason: 'conflicts_need_resolution', conflicts: now.conflicts });
  }
  const prepared = await prepareInstall(tenantId, version, input.clientLayer ?? pending?.layers.client ?? install.layers.client ?? { params: {} }, pending ? pending.layers.agency : agencyRow);
  if (pending && pending.layersHash !== playbookHashOf({ params: prepared.params, slots: prepared.slots })) {
    throw new OpenwopError('conflict', 'The configuration differs from the pending installation operation.', 409, { reason: 'playbook_install_changed' });
  }
  const claimed = await setRollout(rollout, {
    targets: { ...rollout.targets, [orgId]: { status: 'applying', at: new Date().toISOString(), by } },
    ...(rollout.mode === 'rings' && rollout.rings && open && !open.openedAt
      ? { rings: rollout.rings.map((r, i) => (i === rollout.ringIndex ? { ...r, openedAt: new Date().toISOString() } : r)) }
      : {}),
  });
  if (!claimed) throw new OpenwopError('conflict', 'The rollout changed; try again.', 409, { reason: 'rollout_changed' });
  try {
    const installation = await upgradeInstallation({ install, version, prepared, expectHead: pending ? pending.expectHead : now.drift !== 'none' ? null : approved.headRevision, by, rolloutId });
    // D5 — content follows the workflow; `overwrite` (accepted for a detached client) covers edited items.
    const content = await applyContent(installation, version, by, { overwrite: input.overwrite === true });
    await recordAppliedTarget(tenantId, rolloutId, orgId, 'applied', installation);
    audit(tenantId, 'rollout.applied', { rolloutId, orgId, version: version.version, revision: installation.expectedRevision, by, contentFailed: content.failed.length });
    return { installation, alreadyApplied: false, content };
  } catch (err) {
    const cur = await getRollout(tenantId, rolloutId);
    if (cur && cur.targets[orgId]?.status === 'applying') await setRollout(cur, { targets: { ...cur.targets, [orgId]: { status: 'pending' } } });
    throw err;
  }
}

/** The open ring of a ring-mode rollout, or undefined. */
export function openRing(r: PlaybookRollout): RolloutRing | undefined {
  return r.mode === 'rings' && r.rings ? r.rings[r.ringIndex ?? 0] : undefined;
}

/** D6.4 in rings — apply every `clean` client of the open ring; the rest stay manual. */
export async function applyOpenRing(tenantId: string, rolloutId: string, by: string): Promise<{ applied: string[]; manual: Array<{ orgId: string; class: TargetClass }>; failed: Array<{ orgId: string; reason: string }> }> {
  const rollout = await getRollout(tenantId, rolloutId);
  if (!rollout) throw new OpenwopError('not_found', 'Rollout not found.', 404, { rolloutId });
  const ring = openRing(rollout);
  if (!ring) throw new OpenwopError('conflict', 'This rollout has no open ring.', 409, { reason: 'not_ring_mode' });
  const out = { applied: [] as string[], manual: [] as Array<{ orgId: string; class: TargetClass }>, failed: [] as Array<{ orgId: string; reason: string }> };
  for (const orgId of ring.orgIds) {
    const planned = rollout.plan.find((t) => t.orgId === orgId);
    if (!planned || rollout.targets[orgId]?.status === 'applied') continue;
    if (planned.class !== 'clean') { out.manual.push({ orgId, class: planned.class }); continue; }
    try {
      const result = await applyRolloutTarget({ tenantId, rolloutId, orgId, by });
      if (result.content?.failed.length) out.failed.push({ orgId, reason: 'content_partial' });
      else out.applied.push(orgId);
    } catch (err) {
      const reason = err instanceof OpenwopError ? String((err.details as { reason?: string } | undefined)?.reason ?? err.code) : 'error';
      // A halted or unapproved rollout stops the loop; a single client's refusal does not.
      if (reason === 'rollout_halted' || reason === 'rollout_not_approved') throw err;
      out.failed.push({ orgId, reason });
    }
  }
  return out;
}

/** Failed runs of `version` in `workflowId` since `since` (bounded, newest first). */
async function failedRunsSince(storage: Storage, tenantId: string, workflowId: string, playbookId: string, version: string, since: string): Promise<number> {
  const rows = await storage.listRuns({ tenantId, workflowId, status: 'failed', limit: 50 });
  return rows.filter((r) => {
    const stamp = (r.metadata as Record<string, unknown> | undefined)?.[PLAYBOOK_RUN_STAMP_KEY] as PlaybookRunStamp | undefined;
    return !!stamp && stamp.playbookId === playbookId && stamp.version === version && r.createdAt >= since;
  }).length;
}

/**
 * D6.3 — advance a ring-mode rollout to its next ring. Every client of the open ring must be
 * applied (or rolled back), the ring's soak must have passed since its last apply, and no client
 * of the ring may have a failed run of the new version since its apply — a failure HALTS the
 * rollout. The move itself is a compare-and-swap on `ringIndex`, so concurrent advances produce
 * exactly one transition. The ADR 0889 eval gate is not built (J959WF-8).
 */
export async function advanceRollout(storage: Storage, tenantId: string, rolloutId: string, by: string, now: Date = new Date()): Promise<PlaybookRollout> {
  const rollout = await getRollout(tenantId, rolloutId);
  if (!rollout) throw new OpenwopError('not_found', 'Rollout not found.', 404, { rolloutId });
  if (rollout.mode !== 'rings' || !rollout.rings) throw new OpenwopError('conflict', 'Only a ring rollout advances.', 409, { reason: 'not_ring_mode' });
  if (rollout.status !== 'approved') throw new OpenwopError('conflict', rollout.status === 'halted' ? 'This rollout was stopped by a failed health check.' : 'This rollout is not open.', 409, { reason: rollout.status === 'halted' ? 'rollout_halted' : 'rollout_not_approved', status: rollout.status });
  const index = rollout.ringIndex ?? 0;
  const ring = rollout.rings[index]!;
  const incomplete = ring.orgIds.filter((o) => rollout.targets[o]?.status !== 'applied' && rollout.targets[o]?.status !== 'rolled_back');
  if (incomplete.length) throw new OpenwopError('conflict', `The ${ring.name} ring is not finished.`, 409, { reason: 'ring_incomplete', orgIds: incomplete });
  const lastApply = ring.orgIds.map((o) => rollout.targets[o]?.at ?? '').sort().pop() ?? '';
  const soakUntil = new Date(Date.parse(lastApply) + ring.soakHours * 3_600_000);
  if (now.getTime() < soakUntil.getTime()) throw new OpenwopError('conflict', `The ${ring.name} ring is still soaking.`, 409, { reason: 'soak_pending', soakUntil: soakUntil.toISOString() });
  // Health: a failed run of the new version, in this ring, since that client's apply.
  const failing: string[] = [];
  for (const orgId of ring.orgIds) {
    const t = rollout.targets[orgId];
    if (t?.status !== 'applied' || !t.at) continue;
    const install = await getInstallation(tenantId, orgId, rollout.playbookId);
    const version = install ? await getVersion(tenantId, rollout.playbookId, rollout.toVersion) : null;
    if (t.status === 'applied' && install && version && (await planContent(install, version)).some((item) => item.action !== 'unchanged' && item.action !== 'removed')) {
      throw new OpenwopError('conflict', 'Finish reviewing this client’s playbook content before advancing the ring.', 409, { reason: 'content_partial', orgId });
    }
    if (install?.workflowId && (await failedRunsSince(storage, tenantId, install.workflowId, rollout.playbookId, rollout.toVersion, t.at)) > 0) failing.push(orgId);
  }
  if (failing.length) {
    const halted = await setRollout(rollout, { status: 'halted', haltReason: 'health_failed', haltedOrgIds: failing });
    audit(tenantId, 'rollout.halted', { rolloutId, ring: ring.name, orgIds: failing, by });
    throw new OpenwopError('conflict', `Runs failed on the new version in the ${ring.name} ring, so the rollout stopped.`, 409, { reason: 'health_failed', orgIds: failing, halted: !!halted });
  }
  const last = index + 1 >= rollout.rings.length;
  const next = await setRollout(rollout, last ? { status: 'completed' } : { ringIndex: index + 1 });
  if (!next) throw new OpenwopError('conflict', 'The rollout changed; reload it.', 409, { reason: 'rollout_changed' });
  audit(tenantId, last ? 'rollout.completed' : 'rollout.advanced', { rolloutId, from: ring.name, ...(last ? {} : { to: rollout.rings[index + 1]!.name }), by });
  return next;
}

/** D6.5 — put ONE client back on the version it came from, with the layers it ran with. */
export async function rollbackRolloutTarget(input: { tenantId: string; rolloutId: string; orgId: string; by: string }): Promise<PlaybookInstallation> {
  const { tenantId, rolloutId, orgId, by } = input;
  const rollout = await getRollout(tenantId, rolloutId);
  if (!rollout) throw new OpenwopError('not_found', 'Rollout not found.', 404, { rolloutId });
  const target = rollout.targets[orgId];
  const approved = rollout.plan.find((t) => t.orgId === orgId);
  if (!target || !approved) throw new OpenwopError('not_found', 'This client is not in the rollout.', 404, { orgId });
  if (target.status !== 'applied' && target.status !== 'rolled_back') throw new OpenwopError('conflict', 'Only an applied client can be rolled back.', 409, { reason: 'not_applied', status: target.status });
  const install = await getInstallation(tenantId, orgId, rollout.playbookId);
  if (!install) throw new OpenwopError('not_found', 'Installation not found.', 404, { orgId });
  const from = await getVersion(tenantId, rollout.playbookId, approved.fromVersion);
  if (!from) throw new OpenwopError('not_found', 'The previous version is gone.', 404, { version: approved.fromVersion });
  const completed = install.history.at(-1);
  if (completed?.rolloutId === rolloutId && completed.version === from.version && completed.revision === install.expectedRevision && install.contentHash === from.contentHash) {
    const content = await applyContent(install, from, by);
    await recordAppliedTarget(tenantId, rolloutId, orgId, 'rolled_back', install);
    if (content.failed.length) throw new OpenwopError('conflict', content.failed.map((f) => f.message).join(' '), 409, { reason: 'content_partial' });
    return install;
  }
  if (target.status === 'rolled_back') throw new OpenwopError('conflict', 'The installation changed after this rollback.', 409, { reason: 'target_changed' });
  // The layers that version ran with: its LAST history entry before this rollout's.
  const prior = [...install.history].reverse().find((h) => h.version === approved.fromVersion && h.rolloutId !== rolloutId);
  const layers = prior?.layers ?? {};
  const agency = layers.agency ? parseLayer(layers.agency, from, 'agencyLayer') : null;
  const prepared = await prepareInstall(tenantId, from, layers.client ?? { params: {} }, agency);
  const installation = await upgradeInstallation({ install, version: from, prepared, expectHead: target.revision ?? null, by, rolloutId });
  // D5 — the previous version's content back; an item edited since is reported, not overwritten.
  const content = await applyContent(installation, from, by);
  await recordAppliedTarget(tenantId, rolloutId, orgId, 'rolled_back', installation);
  if (content.failed.length) throw new OpenwopError('conflict', content.failed.map((f) => f.message).join(' '), 409, { reason: 'content_partial' });
  audit(tenantId, 'rollout.rolled-back', { rolloutId, orgId, version: from.version, revision: installation.expectedRevision, by });
  return installation;
}

/** ADR 0464 — a person's erasure tombstones who requested, decided and applied. */
export async function eraseRolloutPeople(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  return redactRows(rollouts, tenantId, (r) => {
    const touches = forms.has(r.requestedBy) || (r.decidedBy !== undefined && forms.has(r.decidedBy)) || Object.values(r.targets).some((t) => t.by !== undefined && forms.has(t.by));
    if (!touches) return null;
    const next: PlaybookRollout = {
      ...r,
      requestedBy: forms.has(r.requestedBy) ? tombstone : r.requestedBy,
      ...(r.decidedBy !== undefined ? { decidedBy: forms.has(r.decidedBy) ? tombstone : r.decidedBy } : {}),
      targets: Object.fromEntries(Object.entries(r.targets).map(([k, t]) => [k, t.by !== undefined && forms.has(t.by) ? { ...t, by: tombstone } : t])),
    };
    return next;
  });
}
