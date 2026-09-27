/**
 * Subject-link deny store — RFC 0159 (SCIM ⟷ SAML subject linking / the combined
 * leaver contract), ADR 0613.
 *
 * THE PROBLEM. The durable User key is `userIdFor(tenant, principalId)` — a
 * SAML login is principal `saml:<NameID>`, a SCIM user is `scim:<userName>`, so
 * they are STRUCTURALLY DIFFERENT Users. A leaver deactivated via SCIM
 * (`scim:<userName>` disabled) can therefore still SSO in via SAML
 * (`saml:<NameID>` still active). RFC 0159 closes that gap.
 *
 * LINK, NOT MERGE. This module does NOT rewrite `userIdFor` or coalesce the two
 * durable Users — merging would break `:fork` replay + RFC 0048 §D owner-echo.
 * Instead it maintains a same-tenant subject LINK keyed on an OPAQUE, IdP-stable
 * id (the SCIM `externalId`, equal to the persistent SAML `NameID`): when a SCIM
 * deactivation fires, the linked opaque subject is DENIED, and the SAML decision
 * path (both the pre-auth `auth/saml/validate` seam and the production ACS)
 * consults this store and refuses to authenticate / mint a session.
 *
 * The row key is DETERMINISTIC (`${tenantId}:${externalId}`, no randomUUID), so
 * writes are idempotent and replay-safe — a re-run finds the same row. The store
 * is a `DurableCollection` in its own `hostext:` namespace (a `tenantOf` index so
 * tenant teardown reclaims it), consistent with every other host-ext durable
 * surface.
 *
 * TENANT KEYING (see ADR 0613 §"Tenant resolution"). The store is a generic
 * `(tenantId, externalId)` map; the CALLER decides the tenant:
 *   - the SCIM lifecycle (`scimProvisioningService`) writes/clears keyed on the
 *     deactivated USER's own tenant + externalId — covering the real `/scim/v2`
 *     lane (the user lives under `OPENWOP_SCIM_TENANT` there);
 *   - the pre-auth `auth/saml/validate` seam consults the deterministic
 *     `OPENWOP_SCIM_TENANT` realm (it has no session);
 *   - the production ACS consults its SAML deployment tenant
 *     (`OPENWOP_SAML_TENANT`). For the contract to fire in production the operator
 *     MUST align `OPENWOP_SAML_TENANT == OPENWOP_SCIM_TENANT` — that alignment IS
 *     the RFC 0159 "same-tenant link" requirement made concrete.
 *
 * @see ../../../docs/adr/0613-rfc-0159-scim-saml-subject-linking.md
 * @see ../openwop/RFCS/0159-scim-saml-subject-linking.md
 * @see spec/v1/auth-profiles.md §"Subject linking (SAML ⟷ SCIM)"
 */

import { DurableCollection } from '../hostExtPersistence.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../subjectErasure.js';
import { subjectKeyForms } from '../subjectErasureRedaction.js';
import { samlSettings, samlConfigured } from './samlSso.js';

/** The deterministic realm every SCIM lane keys the deny on
 *  (`OPENWOP_SCIM_TENANT`, default `scim`) — ONE definition, shared by the
 *  routes, the discovery advert and the boot check. */
export function scimLinkRealm(): string {
  return process.env.OPENWOP_SCIM_TENANT ?? 'scim';
}

/**
 * USERS-13 (ADR 0613 § Tenant resolution, made a CODE guard). The production
 * SAML ACS consults the deny store under ITS deployment tenant
 * (`OPENWOP_SAML_TENANT`), while every SCIM lane writes under `scimLinkRealm()`.
 * The RFC 0159 "same-tenant link" only exists when those two are EQUAL; under
 * the DEFAULT config (`default` vs `scim`) they are not, and a `subjectLinking:
 * true` advert would be a wire claim the ACS can never honour. This returns the
 * facts the advert and the boot log decide on:
 *   - `samlRealm` is `null` when no production SAML SP is configured — then the
 *     only SAML lane is the conformance validate seam, which consults
 *     `scimLinkRealm()` itself, so the link is consistent by construction;
 *   - `aligned` is false ONLY for a configured production SP whose tenant differs.
 */
