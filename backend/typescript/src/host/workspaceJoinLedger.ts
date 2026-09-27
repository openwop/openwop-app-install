/**
 * ADR 0684 §7 phase 2 — auto-join on first sign-in, gated on the ACTION.
 *
 * TWO QUESTIONS THIS CODE REFUSES TO CONFLATE:
 *
 *   - has the auto-join action run for this subject?  (durable, about the PAST)
 *   - is this subject currently a member?             (mutable, about the PRESENT)
 *
 * Auto-join fires iff the join RECORD is absent — never iff the subject is a
 * non-member. Gating on membership would make an operator's removal mean
 * "removed until they next sign in", and nothing anywhere would report it.
 *
 * WHY THAT IS A SAFETY PROPERTY AND NOT TIDINESS. Ask why an operator removes
 * someone from the DEFAULT PARTICIPANT workspace — the one workspace everybody is
 * in. It is not org hygiene; it is abuse, spam, a banned account. Under that
 * reading, "a removed user auto-rejoins next morning with no error" is not an
 * awkward edge case: it is a banned participant silently walking back in. This is
 * the ban path, which is why it outranks the loud failure modes — those cost a
 * debugging session, this is a control that quietly does not hold.
 *
 * REMOVAL IS DURABLE; RE-ADD IS EXPLICIT. An operator putting someone back is a
 * deliberate `createMember`. Auto-join never fires again because the record
 * persists. To let auto re-apply, clear the record — a separate, deliberate act.
 *
 * THE LEDGER INHERITS ADR 0684 §6 VERBATIM. It has the same cardinality as
 * membership — every user who ever signed in — so it is POINT-READ by
 * `(subject, workspaceId)` ONLY, never scanned or counted. A "how many have we
 * onboarded" surface reads a counter; `list()` here is a full-tenant scan and
 * would make the mechanism added to bound one scan into another.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { createMember } from './accessControlService.js';
import { setActiveWorkspace } from './activeWorkspacePref.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { resolveOne } from './featureToggles/service.js';

const log = createLogger('host.workspaceJoinLedger');

export interface WorkspaceJoinRecord {
  /** `${subject}::${workspaceId}` — the ACTION's idempotency key. */
  id: string;
  tenantId: string;
  subject: string;
  workspaceId: string;
  orgId: string;
  joinedAt: string;
}

const joins = new DurableCollection<WorkspaceJoinRecord>(
  'workspace-join:record', (r: WorkspaceJoinRecord) => r.id, undefined, (r: WorkspaceJoinRecord) => r.tenantId,
);

const keyFor = (subject: string, workspaceId: string): string => `${subject}::${workspaceId}`;

/** Point read. Never scan this collection — see the header. */
export async function hasJoined(subject: string, workspaceId: string): Promise<boolean> {
  return (await joins.get(keyFor(subject, workspaceId))) !== null;
}

/**
 * Claim the join for this `(subject, workspaceId)`. Returns true iff THIS caller
 * won — the record's existence is the lock, so two concurrent first sign-ins
 * cannot both proceed to `createMember`.
 *
 * > **CORRECTED 2026-09-15 — the sentence above was a CLAIM this function did
 * > not honour.** It was written as:
 * >
 * > ```
 * > if (await joins.get(id)) return false;   // READ
 * > await joins.put({ ... });                // WRITE — an await in between
 * > return true;
 * > ```
 * >
 * > which is a read-check-write, not a lock. Two concurrent binds both read
 * > null, both write, and both are told they won — so both proceed to
 * > `createMember` and `setActiveWorkspace`. Auto-join runs on EVERY bind, so
 * > the window is a real request path, not a theoretical one.
 * >
 * > **The duplicate is invisible in the stored state**, which is why it could
 * > sit here behind a confident comment: both writers target the same key, so
 * > afterwards there is exactly ONE join record and the row count looks
 * > correct. Only the side effects downstream of the returned boolean are
 * > doubled. A test asserting "one join record exists" passes against the
 * > broken version — the assertion has to count what each IDENTITY did.
 * >
 * > Now a single atomic insert-if-absent (`putIfAbsent` → `kvCompareAndSwap`
 * > with `expect: null`), correct across instances rather than within one.
 * >
 * > **Scope, stated honestly:** this was found while investigating two join
 * > records logged a millisecond apart in kicktodo production. It is a genuine
 * > defect on its own merits and is fixed as one. Whether it EXPLAINS that pair
 * > is undetermined — two writers on the same key produce one record, so the
 * > observed pair is either two different subjects (no defect) or two log lines
 * > from one doubled claim. That needs the `subject` field off those rows, which
 * > this host cannot reach.
 */
export async function claimJoin(input: {
  subject: string; workspaceId: string; orgId: string;
}): Promise<boolean> {
  return joins.putIfAbsent({
    id: keyFor(input.subject, input.workspaceId),
    tenantId: input.workspaceId, subject: input.subject,
    workspaceId: input.workspaceId, orgId: input.orgId, joinedAt: new Date().toISOString(),
  });
}

export interface DefaultWorkspaceTarget { featureId: string; orgId: string; tenantId: string; name: string }

/**
 * The declared targets, recorded at boot.
 *
 * WHY NOT `featureDefaultOrgs()` AT THE CALL SITE: the caller is
 * `features/users/authRoutes.ts`, and importing `features/index.js` from inside a
 * feature is a CYCLE — the registry imports every feature, including that one. It
 * type-checked and then 500'd two auth routes at runtime. A feature must not
 * import the feature registry; boot pushes the declarations down here instead,
 * the same direction `ensureFeatureDefaultOrgs` already receives them.
 */
