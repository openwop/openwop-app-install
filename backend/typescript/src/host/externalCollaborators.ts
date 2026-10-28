/**
 * ADR 0958 D1/D2 — external collaborators: vendors, freelancers and client
 * stakeholders who work on ONE client's resources without joining the agency.
 *
 * There is no new principal kind and no membership row. A collaborator is a
 * record bound (once, at accept) to an ordinary user of THEIR OWN home tenant;
 * what they may touch is a set of grants, each naming one resource, a closed set
 * of actions and a mandatory expiry. Grants never become scopes, roles or
 * memberships, so no tenant-scoped route ever sees them.
 *
 * Owned beside accessControl (ADR 0006's single owner of identity and authority)
 * because sharing, approvals and campaign ops all consume it. Host layer: it
 * imports no feature. Features register the resource kinds they own
 * (`registerGrantResourceKind`) and the client-account gate
 * (`registerCollaborationOrgGate`).
 *
 * THE ONE CHECK. `checkGrantUse` runs on every use and decides from storage, live,
 * with no sweeper. Tenant and org come FROM THE GRANT, never from the request.
 * Every refusal is the same 404, so a caller learns nothing about what exists.
 * It also re-checks the person who GRANTED it (ADR 0886 D3 / ADR 0887 D1: a
 * member-minted capability re-runs the mint's own checks on every use). Only the
 * granter's PRESENT answer is memoized (≤ 30 s, dropped on a host removal or
 * demotion); a fault anywhere refuses the use.
 *
 * Rows are keyed by their unguessable id alone (`ccb_` / `cgr_` + uuid): a
 * signed-in vendor's request names a grant id and nothing else, so a composite
 * `tenant::org::id` key would force the request to carry the tenant, which D2
 * forbids. Each row still carries `tenantId` + `orgId`, and every read asserts
 * them.
 *
 * @see docs/adr/0958-vendor-and-guest-collaboration.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import { cleanString } from './boundedStrings.js';
import { declarePiiFields } from './dataClassification.js';
import { appendAudit, listChainTail, AUDIT_KIND_GOVERNANCE_DECISION } from './auditChainService.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { getRetentionHold } from './retentionHold.js';
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { assertOrgScope, isSharedWorkspaceTenant, isWorkspaceMember, onMemberAuthorityLost } from './accessControlService.js';
import { isSessionAuthorityRegistered, resolveSessionSubject } from './sessionAuthority.js';
import { getNotificationEmitter } from '../notifications/emitter.js';

const log = createLogger('host.externalCollaborators');

export type CollaboratorKind = 'vendor' | 'freelancer' | 'client-stakeholder';
export const COLLABORATOR_KINDS: readonly CollaboratorKind[] = ['vendor', 'freelancer', 'client-stakeholder'];
export type CollaboratorStatus = 'invited' | 'active' | 'suspended' | 'revoked';
export type CollaboratorMode = 'signed-in' | 'link-only';
export type GrantAction = 'view' | 'comment' | 'upload' | 'mark-ready' | 'decide';
export const GRANT_ACTIONS: readonly GrantAction[] = ['view', 'comment', 'upload', 'mark-ready', 'decide'];

export interface ExternalCollaborator {
  collaboratorId: string;
  tenantId: string;
  /** The client org: the ONLY isolation key. */
  orgId: string;
  kind: CollaboratorKind;
  /** Normalised (trimmed, lower-case). Never returned on a public surface. */
  email: string;
  displayName: string;
  company?: string;
  status: CollaboratorStatus;
  mode: CollaboratorMode;
  /** The canonical `User.userId` bound at accept (D2), never a principal string. */
  boundUserId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollaboratorGrant {
  grantId: string;
  tenantId: string;
  orgId: string;
  collaboratorId: string;
  resource: { kind: string; id: string };
  actions: GrantAction[];
  /** Required. Default 30 days, at most 180 (ADR 0958 Q1). */
  expiresAt: string;
  status: 'active' | 'revoked';
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
  /** ADR 0958 P5 — when the granter was told this grant expires within
   *  {@link EXPIRY_NOTICE_DAYS} days. Set by CAS before the notice is sent,
   *  so each grant is announced at most once across instances. */
  expiryNoticeAt?: string;
}

declarePiiFields('externalCollaborators.collaborator', ['email', 'displayName', 'company']);

const collaborators = new DurableCollection<ExternalCollaborator>('extcollab:c', (c) => c.collaboratorId, undefined, (c) => c.tenantId);
const grants = new DurableCollection<CollaboratorGrant>('extcollab:g', (g) => g.grantId, undefined, (g) => g.tenantId);
/** The cross-agency index by bound user: one row per binding, keyed
 *  `<boundUserId>::<collaboratorId>`, so a person's bindings are a bounded prefix
 *  read (erasure now; the vendor's "Shared with me" in P2). It holds ids only, and
 *  the home tenant stores nothing about the agency. */
