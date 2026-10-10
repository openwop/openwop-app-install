/**
 * ADR 0795 D1 — a DELEGATED subject is not a member to look up and not an
 * unknown stranger.
 *
 * An `owk_` key authenticates as `apikey:<keyId>`. That id never matches a
 * member row, so every authority resolver that was handed it answered either
 * "nothing" or — in demo mode, on a single-principal tenant — OWNER. Neither is
 * what a key is: it is some of what its ISSUER holds, limited to what it
 * DECLARED. This module is the seam that lets the feature-free resolvers in
 * `accessControlService.ts` read a delegation without importing the feature
 * that stores keys (`features/developer-keys` registers the lookup).
 *
 * Fail-closed by construction: no registered lookup, an unknown id, a revoked
 * or expired key, or a key whose issuer is itself a key all resolve to `null`,
 * which every caller reads as "no authority".
 */
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';

const log = createLogger('host.delegatedSubject');

/** The subject prefix an `owk_` key authenticates under (`middleware/auth.ts`). */
export const DELEGATED_SUBJECT_PREFIX = 'apikey:';

export interface Delegation {
  /** The key id, without the subject prefix. */
  id: string;
  /** The canonical subject of whoever issued the key. */
  issuer: string;
  /** The one tenant the key is valid in. */
  tenantId: string;
  /** What the key declared. Empty (or `*`) means undeclared: the issuer's own. */
  declaredScopes: readonly string[];
}

export type DelegationLookup = (id: string) => Promise<Delegation | null>;

let lookup: DelegationLookup | undefined;

/** Registered once, by the feature that owns the key store. */
export function registerDelegationLookup(fn: DelegationLookup): void {
  lookup = fn;
}

export function isDelegatedSubject(subject: string | undefined): subject is string {
  return typeof subject === 'string' && subject.startsWith(DELEGATED_SUBJECT_PREFIX);
}

/**
 * The live delegation behind a delegated subject, or `null`. A key issued BY a
 * key (possible before ADR 0800) is refused here: its issuer is not a person,
 * and following the chain would let authority be laundered through it.
 */