let declaredTargets: readonly DefaultWorkspaceTarget[] = [];

/** Called once at boot, beside `ensureFeatureDefaultOrgs`. */
export function setDefaultWorkspaceTargets(targets: readonly DefaultWorkspaceTarget[]): void {
  declaredTargets = targets;
}

/** ADR 0690 — the declared defaults, for a readiness report that checks each is
 *  provisioned AND enterable (a workspace root) on this deployment. Read-only. */
export function declaredDefaultWorkspaceTargets(): readonly DefaultWorkspaceTarget[] {
  return declaredTargets;
}

/**
 * Join `subject` into every declared default workspace it has not already been
 * joined into. Idempotent, and safe to call on every bind.
 *
 * NEVER THROWS. A failure to auto-join must not fail a sign-in — the user is
 * authenticated either way, and a participant who lands without a workspace sees
 * an empty catalog rather than a broken login. Logged, not raised.
 */
export async function autoJoinDefaultWorkspaces(
  subject: string, displayName: string,
  personalTenant?: string,
  targets: readonly DefaultWorkspaceTarget[] = declaredTargets,
): Promise<number> {
  let joined = 0;
  for (const t of targets) {
    try {
      // TOGGLE-GATED HERE, AND *ONLY* HERE — the two gates sit at different
      // lifecycle stages and only one of them can see a tenant:
      //
      //   BOOT      provision the org/workspace. No request, no tenant, so the
      //             per-tenant toggle is UNASKABLE. Gated on the declaration
      //             (what the build ships) + OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS.
      //   SIGN-IN   join the user. A request exists, so the toggle IS askable —
      //             and must be asked. A user for whom the feature is off must
      //             not be swept into its workspace, even though the org was
      //             provisioned at boot.
      //
      // Reading "the default exists iff the toggle is on" as ONE check is wrong
      // at exactly one of those sites, which is why it is spelled out at both.
      // (Distinction from kicktodo-1; my first implementation joined everyone.)
      // An unresolvable toggle fails CLOSED: no sweep.
      const gate = personalTenant
        ? await resolveOne(t.featureId, { tenantId: personalTenant, userId: subject, tier: 'user' }).catch(() => null)
        : null;
      if (!gate?.enabled) continue;
      if (await hasJoined(subject, t.tenantId)) continue;
      if (!(await claimJoin({ subject, workspaceId: t.tenantId, orgId: t.orgId }))) continue;
      // NO MEMBERSHIP CHECK HERE, deliberately. The first draft read
      // `listMembers(tenant, org)` to avoid a duplicate row if an operator had
      // already added the subject — which is a FULL SCAN of the default
      // workspace's members, i.e. everyone who ever signed in. That is precisely
      // what ADR 0684 §6 forbids, written into the mechanism §6 exists to
      // protect. The action-gate above already guarantees this runs once per
      // (subject, workspace); a duplicate row is possible only when an operator
      // added someone manually AND no ledger record exists, and one extra row is
      // a far smaller cost than an unbounded scan on a sign-in path.
      await createMember({ orgId: t.orgId, tenantId: t.tenantId, displayName, subject });
      await setActiveWorkspace(subject, t.tenantId);
      joined += 1;
      log.info('workspace_auto_joined', { featureId: t.featureId, orgId: t.orgId, workspaceId: t.tenantId });
    } catch (err) {
      log.warn('workspace_auto_join_failed', {
        featureId: t.featureId, orgId: t.orgId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return joined;
}

/**
 * ADR 0464 — subject erasure. Caught by `subject-erasure-coverage.test.ts`, which
 * refuses an unclassified subject-bearing store and says "do NOT just exempt".
 * It was right: this ledger is keyed by subject, so a DSAR that left it behind
 * would leave a record of where that person had been.
 *
 * THE TENSION THIS CREATES, AND WHY IT RESOLVES THE WAY IT DOES. §7 wants the
 * record durable so a removed participant is never silently re-joined. Erasure
 * wants it gone. If erasure wins, a removed user who then requests erasure would
 * be auto-joined again on next sign-in — a DSAR as a ban-evasion path.
 *
 * Erasure still wins, because membership removal is NOT the ban control. The
 * account-level disable is: `authRoutes.ts` refuses a non-active account with a
 * 403 BEFORE auto-join runs, and that refusal is unaffected by anything erased
 * here. §7's ledger protects the ordinary case — an operator tidying a roster —
 * while a genuine ban is enforced one layer up, where a data-subject right
 * cannot reach it. An operator who bans by removing membership alone has always
 * had a weaker control than they thought; that is worth knowing rather than
 * papering over with an exemption.
 */
async function eraseSubjectWorkspaceJoins(tenantId: string, subjectKey: string): Promise<void> {
  // Point-addressed: the ledger key is `${subject}::${workspaceId}` and the row's
  // tenant IS the workspace, so the record for (subject, this workspace) is a
  // direct get/delete. No scan — ADR 0684 §6.
  const id = keyFor(subjectKey, tenantId);
  if (await joins.get(id)) await joins.delete(id);
}

/** Register the join-ledger DSAR eraser (idempotent — the seam dedupes by reference). */
export function registerWorkspaceJoinErasure(): void {
  registerSubjectEraser(eraseSubjectWorkspaceJoins);
}