interface BoundIndexRow { key: string; boundUserId: string; collaboratorId: string; tenantId: string }
const boundIndex = new DurableCollection<BoundIndexRow>('extcollab:bound', (r) => r.key, undefined, (r) => r.tenantId);
const boundKey = (userId: string, collaboratorId: string): string => `${userId}::${collaboratorId}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRANT_DAYS = 30;
const MAX_GRANT_DAYS = 180;
const nowIso = (): string => new Date().toISOString();
/** The tombstone an erased agency actor's id becomes (the sharing / kb value). */
const ERASED_ACTOR = 'erased';
const notFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});
const COLLABORATOR_ID_RE = /^(ccb|capr)_[0-9a-f-]{36}$/;

// ── the registries features fill ──

export interface GrantResourceKind {
  /** The OWNING feature's toggle, checked against the GRANT's tenant on every use
   *  (the comments ADR 0881 D2 rule): a feature the agency turned off serves no
   *  collaborator. `null` = an always-on owner, a decision recorded at the call site. */
  featureId: string | null;
  /** The actions this kind supports; a grant may name only these. */
  actions: readonly GrantAction[];
  /** Does the resource exist in (tenant, org)? MUST be an UNFILTERED read: a
   *  subject-filtered read cannot decide existence (ADR 0886/0887). */
  exists(tenantId: string, orgId: string, id: string): Promise<boolean>;
  /** Optional: does `parentId` (this kind) contain `child` in the same org? Lets a
   *  `campaign` grant cover that campaign's asset requests without listing them. */
  contains?(tenantId: string, orgId: string, parentId: string, child: { kind: string; id: string }): Promise<boolean>;
  /** What a collaborator sees of the resource (ADR 0958 P2): a closed, minimal
   *  projection the OWNING feature decides, never the stored row. `null` = it is
   *  not presentable right now (e.g. a brief demoted from approved), read as a 404. */
  project(tenantId: string, orgId: string, id: string): Promise<{ title: string; body: Record<string, unknown> } | null>;
  /** ADR 0958 P1 — only the owning feature mints grants of this kind, as a
   *  `system:` actor (the ADR 0924 approval link). The member grant route refuses
   *  it, so no person can hand a vendor a decision the feature never offered. */
  systemMintOnly?: boolean;
  /** ADR 0958 matrix row 10 — what an agency member may grant in this org, for
   *  the Collaborators panel's picker: id and a title only. Omitted ⇒ the kind
   *  is not offered there (it can still be granted by id through the route). */
  list?(tenantId: string, orgId: string): Promise<Array<{ id: string; title: string }>>;
}
const kinds = new Map<string, GrantResourceKind>();

/** Feature registration seam — called once at boot per resource kind. */
export function registerGrantResourceKind(kind: string, def: GrantResourceKind): void {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(kind)) throw new Error(`grant resource kind '${kind}' is not a lower-case slug`);
  kinds.set(kind, def);
}

/** Is the client account behind `orgId` usable (not paused or archived)? Host
 *  cannot read the account, so campaign-ops registers this. ABSENT ⇒ every use is
 *  refused (fail closed). */
export type CollaborationOrgGate = (tenantId: string, orgId: string) => Promise<boolean>;
let orgGate: CollaborationOrgGate | null = null;
export function registerCollaborationOrgGate(fn: CollaborationOrgGate): void {
  orgGate = fn;
}

async function ownerOn(kind: GrantResourceKind, tenantId: string): Promise<boolean> {
  if (kind.featureId === null) return true;
  try { return Boolean((await resolveOne(kind.featureId, { tenantId }))?.enabled); } catch { return false; }
}

async function orgOpen(tenantId: string, orgId: string): Promise<boolean> {
  if (!orgGate) return false;
  try { return await orgGate(tenantId, orgId); } catch { return false; }
}

function audit(tenantId: string, payload: Record<string, unknown>): Promise<void> {
  // Ids only — never the email (ADR 0958 D7).
  return appendAudit(tenantId, AUDIT_KIND_GOVERNANCE_DECISION, { domain: AUDIT_DOMAIN, ...payload })
    .then(() => undefined, (err: unknown) => { log.warn('extcollab_audit_failed', { tenantId, error: err instanceof Error ? err.message : String(err) }); });
}

// ── collaborators ──

export function normalizeEmail(raw: unknown): string {
  const e = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!e || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new OpenwopError('validation_error', '`email` must be an email address.', 400, { field: 'email' });
  }
  return e;
}

export async function getCollaborator(tenantId: string, orgId: string, collaboratorId: string): Promise<ExternalCollaborator | null> {
  const c = await collaborators.get(collaboratorId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export async function listCollaborators(tenantId: string, orgId: string): Promise<ExternalCollaborator[]> {
  return (await collaborators.listForTenantIndexed(tenantId))
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A new collaborator, `invited` until a matching user accepts (D2). One live
 *  (not revoked) record per email per client: a second invite is a 409. */
export async function createCollaborator(input: {
  tenantId: string; orgId: string; kind: unknown; email: unknown; displayName: unknown; company?: unknown; createdBy: string;
}): Promise<ExternalCollaborator> {
  if (!(await orgOpen(input.tenantId, input.orgId))) throw notFound();
  if (typeof input.kind !== 'string' || !(COLLABORATOR_KINDS as readonly string[]).includes(input.kind)) {
    throw new OpenwopError('validation_error', `\`kind\` must be one of: ${COLLABORATOR_KINDS.join(', ')}.`, 400, { field: 'kind' });
  }
  const email = normalizeEmail(input.email);
  const displayName = cleanString(input.displayName, 120, '').trim();
  if (!displayName) throw new OpenwopError('validation_error', '`displayName` is required.', 400, { field: 'displayName' });
  const company = input.company === undefined ? undefined : cleanString(input.company, 120, '').trim() || undefined;
  if ((await listCollaborators(input.tenantId, input.orgId)).some((c) => c.email === email && c.status !== 'revoked')) {
    throw new OpenwopError('conflict', 'This person is already a collaborator for this client.', 409, { reason: 'collaborator_exists' });
  }
  const now = nowIso();
  const row: ExternalCollaborator = {
    collaboratorId: `ccb_${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId,
    kind: input.kind as CollaboratorKind, email, displayName,
    ...(company ? { company } : {}),
    status: 'invited', mode: 'signed-in',
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  if (!(await collaborators.compareAndSwap(null, row))) throw new OpenwopError('conflict', 'Try again.', 409, {});
  await audit(input.tenantId, { action: 'collaborator.invite', collaboratorId: row.collaboratorId, orgId: row.orgId, kind: row.kind });
  return row;
}

/**
 * D3 — a link-only collaborator (a one-time reviewer such as the ADR 0924 client
 * approver). Active at once and never bound: it acts only through grant-backed
 * sharing links (`checkGrantLink`), never through a session. Same one-live-record-
 * per-email rule as an invite. `collaboratorId` is passed only when adopting a
 * pre-0958 row whose id is already recorded on approval rows.
 */
export async function createLinkOnlyCollaborator(input: {
  tenantId: string; orgId: string; kind: CollaboratorKind; email: unknown; displayName: unknown; createdBy: string;
  collaboratorId?: string; status?: 'active' | 'revoked'; createdAt?: string;
}): Promise<ExternalCollaborator> {
  if (!(await orgOpen(input.tenantId, input.orgId)) && input.collaboratorId === undefined) throw notFound();
  const email = normalizeEmail(input.email);
  const displayName = cleanString(input.displayName, 120, '').trim();
  if (!displayName) throw new OpenwopError('validation_error', '`displayName` is required.', 400, { field: 'displayName' });
  if (input.collaboratorId !== undefined && !COLLABORATOR_ID_RE.test(input.collaboratorId)) throw new Error(`invalid collaborator id ${input.collaboratorId}`);
  const status = input.status ?? 'active';
  // Adoption restores a record that already existed beside any others, so the
  // one-live-record rule applies to new records only (it would otherwise wedge
  // every read of a tenant whose pre-P1 approver is also a vendor).
  if (status !== 'revoked' && input.collaboratorId === undefined && (await listCollaborators(input.tenantId, input.orgId)).some((c) => c.email === email && c.status !== 'revoked')) {
    throw new OpenwopError('conflict', 'This person is already a collaborator for this client.', 409, { reason: 'collaborator_exists' });
  }
  const now = nowIso();
  const row: ExternalCollaborator = {
    collaboratorId: input.collaboratorId ?? `ccb_${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId,
    kind: input.kind, email, displayName,
    status, mode: 'link-only',
    createdBy: input.createdBy, createdAt: input.createdAt ?? now, updatedAt: now,
  };
  if (!(await collaborators.compareAndSwap(null, row))) {
    // An adoption that already ran (another instance, a retry) is not an error.
    const existing = input.collaboratorId ? await getCollaborator(input.tenantId, input.orgId, input.collaboratorId) : null;
    if (existing) return existing;
    throw new OpenwopError('conflict', 'Try again.', 409, {});
  }
  await audit(input.tenantId, { action: input.collaboratorId ? 'collaborator.adopt' : 'collaborator.add-link-only', collaboratorId: row.collaboratorId, orgId: row.orgId, kind: row.kind });
  return row;
}

