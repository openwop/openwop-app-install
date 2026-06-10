/**
 * Pure helpers + constants for the Orgs admin page, extracted verbatim from
 * OrgsPage so the container stays a thin shell. No React/state dependencies —
 * just set toggling and the built-in role catalog.
 */

import type { AccessRole, BuiltInRoleId, CustomRole } from '../client/accessClient.js';

/**
 * Roles, teams, and scopes are non-status LABEL dimensions, so per
 * DESIGN.md §5.3/§5.4 they differentiate by their text label — never by a
 * functional/accent color (those are reserved for run/agent/node status +
 * severity). Every such chip is the one neutral pill (`NEUTRAL_CHIP`, see
 * orgUi.ts); selected/unselected in a toggle is shown by opacity, not color.
 */
export const ALL_ROLES: BuiltInRoleId[] = ['viewer', 'editor', 'admin', 'owner'];

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