export async function delegationOf(subject: string): Promise<Delegation | null> {
  if (!isDelegatedSubject(subject) || !lookup) return null;
  try {
    const d = await lookup(subject.slice(DELEGATED_SUBJECT_PREFIX.length));
    if (!d || isDelegatedSubject(d.issuer)) return null;
    return d;
  } catch (err) {
    log.error('delegation lookup failed — failing closed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * ADR 0845 D5 — the identity separation of duties compares. A delegated subject
 * (`apikey:` / developer key) acts for its ISSUER, so submitting by session and
 * approving with your own key is still you. A delegation that cannot be resolved
 * (or belongs to another tenant) returns null: the caller treats null as "could be
 * the submitter" — fail closed. Lifted here from the strategy feature by ADR 0859
 * D4: the CMS approval gate asks the same question, and two copies would drift.
 */
export async function canonicalDecider(tenantId: string, subject: string): Promise<string | null> {
  if (!isDelegatedSubject(subject)) return subject;
  const d = await delegationOf(subject);
  return d && d.tenantId === tenantId ? d.issuer : null;
}

/**
 * ADR 0795 D6 — a subject has just lost its LAST membership in a tenant. The
 * feature that stores delegations registers what must stop with it. Best-effort
 * by design: D1 already re-reads the issuer on every check, so a handler that
 * fails leaves a key that resolves to nothing, not a live one.
 */
export type IssuerRemovedHandler = (tenantId: string, subject: string) => Promise<void>;
const issuerRemovedHandlers: IssuerRemovedHandler[] = [];

export function registerIssuerRemovedHandler(fn: IssuerRemovedHandler): void {
  if (!issuerRemovedHandlers.includes(fn)) issuerRemovedHandlers.push(fn);
}

export async function notifyIssuerRemoved(tenantId: string, subject: string): Promise<void> {
  for (const fn of issuerRemovedHandlers) {
    try {
      await fn(tenantId, subject);
    } catch (err) {
      log.error('issuer-removed handler failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * ADR 0833 D7 — a durable ACCOUNT was deleted. Everything it delegated must
 * stop in EVERY tenant, not only the one whose admin deleted it: its `owk_`
 * keys in other shared workspaces kept authenticating, because issuer liveness
 * reads a missing row as "a seed actor" (S8), and the deterministic `userIdFor`
 * re-creates the same id on re-provisioning, so no "deleted" marker could hold
 * (review B4) — the delegations themselves are revoked.
 *
 * WHICH delegations (grade-code `USERS2-CD-1`): the durable `userId` is
 * `hash(homeTenant:principalId)`, unforgeable from another tenant, so it is
 * matched in EVERY tenant. The bare `principalId` (`oidc:<sub>`, `saml:<nameId>`,
 * `scim:<userName>`) is NOT issuer- or tenant-qualified — the same string can
 * be a different human elsewhere (the ADR 0780 D2 lesson) and a caller can mint
 * a row carrying another person's principal — so it is matched ONLY inside the
 * account's home tenant. Handlers MUST use {@link erasedSubjectIssued}.
 *
 * FAIL-CLOSED, unlike the two best-effort seams beside it: the users DELETE
 * lane calls this BEFORE deleting the row and refuses (retryably) on any
 * handler failure, so an account is never deleted with a live key left behind.
 */
export interface ErasedSubject { userId: string; principalId: string; homeTenant: string }
export type SubjectErasedHandler = (subject: ErasedSubject) => Promise<void>;

/** Did the erased account issue a delegation recorded as `issuer` in `tenantId`? */
export function erasedSubjectIssued(subject: ErasedSubject, issuer: string | undefined, tenantId: string | undefined): boolean {
  if (!issuer) return false;
  if (issuer === subject.userId) return true;
  return issuer === subject.principalId && tenantId === subject.homeTenant;
}
const subjectErasedHandlers: SubjectErasedHandler[] = [];

export function registerSubjectErasedHandler(fn: SubjectErasedHandler): void {
  if (!subjectErasedHandlers.includes(fn)) subjectErasedHandlers.push(fn);
}

/** Runs every handler; throws (after running all) when any failed. */
export async function notifySubjectErased(subject: ErasedSubject): Promise<void> {
  const failed: string[] = [];
  for (const fn of subjectErasedHandlers) {
    try {
      await fn(subject);
    } catch (err) {
      failed.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failed.length > 0) {
    throw new OpenwopError('internal_error', `Revoking the account's delegations failed (${failed.length}); the account was NOT deleted — retry.`, 500, { failed: failed.length });
  }
}

/**
 * ADR 0795 D6 — a subject was rekeyed (an unbound `oidc:<sub>` bound to its
 * canonical `user:<id>`). A delegation recorded under the old spelling must
 * move with it, or the key's issuer stops resolving to the person it is.
 */
export type SubjectRekeyedHandler = (fromSubject: string, toSubject: string, scope: { tenantId?: string }) => Promise<void>;
const subjectRekeyedHandlers: SubjectRekeyedHandler[] = [];

export function registerSubjectRekeyedHandler(fn: SubjectRekeyedHandler): void {
  if (!subjectRekeyedHandlers.includes(fn)) subjectRekeyedHandlers.push(fn);
}

export async function notifySubjectRekeyed(fromSubject: string, toSubject: string, scope: { tenantId?: string } = {}): Promise<void> {
  for (const fn of subjectRekeyedHandlers) {
    try {
      await fn(fromSubject, toSubject, scope);
    } catch (err) {
      log.error('subject-rekeyed handler failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * An operator env key's subject is `bearer:<first 8 chars>`. A delegation it
 * issued is the tenant's own only while that key is still CONFIGURED: rotate or
 * remove it and what it minted must not stay owner. The auth middleware, which
 * owns the key map, registers the check. Unregistered ⇒ not configured.
 */
export type OperatorIssuerCheck = (issuer: string, tenantId?: string) => boolean;
let operatorIssuerCheck: OperatorIssuerCheck | undefined;

export function registerOperatorIssuerCheck(fn: OperatorIssuerCheck): void {
  operatorIssuerCheck = fn;
}

export function isConfiguredOperatorIssuer(issuer: string): boolean {
  return issuer.startsWith('bearer:') && operatorIssuerCheck !== undefined && operatorIssuerCheck(issuer);
}

/**
 * ADR 0822 D1 (grade-code WFAC-17) — the same question, BOUND to a tenant: is a
 * key with this prefix still configured FOR `tenantId` (or for every tenant,
 * `*`)? A run actor stamped `bearer:<8>` has no delegation row to tie it to a
 * tenant (the ADR 0795 readers get that tie from `d.tenantId`), so the bare
 * check above would answer "the tenant's own principal" in ANY tenant — a key
 * bound to A would be owner in B. Use this wherever the actor is read off a run.
 */
export function isConfiguredOperatorIssuerFor(issuer: string, tenantId: string): boolean {
  return issuer.startsWith('bearer:') && operatorIssuerCheck !== undefined && operatorIssuerCheck(issuer, tenantId);
}

/**
 * ADR 0745 D2 / ADR 0755 D2 — does a key's DECLARED delegation permit `scope`?
 * The ONE reading, shared by every lane. Empty means UNDECLARED, i.e. the
 * issuer's own authority; a declared `'*'` is read the same way.
 */
export function keyDeclarationPermits(declared: readonly string[], scope: string): boolean {
  return declared.length === 0 || declared.includes('*') || declared.includes(scope);
}

/** True when the declaration narrows at all (it names scopes and none is `*`). */
export function isNarrowingDeclaration(declared: readonly string[]): boolean {
  return declared.length > 0 && !declared.includes('*');
}

/**
 * The three ADR 0795 enforcement switches. Each defaults to `enforce`: a fresh
 * install is secure. A deployment that must measure first sets `report`, which
 * logs what WOULD change and changes nothing. `off` is the pre-ADR behaviour.
 */
export type KeyPolicyMode = 'off' | 'report' | 'enforce';
export type KeyPolicySwitch = 'OPENWOP_KEY_AUTHORITY' | 'OPENWOP_KEY_VENDOR_GATE' | 'OPENWOP_KEY_QUERY_PARAM';

export function keyPolicyMode(name: KeyPolicySwitch): KeyPolicyMode {
  const raw = process.env[name];
  return raw === 'off' || raw === 'report' ? raw : 'enforce';
}

const reported = new Set<string>();

/** One line per distinct (kind, key, detail) per process: a report, not a flood. */
export function reportKeyPolicy(kind: string, keyId: string, detail: Record<string, unknown>): void {
  const sig = `${kind}|${keyId}|${JSON.stringify(detail)}`;
  if (reported.has(sig)) return;
  if (reported.size > 5000) reported.clear();
  reported.add(sig);
  log.warn('key_policy_would_change', { kind, keyId, ...detail });
}

/**
 * The one way an `OPENWOP_KEY_AUTHORITY` rule acts: `enforce` refuses, `report`
 * logs what it would have refused and allows, `off` allows.
 */
export function keyAuthorityRefuses(kind: string, keyId: string, detail: Record<string, unknown> = {}): boolean {
  const mode = keyPolicyMode('OPENWOP_KEY_AUTHORITY');
  if (mode === 'enforce') return true;
  if (mode === 'report') reportKeyPolicy(kind, keyId, detail);
  return false;
}