/**
 * D2 — bind an invited collaborator to the accepting user. CAS from
 * `{invited, unbound}`; a lost race passes only for the SAME user (an idempotent
 * retry). Anything else is the uniform 404: no "already accepted" oracle.
 *
 * The bound-index row is written BEFORE the CAS and re-put on the same-user
 * path (ADR 0958 D2 MEDIUM, 2026-10-27). Written after it, a crash between the
 * two writes left a binding the index did not know, so "Shared with me" and the
 * home-tenant erasure never found it, and nothing repaired it. Written first,
 * the worst case is an index row for a binding that did not happen, which every
 * reader already ignores (each re-reads the record and compares `boundUserId`)
 * and which a losing caller deletes.
 */
export async function bindCollaborator(tenantId: string, orgId: string, collaboratorId: string, userId: string): Promise<ExternalCollaborator> {
  if (!userId) throw notFound();
  const indexRow: BoundIndexRow = { key: boundKey(userId, collaboratorId), boundUserId: userId, collaboratorId, tenantId };
  let wrote = false;
  // Our row is dropped ONLY when the record is provably not bound to this user
  // (bound to someone else, unbound, or gone). A record bound to this user keeps
  // it whatever its status: a same-user accept may have won the race and been
  // suspended since, and deleting the row then would hide a live binding from
  // "Shared with me" and the home-tenant erasure (Codex harness, 2026-10-27).
  const dropUnlessOurs = async (cur: ExternalCollaborator | null): Promise<void> => {
    if (wrote && cur?.boundUserId !== userId) await boundIndex.delete(indexRow.key);
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cur = await getCollaborator(tenantId, orgId, collaboratorId);
    if (!cur) { await dropUnlessOurs(null); throw notFound(); }
    if (cur.boundUserId === userId) {
      // Ours (a retry, or a same-user accept that won): repair the index row.
      await boundIndex.put(indexRow);
      if (cur.status === 'active') return cur;
      throw notFound();
    }
    if (cur.status !== 'invited' || cur.boundUserId !== undefined) { await dropUnlessOurs(cur); throw notFound(); }
    await boundIndex.put(indexRow);
    wrote = true;
    const next: ExternalCollaborator = { ...cur, status: 'active', boundUserId: userId, updatedAt: nowIso() };
    if (await collaborators.compareAndSwap(cur, next)) {
      await audit(tenantId, { action: 'collaborator.accept', collaboratorId, orgId });
      return next;
    }
  }
  await dropUnlessOurs(await getCollaborator(tenantId, orgId, collaboratorId));
  throw new OpenwopError('conflict', 'Try again.', 409, {});
}

/**
 * ADR 0958 D7 — archiving a client suspends its signed-in collaborators, so
 * un-archiving restores none of them without a decision (D2 MEDIUM,
 * 2026-10-27). Before this the archive was enforced only by the per-use org
 * gate, and un-archiving silently brought back every unexpired grant. A
 * link-only collaborator is left alone: its links are revoked by the owning
 * feature on archive (ADR 0921 Q2), and reactivating one is not how a link
 * comes back. Returns how many were suspended; throws if any could not be
 * (see {@link suspendOne}), leaving the archive to be retried.
 */
export async function suspendCollaboratorsForOrg(tenantId: string, orgId: string, actor: string): Promise<number> {
  let n = 0;
  for (const c of await listCollaborators(tenantId, orgId)) {
    if (c.status !== 'active' || c.mode !== 'signed-in') continue;
    if (await suspendOne(tenantId, orgId, c.collaboratorId, actor)) n += 1;
  }
  return n;
}

/** Suspend one collaborator for an archive. Fails CLOSED: it returns only once
 *  the record is suspended, or in a state that ends access for good (revoked,
 *  or gone after an erasure). Any other failure (a storage error, or the record
 *  still active after the retries) is thrown, so the archive call fails and is
 *  retried instead of reporting success over a grant that un-archiving would
 *  bring back (Codex harness, 2026-10-27). True when this call suspended it. */
async function suspendOne(tenantId: string, orgId: string, collaboratorId: string, actor: string): Promise<boolean> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cur = await getCollaborator(tenantId, orgId, collaboratorId);
    if (!cur || cur.status === 'revoked' || cur.status === 'suspended') return false;
    if (cur.status !== 'active') return false; // invited: holds no usable grant until accepted
    try {
      await setCollaboratorStatus(tenantId, orgId, collaboratorId, 'suspended', actor);
      return true;
    } catch (err) {
      // A lost CAS is re-read above; an unknown error surfaces on the re-read or
      // after the last attempt.
      lastErr = err;
    }
  }
  throw lastErr ?? new OpenwopError('conflict', 'The collaborator changed. Try again.', 409, {});
}

/** Set a collaborator's status (suspend, reactivate, revoke). Revoking also
 *  revokes every grant; a revoked collaborator cannot be brought back. */
