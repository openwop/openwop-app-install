/**
 * Pure helpers + constants for the Orgs admin page, extracted verbatim from
 * OrgsPage so the container stays a thin shell. No React/state dependencies —
 * just set toggling and the built-in role catalog.
 */

import type { AccessRole, BuiltInRoleId, CustomRole, Group, OrgMember } from '../client/accessClient.js';
import { readErrorDetail } from '../client/errorEnvelope.js';

/**
 * Roles, teams, and scopes are non-status LABEL dimensions, so per
 * DESIGN.md §5.3/§5.4 they differentiate by their text label — never by a
 * functional/accent color (those are reserved for run/agent/node status +
 * severity). Every such chip is the one neutral pill (`NEUTRAL_CHIP`, see
 * orgUi.ts); selected/unselected in a toggle is shown by opacity, not color.
 */
const ALL_ROLES: BuiltInRoleId[] = ['viewer', 'editor', 'admin', 'owner'];

export const toggleStr = (set: Set<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export const isBuiltIn = (id: string): id is BuiltInRoleId => (ALL_ROLES as string[]).includes(id);

// ── Role catalog helpers (built-in + custom) ──
export const assignableRoleIdsFor = (customRoles: CustomRole[]): string[] => [...ALL_ROLES, ...customRoles.map((r) => r.roleId)];
export const roleLabelFor = (customRoles: CustomRole[], id: string): string => (isBuiltIn(id) ? id : customRoles.find((r) => r.roleId === id)?.name ?? id);
// Scopes assignable to a CUSTOM role: RFC 0049 protocol scopes only (the
// `host:` management scopes are reserved to built-in admin/owner). Derived
// from the owner role's scope set, filtered to the non-`host:` (protocol) ones.
export const assignableScopesFor = (roles: AccessRole[]): string[] => (roles.find((r) => r.id === 'owner')?.scopes ?? []).filter((s) => !s.startsWith('host:'));

/**
 * ADR 0815 — the orgs-catalog key for a TYPED refusal the access-control routes
 * answer, or null for anything else (the caller keeps its transport copy). Reads
 * the error envelope `{ error, message, details: { reason } }` that
 * `client/accessClient.ts` carries on `ApiError.body`, so the page never shows
 * the server's English, and never "deleteMember returned 409".
 */
export type OrgsRefusalKey =
  | 'errorOwnerTier'
  | 'errorLastOwner'
  | 'errorIdentityLocked'
  | 'errorIdentityTaken'
  | 'errorTransferToSelf'
  | 'errorForbiddenScope';
export const refusalKeyOf = (err: unknown): OrgsRefusalKey | null => {
  const body = (err as { body?: unknown } | null)?.body;
  // ADR 0797 answers the owner rule as `details.code: 'owner_required'`; the
  // ADR 0815 refusals carry `details.reason`.
  if (readErrorDetail(body, 'code') === 'owner_required') return 'errorOwnerTier';
  switch (readErrorDetail(body, 'reason')) {
    case 'owner_required': return 'errorOwnerTier';
    case 'transfer_to_self': return 'errorTransferToSelf';
    case 'last_owner': return 'errorLastOwner';
    case 'identity_locked': return 'errorIdentityLocked';
    case 'identity_taken': return 'errorIdentityTaken';
    default: break;
  }
  const code = (body as { error?: unknown } | undefined)?.error;
  return code === 'forbidden_scope' || (code as { code?: unknown } | undefined)?.code === 'forbidden_scope' ? 'errorForbiddenScope' : null;
};

/**
 * ADR 0815 D2 — the members the server treats as OWNERS: an owner as a PERSON,
 * not a row. A row counts when any row of the same subject holds `owner`
 * directly (an ADR 0697 legacy twin) or sits in a group that grants it — the
 * server's `relationshipRoles`. Judging `m.roles` alone offered an admin the
 * controls for a group-derived owner and then refused them.
 */
export const effectiveOwnerIds = (members: readonly OrgMember[], groups: readonly Group[]): Set<string> => {
  const inOwnerGroup = new Set(groups.filter((g) => g.roles.includes('owner')).flatMap((g) => g.memberIds));
  const ownerRow = (m: OrgMember): boolean => m.roles.includes('owner') || inOwnerGroup.has(m.memberId);
  const ownerSubjects = new Set(members.filter((m) => ownerRow(m) && m.subject).map((m) => m.subject as string));
  return new Set(members.filter((m) => ownerRow(m) || (m.subject !== undefined && ownerSubjects.has(m.subject))).map((m) => m.memberId));
};