export function subjectLinkRealmAlignment(): { aligned: boolean; scimRealm: string; samlRealm: string | null } {
  const scimRealm = scimLinkRealm();
  const samlRealm = samlSettings()?.tenantId ?? null;
  return { aligned: samlRealm === null || samlRealm === scimRealm, scimRealm, samlRealm };
}

/**
 * Whether this deployment WOULD advertise `openwop-auth-saml`. Mirrors the
 * discovery build (`OPENWOP_TEST_SAML_IDP_URL` conformance seam OR a real SAML SP
 * via `OPENWOP_SAML_*`), lifted here so the RFC 0164 combined-contract predicate
 * and the discovery advert read the SAME source (they cannot disagree).
 */
export function samlProfileAdvertised(): boolean {
  return Boolean(process.env.OPENWOP_TEST_SAML_IDP_URL) || samlConfigured();
}

/** Whether this deployment WOULD advertise `openwop-auth-scim` (the real
 *  bearer-authed endpoints OR the conformance seam). Discovery-mirroring, per
 *  `samlProfileAdvertised()`. */
export function scimProfileAdvertised(): boolean {
  return Boolean(process.env.OPENWOP_SCIM_BEARER || process.env.OPENWOP_TEST_SCIM_URL);
}

/**
 * RFC 0164 §A.2 / RFC 0163 §B — whether a SHARED TRUST ROOT is configurable for
 * the SCIM lane, a precondition of the combined leaver contract. True in BOTH
 * deployment shapes:
 *   - production: `OPENWOP_SCIM_IDP_ENTITY_ID` binds the real `/scim/v2` lane's
 *     IdP entityID (the per-record `idpEntityId` is the finer-grained form);
 *   - conformance seam: `OPENWOP_TEST_SCIM_URL` is set — the seam supplies an
 *     `idpUrl` per provision, so each record's trust root is bindable.
 * When neither is present, no assertion can be bound to the SCIM lane's IdP, so
 * the combined contract cannot be honoured for the deployment as a whole.
 */
export function scimTrustRootConfigured(): boolean {
  return Boolean(process.env.OPENWOP_SCIM_IDP_ENTITY_ID || process.env.OPENWOP_TEST_SCIM_URL);
}

/**
 * RFC 0164 (ADR 0623) — the ONE predicate that decides whether the SCIM⟷SAML
 * combined leaver contract is in force for this deployment. It is true iff the
 * host advertises BOTH profiles AND can honour the contract as a whole: realms
 * aligned AND a shared trust root configurable. This is the SAME condition
 * `advertisedAuthProfiles()` uses to decide whether to DROP `openwop-auth-scim`,
 * so the advertised posture and the runtime SAML-lane enforcement can never
 * disagree — advertise both ⟺ enforce fail-closed on an unlinkable subject.
 *
 * When this is false the host advertises AT MOST one of the two profiles, and
 * RFC 0163's `unbound` deny-only carve-out survives on the SAML lane (a
 * single-profile or pre-0164 deployment is unaffected).
 */
export function combinedSubjectLinkingActive(): boolean {
  return (
    samlProfileAdvertised() &&
    scimProfileAdvertised() &&
    scimTrustRootConfigured() &&
    subjectLinkRealmAlignment().aligned
  );
}

/**
 * RFC 0163 §A — the CLASS of opaque, IdP-stable, non-PII identifier this host
 * joins the SAML and SCIM lanes on. openwop-app links on the SCIM `externalId`
 * matched to the persistent-format SAML `NameID` (RFC 0159 §A.1 default pairing),
 * which IS the `opaque-idp` class. Advertised in `capabilities.auth.subjectLinkKey`
 * (discovery.ts) DERIVED from this one const — the enum member and the class the
 * host actually honours are the same symbol, so advertise and behaviour cannot
 * drift (RFC 0163 §A.2 "advertise only the class you honour"). A member of the
 * closed enum `{opaque-idp, configured-immutable}`; mutable/PII keys are
 * inexpressible by construction (§A.3).
 */
export const SUBJECT_LINK_KEY = 'opaque-idp' as const;