export async function setCollaboratorStatus(
  tenantId: string, orgId: string, collaboratorId: string, status: 'active' | 'suspended' | 'revoked', actor: string,
): Promise<ExternalCollaborator> {
  const cur = await getCollaborator(tenantId, orgId, collaboratorId);
  if (!cur) throw notFound();
  if (cur.status === 'revoked') throw new OpenwopError('conflict', 'This collaborator was revoked; invite them again instead.', 409, { reason: 'collaborator_revoked' });
  if (status === 'active' && cur.mode !== 'link-only' && !cur.boundUserId) throw new OpenwopError('conflict', 'This collaborator has not accepted the invite yet.', 409, { reason: 'collaborator_not_accepted' });
  const next: ExternalCollaborator = { ...cur, status, updatedAt: nowIso() };
  if (!(await collaborators.compareAndSwap(cur, next))) throw new OpenwopError('conflict', 'The collaborator changed. Reload and try again.', 409, { reason: 'collaborator_changed' });
  if (status === 'revoked') {
    for (const g of await listGrants(tenantId, orgId, collaboratorId)) if (g.status === 'active') await revokeGrant(tenantId, orgId, g.grantId, actor);
  }
  await audit(tenantId, { action: `collaborator.${status === 'active' ? 'reactivate' : status === 'suspended' ? 'suspend' : 'revoke'}`, collaboratorId, orgId });
  return next;
}

// ── grants ──

export async function getGrant(tenantId: string, orgId: string, grantId: string): Promise<CollaboratorGrant | null> {
  const g = await grants.get(grantId);
  return g && g.tenantId === tenantId && g.orgId === orgId ? g : null;
}