/** A cross-lane deny for one opaque IdP-stable subject in one tenant. */
export interface LinkDenyRow {
  tenantId: string;
  /** The opaque IdP-stable subject id: SCIM `externalId` == persistent SAML `NameID`. */
  externalId: string;
  /** ISO timestamp the SCIM deactivation wrote the deny (observability only). */
  deactivatedAt: string;
}

/** Deterministic row key — idempotent + replay-safe (no randomUUID). */
function denyKey(tenantId: string, externalId: string): string {
  return `${tenantId}:${externalId}`;
}

const store = new DurableCollection<LinkDenyRow>(
  'auth:subjectLinkDeny',
  (r) => denyKey(r.tenantId, r.externalId),
  // Runtime validator: reject a schema-drifted row rather than trusting `as T`.
  (parsed): LinkDenyRow | null => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    return typeof p.tenantId === 'string' && typeof p.externalId === 'string' && typeof p.deactivatedAt === 'string'
      ? { tenantId: p.tenantId, externalId: p.externalId, deactivatedAt: p.deactivatedAt }
      : null;
  },
  // tenantOf ⇒ a `hostextidx:` marker so tenant teardown reclaims these rows.
  (r) => r.tenantId,
);

/**
 * Record that an opaque subject has been SCIM-deactivated in `tenantId` — the
 * SAML lane will now fail-close it. Idempotent. Fail-closed on a falsy input: a
 * malformed key is never written (it would mint a bogus row that could shadow a
 * real subject or strand a tenant marker).
 */
export async function denyLinkedSubject(tenantId: string, externalId: string): Promise<void> {
  if (!tenantId || !externalId) return;
  await store.put({ tenantId, externalId, deactivatedAt: new Date().toISOString() });
}

/**
 * Is this opaque subject denied in `tenantId`? A point read of the deterministic
 * key — never a scan. Throws on a storage read error so the SECURITY caller can
 * fail CLOSED (RFC 0159 §A.4): the SAML decision paths wrap this call and deny
 * when it throws, rather than letting a store outage authenticate a leaver.
 */
export async function isLinkedSubjectDenied(tenantId: string, externalId: string): Promise<boolean> {
  if (!tenantId || !externalId) return false;
  const row = await store.get(denyKey(tenantId, externalId));
  return row !== null;
}

/**
 * Clear a subject's deny (re-hire / reactivation). Idempotent — clearing an
 * absent row is a no-op.
 */
export async function clearLinkedSubjectDeny(tenantId: string, externalId: string): Promise<void> {
  if (!tenantId || !externalId) return;
  await store.delete(denyKey(tenantId, externalId));
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
/**
 * ADR 0464 §2.1 — DSAR subject-eraser for the subject-link deny store.
 *
 * The deny row IS the subject: its key is the OPAQUE `externalId` (== the
 * persistent SAML `NameID`, RFC 0159). DELETE, not redact — the row holds only
 * that identifier plus a timestamp; a lingering row is fail-SAFE (it only ever
 * DENIES, never grants) but is still a subject identifier, so erasure removes it.
 *
 * A DSAR key may arrive bare (the externalId itself) or auth-principal-scoped
 * (`saml:<NameID>` / `scim:<userName>`). `subjectKeyForms` reaches the bare form;
 * a `saml:`/`scim:` strip reaches the row via RFC 0159's externalId==NameID
 * equality. A key from a different identity space matches nothing (a harmless
 * no-op — the ADR 0464 eraser contract). Idempotent; tenant-scoped via
 * `listByPrefix` (never a cross-tenant scan). Called from the host-erasers boot
 * step (host/hostSubjectErasers.ts).
 */
export async function eraseSubjectLinkDeny(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const { forms } = subjectKeyForms(subjectKey);
  const stripped = subjectKey.replace(/^(?:saml|scim):/, '');
  let rowsTouched = 0;
  for (const row of await store.listByPrefix(`${tenantId}:`)) {
    if (forms.has(row.externalId) || row.externalId === stripped) {
      await store.delete(denyKey(row.tenantId, row.externalId));
      rowsTouched++;
    }
  }
  return { rowsTouched };
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerSubjectLinkErasure(): void {
  registerSubjectEraser(eraseSubjectLinkDeny);
}

/** Test-only: drop every deny row. */
export async function __resetSubjectLinkStore(): Promise<void> {
  await store.__clear();
}