export async function listGrants(tenantId: string, orgId: string, collaboratorId?: string): Promise<CollaboratorGrant[]> {
  return (await grants.listForTenantIndexed(tenantId))
    .filter((g) => g.tenantId === tenantId && g.orgId === orgId && (!collaboratorId || g.collaboratorId === collaboratorId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function grantAccess(input: {
  tenantId: string; orgId: string; collaboratorId: string;
  resource: unknown; actions: unknown; expiresInDays?: unknown; createdBy: string;
}): Promise<CollaboratorGrant> {
  if (!(await orgOpen(input.tenantId, input.orgId))) throw notFound();
  const collaborator = await getCollaborator(input.tenantId, input.orgId, input.collaboratorId);
  if (!collaborator) throw notFound();
  if (collaborator.status === 'revoked') throw new OpenwopError('conflict', 'This collaborator was revoked.', 409, { reason: 'collaborator_revoked' });
  const r = (input.resource && typeof input.resource === 'object' ? input.resource : {}) as { kind?: unknown; id?: unknown };
  const kindName = typeof r.kind === 'string' ? r.kind : '';
  const kind = kinds.get(kindName);
  const systemActor = input.createdBy.startsWith('system:');
  if (!kind || (kind.systemMintOnly && !systemActor)) {
    const offered = [...kinds].filter(([, k]) => !k.systemMintOnly || systemActor).map(([n]) => n).sort();
    throw new OpenwopError('validation_error', `\`resource.kind\` must be one of: ${offered.join(', ') || '(none registered)'}.`, 400, { field: 'resource.kind' });
  }
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id || id.length > 256) throw new OpenwopError('validation_error', '`resource.id` is required.', 400, { field: 'resource.id' });
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw new OpenwopError('validation_error', '`actions` must be a non-empty array.', 400, { field: 'actions' });
  const actions = [...new Set(input.actions as unknown[])];
  const bad = actions.filter((a) => typeof a !== 'string' || !kind.actions.includes(a as GrantAction));
  if (bad.length > 0) throw new OpenwopError('validation_error', `A ${kindName} grant may name only: ${kind.actions.join(', ')}.`, 400, { field: 'actions' });
  let days = DEFAULT_GRANT_DAYS;
  if (input.expiresInDays !== undefined) {
    if (typeof input.expiresInDays !== 'number' || !Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > MAX_GRANT_DAYS) {
      throw new OpenwopError('validation_error', `\`expiresInDays\` must be a whole number from 1 to ${MAX_GRANT_DAYS}.`, 400, { field: 'expiresInDays' });
    }
    days = input.expiresInDays;
  }
  if (!(await ownerOn(kind, input.tenantId)) || !(await kind.exists(input.tenantId, input.orgId, id))) throw notFound();
  const now = new Date();
  const row: CollaboratorGrant = {
    grantId: `cgr_${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId, collaboratorId: collaborator.collaboratorId,
    resource: { kind: kindName, id },
    actions: actions as GrantAction[],
    expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
    status: 'active',
    createdBy: input.createdBy, createdAt: now.toISOString(),
  };
  if (!(await grants.compareAndSwap(null, row))) throw new OpenwopError('conflict', 'Try again.', 409, {});
  await audit(input.tenantId, { action: 'grant.create', grantId: row.grantId, collaboratorId: row.collaboratorId, orgId: row.orgId, resource: row.resource, actions: row.actions });
  return row;
}

export async function revokeGrant(tenantId: string, orgId: string, grantId: string, actor: string): Promise<CollaboratorGrant> {
  const cur = await getGrant(tenantId, orgId, grantId);
  if (!cur) throw notFound();
  if (cur.status === 'revoked') return cur;
  const next: CollaboratorGrant = { ...cur, status: 'revoked', revokedAt: nowIso(), revokedBy: actor };
  if (!(await grants.compareAndSwap(cur, next))) throw new OpenwopError('conflict', 'The grant changed. Reload and try again.', 409, { reason: 'grant_changed' });
  await audit(tenantId, { action: 'grant.revoke', grantId, collaboratorId: cur.collaboratorId, orgId });
  return next;
}

// ── the one per-use check ──

/** A 403/404 from the authority read is an ANSWER ("no longer holds it"); any
 *  other error is a fault. Both refuse the use (see `checkGrantUse`), but only an
 *  answer may be remembered. */
function isRefusal(err: unknown): boolean {
  return err instanceof OpenwopError && (err.httpStatus === 403 || err.httpStatus === 404);
}

/** May `subject` still hold `host:members:manage` for this client? The grant route
 *  admits an agency admin (the scope on the agency root) OR a member holding it on
 *  the client org (`campaign-ops` `authorizeClient`), so either answer counts. A
 *  fault (not a refusal) propagates. */
async function holdsGrantScope(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  for (const scopeOrg of orgId === tenantId ? [tenantId] : [tenantId, orgId]) {
    try {
      await assertOrgScope(tenantId, subject, scopeOrg, 'host:members:manage');
      return true;
    } catch (err) {
      if (!isRefusal(err)) throw err;
    }
  }
  return false;
}

/** Is `userId` disabled? Read LIVE on every use (one point read), never memoized:
 *  a disable takes effect on the next use on every instance. "No row" is an actor
 *  this host never registered (seed/test), as in ADR 0887. A fault propagates. */
async function userDisabled(userId: string): Promise<boolean> {
  if (!isSessionAuthorityRegistered()) return false;
  const state = await resolveSessionSubject(userId);
  return state !== null && state.status !== 'active';
}

/**
 * ADR 0958 D2, reconciled with ADR 0886 D3 / ADR 0887 D1 — does the person who
 * GRANTED access still hold the grant route's authority in this client? Still a
 * member of a shared `ws:` workspace, still holding the mint's scope. (Disabled is
 * checked live, separately.) Returns true when present. A fault propagates.
 */
async function granterPresent(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  if (isSharedWorkspaceTenant(tenantId) && !(await isWorkspaceMember(subject, tenantId))) return false;
  return holdsGrantScope(tenantId, orgId, subject);
}

/**
 * `assertOrgScope` scans roles and groups on every call, and "Shared with me"
 * checks every grant a person holds, so a PRESENT answer (an allow) is memoized:
 *  - only the allow is kept; an absent answer is recomputed on every use, and a
 *    fault is never kept (the next use retries, and this one is refused);
 *  - at most 30 s (the ADR 0887 H3 bound, which ADR 0887 D1 accepts for share
 *    links on the same reasoning);
 *  - a removal or demotion the host performs (`onMemberAuthorityLost`, fired by
 *    `deleteMember` and by a member update that drops `host:members:manage`)
 *    drops that person's entries at once on THIS instance. Worst case: another
 *    Cloud Run instance, or an authority change that fires no hook (a custom-role
 *    or group edit), keeps an allow for up to 30 s.
 * Process-local and size-bounded.
 */
const GRANTER_ALLOW_TTL_MS = 30_000;
const GRANTER_ALLOW_MAX = 5_000;
const granterAllows = new Map<string, { tenantId: string; subject: string; at: number }>();

async function granterPresentMemo(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  const nowMs = Date.now();
  const key = `${tenantId}\u0000${orgId}\u0000${subject}`;
  const hit = granterAllows.get(key);
  if (hit && nowMs - hit.at < GRANTER_ALLOW_TTL_MS) return true;
  granterAllows.delete(key);
  if (!(await granterPresent(tenantId, orgId, subject))) return false;
  if (granterAllows.size >= GRANTER_ALLOW_MAX) {
    let victim: string | undefined;
    for (const [k, v] of granterAllows) { if (nowMs - v.at >= GRANTER_ALLOW_TTL_MS) { victim = k; break; } }
    granterAllows.delete(victim ?? (granterAllows.keys().next().value as string));
  }
  granterAllows.set(key, { tenantId, subject, at: nowMs });
  return true;
}

onMemberAuthorityLost('external-collaborators.granter-allow', async (lost) => {
  let dropped = 0;
  for (const [k, v] of granterAllows) {
    if (v.tenantId === lost.tenantId && v.subject === lost.subject) { granterAllows.delete(k); dropped += 1; }
  }
  return dropped;
});

/** Test seams (ADR 0958 D2 MEDIUM): the bound-index row for one binding. */
export async function __boundIndexHasForTests(userId: string, collaboratorId: string): Promise<boolean> {
  return (await boundIndex.get(boundKey(userId, collaboratorId))) !== null;
}
export async function __dropBoundIndexRowForTests(userId: string, collaboratorId: string): Promise<void> {
  await boundIndex.delete(boundKey(userId, collaboratorId));
}

/** Test seam: forget memoized granter allows. */
export function __resetGranterVerdictsForTests(): void {
  granterAllows.clear();
}

/** Test seam: how many granter allows are memoized (invalidation witness). */
export function __granterAllowCountForTests(): number {
  return granterAllows.size;
}

/** Steps after the grant itself: the granter (live disable + memoized presence)
 *  and the collaborator's own account. ANY fault refuses the use with the same
 *  uniform 404 (fail closed) and is logged; nothing about a fault is memoized. */
async function peopleStillAllowed(grant: CollaboratorGrant, collaborator: ExternalCollaborator): Promise<boolean> {
  try {
    if (collaborator.boundUserId && (await userDisabled(collaborator.boundUserId))) return false;
    const by = grant.createdBy;
    if (!by || by.startsWith('system:')) return true;
    if (await userDisabled(by)) return false;
    return await granterPresentMemo(grant.tenantId, grant.orgId, by);
  } catch (err) {
    log.warn('extcollab_check_fault_refused', { grantId: grant.grantId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export interface GrantUse {
  tenantId: string;
  orgId: string;
  grant: CollaboratorGrant;
  collaborator: ExternalCollaborator;
}

/**
 * D2 — may this caller do `action` through `grantId` (on `target`, default the
 * grant's own resource)? Runs on EVERY use and reads everything live. Returns the
 * tenant and org FROM THE GRANT. Every refusal is the same 404.
 *
 *  - `via: {userId}` — signed-in mode: the collaborator must be bound to that
 *    canonical user. A principal string is never compared.
 *  - `via: {link: true}` — link-only mode (D3): a grant-backed sharing link the
 *    caller already proved possession of; no user binding.
 */
export async function checkGrantUse(input: GrantUseInput): Promise<GrantUse> {
  try {
    return await checkGrantUseOnce(input);
  } catch (err) {
    // Fail closed and uniform: a fault (storage, a resource kind's `exists`) is the
    // same 404 as a refusal, so the outside learns nothing and gains nothing.
    if (!(err instanceof OpenwopError && err.httpStatus === 404)) {
      log.warn('extcollab_check_fault_refused', { grantId: input.grantId, error: err instanceof Error ? err.message : String(err) });
    }
    throw notFound();
  }
}

interface GrantUseInput {
  grantId: string;
  via: { userId: string } | { link: true };
  action: GrantAction;
  target?: { kind: string; id: string };
  now?: Date;
}

async function checkGrantUseOnce(input: GrantUseInput): Promise<GrantUse> {
  const grant = input.grantId ? await grants.get(input.grantId) : null;
  if (!grant || grant.status !== 'active') throw notFound();
  const now = input.now ?? new Date();
  if (!(Date.parse(grant.expiresAt) > now.getTime())) throw notFound();
  const collaborator = await collaborators.get(grant.collaboratorId);
  if (!collaborator || collaborator.tenantId !== grant.tenantId || collaborator.orgId !== grant.orgId) throw notFound();
  if (collaborator.status !== 'active') throw notFound();
  // Each mode has exactly one lane. A signed-in collaborator's grant never works
  // through a bare link (that would drop the account binding), and a link-only
  // collaborator never acts through a session.
  if ('userId' in input.via) {
    if (collaborator.mode !== 'signed-in' || !input.via.userId || collaborator.boundUserId !== input.via.userId) throw notFound();
  } else if (collaborator.mode !== 'link-only') {
    throw notFound();
  }
  if (!grant.actions.includes(input.action)) throw notFound();
  const kind = kinds.get(grant.resource.kind);
  if (!kind) throw notFound();
  if (!(await ownerOn(kind, grant.tenantId))) throw notFound();
  if (!(await orgOpen(grant.tenantId, grant.orgId))) throw notFound();
  if (!(await peopleStillAllowed(grant, collaborator))) throw notFound();
  if (!(await kind.exists(grant.tenantId, grant.orgId, grant.resource.id))) throw notFound();
  const target = input.target;
  if (target && !(target.kind === grant.resource.kind && target.id === grant.resource.id)) {
    if (!kind.contains || !(await kind.contains(grant.tenantId, grant.orgId, grant.resource.id, target))) throw notFound();
  }
  return { tenantId: grant.tenantId, orgId: grant.orgId, grant, collaborator };
}

/** D3 — the sharing `resourceId` of a grant-backed link: `${itemId}:${grantId}`
 *  (the `sign_request` shape). The grant id is the suffix after the LAST colon. */
export const grantLinkResourceId = (itemId: string, grantId: string): string => `${itemId}:${grantId}`;
export function parseGrantLinkResourceId(resourceId: string): { itemId: string; grantId: string } | null {
  const i = resourceId.lastIndexOf(':');
  if (i <= 0 || i === resourceId.length - 1) return null;
  const grantId = resourceId.slice(i + 1);
  return grantId.startsWith('cgr_') ? { itemId: resourceId.slice(0, i), grantId } : null;
}

/**
 * D3 — the link-only lane. A sharing resolver's `validate`/`load` (and a public
 * decision route) call this with the link's own tenant, org and resourceId: the
 * grant must be live for `action` on `target` (the D2 checks minus the user
 * binding), and must belong to the link's tenant and org. Every refusal is the
 * uniform 404. Revoking the grant darkens the link at its next use.
 */
export async function checkGrantLink(input: {
  tenantId: string; orgId: string; resourceId: string; action: GrantAction; target: { kind: string; id: string }; now?: Date;
}): Promise<GrantUse> {
  const ids = parseGrantLinkResourceId(input.resourceId);
  if (!ids || ids.itemId !== input.target.id) throw notFound();
  const use = await checkGrantUse({ grantId: ids.grantId, via: { link: true }, action: input.action, target: input.target, ...(input.now ? { now: input.now } : {}) });
  if (use.tenantId !== input.tenantId || use.orgId !== input.orgId) throw notFound();
  return use;
}

/** ADR 0958 P5 — a feature's rows that name a collaborator, deleted when its
 *  client org is torn down. Unlike an {@link CollaboratorEraseHook} nothing is
 *  kept: the org goes. A hook that throws stops the teardown with that record
 *  still in place, so a retry finds it. */
export type CollaboratorPurgeHook = (c: ExternalCollaborator) => Promise<number>;
const purgeHooks: CollaboratorPurgeHook[] = [];
export function registerCollaboratorPurgeHook(fn: CollaboratorPurgeHook): void {
  if (!purgeHooks.includes(fn)) purgeHooks.push(fn);
}

/** Org teardown: delete the org's collaborators matching `match` (default all),
 *  with the rows every {@link CollaboratorPurgeHook} owns, their grants and
 *  bound-index rows. Returns rows deleted. */
export async function purgeCollaboratorsForOrg(tenantId: string, orgId: string, match: (c: ExternalCollaborator) => boolean = () => true): Promise<number> {
  let n = 0;
  const allGrants = await listGrants(tenantId, orgId);
  for (const c of await listCollaborators(tenantId, orgId)) {
    if (!match(c)) continue;
    for (const hook of purgeHooks) n += await hook(c);
    for (const g of allGrants) if (g.collaboratorId === c.collaboratorId && await grants.delete(g.grantId)) n++;
    if (c.boundUserId) await boundIndex.delete(boundKey(c.boundUserId, c.collaboratorId));
    if (await collaborators.delete(c.collaboratorId)) n++;
  }
  return n;
}

// ── expiry notices (ADR 0958 D7 / P5) ──

/** How long before a grant ends its granter is told. */
export const EXPIRY_NOTICE_DAYS = 7;
const EXPIRY_NOTICE_TYPE = 'collab.grant-expiring';

/**
 * ADR 0958 D7 — tell the agency member who granted access that it ends within
 * {@link EXPIRY_NOTICE_DAYS} days. Expiry itself is decided per use; this only
 * informs, so a notice that fails is logged and never retried into a second one.
 *
 * Announced: an active grant not yet announced, ending in (now, now + 7 days],
 * granted by a person (not a `system:` actor such as the approval portal, whose
 * links last 7 days from the start, and not an erased one), whose collaborator
 * is active, whose owning feature is on, where collaboration itself is on
 * (`collaborationOn`, the tenant's external-collab toggle), whose client is
 * open and whose granter can still grant. The claim is a CAS on the grant before the emit.
 * The notice holds ids and dates only: no collaborator name or email, which
 * would outlive that person's erasure in the granter's inbox.
 */
export async function notifyExpiringGrants(
  now: Date = new Date(),
  /** The owning feature's own switch for collaboration in a tenant (campaign-ops
   *  passes its parent + sub-toggle check). Fails closed: absent, nothing is sent. */
  collaborationOn?: (tenantId: string) => Promise<boolean>,
): Promise<{ notified: number; failed: number }> {
  if (!collaborationOn) return { notified: 0, failed: 0 };
  const nowMs = now.getTime();
  const horizon = nowMs + EXPIRY_NOTICE_DAYS * DAY_MS;
  let notified = 0;
  let failed = 0;
  for (const g of await grants.list()) {
    const ends = Date.parse(g.expiresAt);
    if (g.status !== 'active' || g.expiryNoticeAt || !(ends > nowMs && ends <= horizon)) continue;
    if (!g.createdBy || g.createdBy.startsWith('system:') || g.createdBy === ERASED_ACTOR) continue;
    try {
      if (!(await collaborationOn(g.tenantId))) continue;
      const collaborator = await collaborators.get(g.collaboratorId);
      if (!collaborator || collaborator.tenantId !== g.tenantId || collaborator.orgId !== g.orgId || collaborator.status !== 'active') continue;
      const kind = kinds.get(g.resource.kind);
      if (!kind || !(await ownerOn(kind, g.tenantId)) || !(await orgOpen(g.tenantId, g.orgId))) continue;
      if (!(await peopleStillAllowed(g, collaborator))) continue;
      if (!(await grants.compareAndSwap(g, { ...g, expiryNoticeAt: now.toISOString() }))) continue;
      const days = Math.max(1, Math.ceil((ends - nowMs) / DAY_MS));
      await getNotificationEmitter().emit({
        tenantId: g.tenantId,
        recipientUserId: g.createdBy,
        type: EXPIRY_NOTICE_TYPE,
        priority: 'normal',
        title: `A collaborator's access ends in ${days} day${days === 1 ? '' : 's'}`,
        message: `Access you granted to a ${g.resource.kind} ends on ${g.expiresAt.slice(0, 10)}. Grant it again if the work is not done.`,
        actionUrl: '/campaign-ops',
        metadata: { kind: EXPIRY_NOTICE_TYPE, orgId: g.orgId, grantId: g.grantId, collaboratorId: g.collaboratorId, expiresAt: g.expiresAt },
      });
      notified += 1;
    } catch (err) {
      failed += 1;
      log.warn('extcollab_expiry_notice_failed', { grantId: g.grantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { notified, failed };
}

/**
 * ADR 0958 matrix row 10 — the kinds a member may grant in this client, with
 * the resources of each, for the Collaborators panel. Only kinds a member can
 * grant (never `systemMintOnly`), whose owning feature is on for the tenant, and
 * that list themselves. A kind whose list fails is left out and logged; the
 * panel still offers the others. No authority of its own: the route calls it
 * after the same `host:members:manage` check the grant route makes.
 */
export async function listGrantableResources(tenantId: string, orgId: string): Promise<Array<{ kind: string; actions: GrantAction[]; items: Array<{ id: string; title: string }> }>> {
  const out: Array<{ kind: string; actions: GrantAction[]; items: Array<{ id: string; title: string }> }> = [];
  for (const [kind, def] of [...kinds].sort(([a], [b]) => a.localeCompare(b))) {
    if (def.systemMintOnly || !def.list || !(await ownerOn(def, tenantId))) continue;
    try {
      out.push({ kind, actions: [...def.actions], items: await def.list(tenantId, orgId) });
    } catch (err) {
      log.warn('extcollab_grantable_list_failed', { kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** The kind registry, read-only (the collab router projects through it). */
export function grantResourceKind(kind: string): GrantResourceKind | undefined {
  return kinds.get(kind);
}

/**
 * ADR 0958 P2 — "Shared with me": every grant a signed-in person can use right
 * now, across agencies, read through the bound index (a bounded prefix read).
 * Each candidate passes the SAME per-use check as a direct request, so the list
 * never shows something the next click would refuse.
 */
export async function usableGrantsForUser(userId: string, now: Date = new Date()): Promise<GrantUse[]> {
  if (!userId) return [];
  const out: GrantUse[] = [];
  // One tenant-index read per agency, not one per binding.
  const byTenant = new Map<string, Promise<CollaboratorGrant[]>>();
  for (const idx of await boundIndex.listByPrefix(`${userId}::`)) {
    const c = await collaborators.get(idx.collaboratorId);
    if (!c || c.boundUserId !== userId) continue;
    let tenantGrants = byTenant.get(c.tenantId);
    if (!tenantGrants) { tenantGrants = grants.listForTenantIndexed(c.tenantId); byTenant.set(c.tenantId, tenantGrants); }
    const mine = (await tenantGrants)
      .filter((g) => g.tenantId === c.tenantId && g.orgId === c.orgId && g.collaboratorId === c.collaboratorId);
    for (const g of mine) {
      if (g.status !== 'active') continue;
      try {
        // Any one of its actions: a decide-only grant is listed too.
        out.push(await checkGrantUse({ grantId: g.grantId, via: { userId }, action: g.actions[0] ?? 'view', now }));
      } catch { /* not usable now: not listed */ }
    }
  }
  return out.sort((a, b) => a.grant.expiresAt.localeCompare(b.grant.expiresAt));
}

// ── audit review (ADR 0958 D7 / P5) ──

const AUDIT_DOMAIN = 'external-collaboration';
/** The chain entries a review reads per load: newest first, bounded. */
export const AUDIT_REVIEW_MAX_SCAN = 1_000;
export const AUDIT_REVIEW_LIMIT = 200;

/** One collaboration event as the agency reviews it: what the chain recorded,
 *  ids only (D7). Names are joined live by the caller, so an erased person
 *  reads as removed, and nothing personal is ever in the chain. */
export interface CollaborationAuditEvent {
  seq: number;
  at: string;
  action: string;
  collaboratorId?: string;
  grantId?: string;
  intakeId?: string;
  resource?: { kind: string; id: string };
  actions?: string[];
  files?: number;
  assets?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * ADR 0958 D7 — the audit review for one client: every collaboration event
 * (invite, accept, grants, suspend and revoke, files sent and decided) the
 * tenant's hash chain holds for `orgId`, newest first. It reads at most
 * {@link AUDIT_REVIEW_MAX_SCAN} chain entries; `truncated` says older ones
 * exist that this read did not reach (the export has the whole chain).
 */
export async function listCollaborationAudit(tenantId: string, orgId: string): Promise<{ events: CollaborationAuditEvent[]; truncated: boolean }> {
  const { entries, more } = await listChainTail(tenantId, AUDIT_REVIEW_MAX_SCAN);
  const events: CollaborationAuditEvent[] = [];
  for (const e of entries) {
    const p = e.payload;
    if (e.kind !== AUDIT_KIND_GOVERNANCE_DECISION || p.domain !== AUDIT_DOMAIN || p.orgId !== orgId) continue;
    const action = str(p.action);
    if (!action) continue;
    const r = p.resource as { kind?: unknown; id?: unknown } | undefined;
    events.push({
      seq: e.seq, at: e.at, action,
      ...(str(p.collaboratorId) ? { collaboratorId: str(p.collaboratorId) } : {}),
      ...(str(p.grantId) ? { grantId: str(p.grantId) } : {}),
      ...(str(p.intakeId) ? { intakeId: str(p.intakeId) } : {}),
      ...(r && str(r.kind) && str(r.id) ? { resource: { kind: str(r.kind)!, id: str(r.id)! } } : {}),
      ...(Array.isArray(p.actions) ? { actions: p.actions.filter((a): a is string => typeof a === 'string') } : {}),
      ...(typeof p.files === 'number' ? { files: p.files } : {}),
      ...(Array.isArray(p.assetIds) ? { assets: p.assetIds.length } : {}),
    });
    if (events.length >= AUDIT_REVIEW_LIMIT) return { events, truncated: true };
  }
  return { events, truncated: more };
}

// ── DSAR (ADR 0464) ──

/** ADR 0958 P5 — a feature's rows that name a collaborator, erased with it. A
 *  hook that throws stops that record's erasure (the DSAR reports the failure
 *  and is retried); the collaborator row is deleted only after every hook. */
export type CollaboratorEraseHook = (c: ExternalCollaborator) => Promise<number>;
const eraseHooks: CollaboratorEraseHook[] = [];
export function registerCollaboratorEraseHook(fn: CollaboratorEraseHook): void {
  if (!eraseHooks.includes(fn)) eraseHooks.push(fn);
}

/** Erase one collaborator record: the hooks' rows, then revoke its grants
 *  (kept as the agency's record of what was shared), its bound-index row and
 *  the record. Returns rows touched.
 *
 *  The home-tenant half reaches records in OTHER tenants, whose legal hold the
 *  DSAR's own hold check never saw. Under a hold in the record's tenant only
 *  access ends (grants revoked, binding dropped); the record and the hooks'
 *  rows are kept for the hold, and the skip is logged. */
async function eraseCollaboratorRecord(c: ExternalCollaborator): Promise<number> {
  let n = 0;
  const held = (await getRetentionHold(c.tenantId)) !== null;
  if (!held) for (const hook of eraseHooks) n += await hook(c);
  for (const g of await listGrants(c.tenantId, c.orgId, c.collaboratorId)) {
    if (g.status === 'active' && await grants.compareAndSwap(g, { ...g, status: 'revoked', revokedAt: nowIso(), revokedBy: 'system:erasure' })) n += 1;
  }
  if (c.boundUserId) await boundIndex.delete(boundKey(c.boundUserId, c.collaboratorId));
  if (held) {
    log.warn('collaborator_erasure_held', { tenantId: c.tenantId, collaboratorId: c.collaboratorId });
    return n;
  }
  if (await collaborators.delete(c.collaboratorId)) n += 1;
  return n;
}

/** The email forms of a DSAR key (normalised as stored), or none. */
function emailForms(forms: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const f of forms) {
    try { out.add(normalizeEmail(f.startsWith('email:') ? f.slice('email:'.length) : f)); } catch { /* not an email */ }
  }
  return out;
}

async function isHomeTenantOf(userId: string, tenantId: string): Promise<boolean> {
  if (!isSessionAuthorityRegistered()) return false;
  const state = await resolveSessionSubject(userId);
  return state?.homeTenantId !== undefined && state.homeTenantId === tenantId;
}

/**
 * A person erased in THEIR home tenant: delete every collaborator record bound to
 * them, in any agency, and revoke its grants. The binding is a canonical userId,
 * so the match is exact; it never matches a principal string across tenants.
 *
 * ADR 0958 P5 — the AGENCY's own erasure, keyed by email: a DSAR in the agency
 * tenant naming an email (directly, or resolved from a userId) erases that
 * agency's collaborator records for the email, accepted or not. It reads only
 * the agency's own rows (`tenantId`), so it is never a cross-tenant write.
 *
 * Either way a record goes through {@link eraseCollaboratorRecord}, which first
 * runs every registered {@link CollaboratorEraseHook} (the owning features'
 * rows that name the collaborator: intake, invite links), so a feature's
 * cleanup never depends on eraser order.
 */
export async function eraseExternalCollaboratorSubject(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!subjectKey) return { rowsTouched: 0 };
  let rowsTouched = 0;
  // The collaborator row lives in the AGENCY tenant while the person is erased in
  // their HOME tenant, so this reads the cross-agency bound index, a bounded
  // prefix per subject form. `subjectKey` is caller-supplied (a DSAR names any id),
  // so this half runs ONLY when `tenantId` IS that person's home tenant. Otherwise
  // any workspace admin could revoke a stranger's bindings in every agency: the
  // cross-tenant destructive escalation WF-TWIN-3 refused (`subjectErasure.ts`).
  // An unknown home tenant (no row, no session authority) erases nothing here.
  for (const form of subjectKeyForms(subjectKey).forms) {
    if (!(await isHomeTenantOf(form, tenantId))) continue;
    for (const idx of await boundIndex.listByPrefix(`${form}::`)) {
      const c = await collaborators.get(idx.collaboratorId);
      if (c && c.boundUserId === form) rowsTouched += await eraseCollaboratorRecord(c);
      await boundIndex.delete(idx.key);
    }
  }
  // ADR 0958 P5 — the agency's own records for an email (this tenant only).
  const emails = emailForms(subjectKeyForms(subjectKey).forms);
  if (emails.size > 0) {
    for (const c of await collaborators.listForTenantIndexed(tenantId)) {
      if (c.tenantId === tenantId && emails.has(c.email)) rowsTouched += await eraseCollaboratorRecord(c);
    }
  }
  // An erased AGENCY member (erased in this tenant): their id is tombstoned on the
  // rows they created or revoked. The rows are the agency's record of what was
  // shared and are kept. A tombstoned granter is absent, so the grant goes dark
  // (the per-use granter check), exactly as an erased publisher's share link does.
  const forms = new Set(subjectKeyForms(subjectKey).forms);
  for (const g of await grants.listForTenantIndexed(tenantId)) {
    if (g.tenantId !== tenantId || !(forms.has(g.createdBy) || (g.revokedBy !== undefined && forms.has(g.revokedBy)))) continue;
    const next: CollaboratorGrant = {
      ...g,
      ...(forms.has(g.createdBy) ? { createdBy: ERASED_ACTOR } : {}),
      ...(g.revokedBy !== undefined && forms.has(g.revokedBy) ? { revokedBy: ERASED_ACTOR } : {}),
    };
    if (await grants.compareAndSwap(g, next)) rowsTouched += 1;
  }
  for (const c of await collaborators.listForTenantIndexed(tenantId)) {
    if (c.tenantId !== tenantId || !forms.has(c.createdBy)) continue;
    if (await collaborators.compareAndSwap(c, { ...c, createdBy: ERASED_ACTOR })) rowsTouched += 1;
  }
  return { rowsTouched };
}
registerSubjectEraser(eraseExternalCollaboratorSubject);
