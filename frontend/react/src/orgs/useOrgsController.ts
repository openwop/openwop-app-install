/**
 * useOrgsController — all state, data-loading, and action handlers for the Orgs
 * admin page, extracted verbatim from OrgsPage so the page component is a thin
 * JSX shell. Logic is unchanged; the hook returns every value the page (and the
 * panels it renders) consumes.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import {
  type AccessRole,
  type CustomRole,
  type EffectiveAccess,
  type Group,
  type Organization,
  type OrgMember,
  type Team,
  createCustomRole,
  createGroup,
  setActingMember,
  createMember,
  createOrg,
  createTeam,
  deleteCustomRole,
  deleteGroup,
  deleteMember,
  deleteOrg,
  deleteTeam,
  getEffectiveAccess,
  listGroups,
  listMembers,
  listOrgRoles,
  listOrgs,
  listRoles,
  listTeams,
  updateGroup,
  updateMember,
} from '../client/accessClient.js';
import { assignableRoleIdsFor, assignableScopesFor, isBuiltIn, roleLabelFor } from './orgsHelpers.js';

/** Built-in role code → orgs-catalog display-label key (codes stay as wire data). */
const BUILT_IN_ROLE_LABEL_KEY = {
  viewer: 'roleLabelViewer',
  editor: 'roleLabelEditor',
  admin: 'roleLabelAdmin',
  owner: 'roleLabelOwner',
} as const;

export function useOrgsController() {
  const { t } = useTranslation('orgs');
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create-org form.
  const [orgName, setOrgName] = useState('');
  // Create-team form.
  const [teamName, setTeamName] = useState('');
  // Create-member form (role ids: built-in or custom).
  const [memberName, setMemberName] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRoles, setMemberRoles] = useState<Set<string>>(new Set(['viewer']));

  // Inline per-member editor + access preview.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftRoles, setDraftRoles] = useState<Set<string>>(new Set());
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [access, setAccess] = useState<EffectiveAccess | null>(null);

  // Create-group form + inline group-membership editor.
  const [groupName, setGroupName] = useState('');
  const [groupRoles, setGroupRoles] = useState<Set<string>>(new Set(['editor']));
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [draftGroupMembers, setDraftGroupMembers] = useState<Set<string>>(new Set());

  // Create-custom-role form.
  const [roleName, setRoleName] = useState('');
  const [roleScopes, setRoleScopes] = useState<Set<string>>(new Set());

  // "View as member" enforcement seam: when set, the client sends
  // x-openwop-act-as and the backend enforces that member's scopes. viewScopes
  // drives which management actions are enabled.
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [viewScopes, setViewScopes] = useState<Set<string>>(new Set());

  // Memoized so the loaders below can depend on it without re-creating every
  // render (exhaustive-deps). `t` is stable in react-i18next, so `fail` is too.
  const fail = useCallback((err: unknown) => {
    // Friendly transport copy (GAP-ANALYSIS E5): 429/offline render as
    // recoverable guidance, not a raw `listX failed: 429`.
    const c = classifyHttpError(err);
    setError(t('errorWithDetail', { title: c.title, detail: c.detail }));
  }, [t]);

  const loadOrgs = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([listOrgs(), listRoles()]);
      setOrgs(o);
      setRoles(r);
      setError(null);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  const loadOrgDetail = useCallback(async (orgId: string) => {
    try {
      const [t, m, g, r] = await Promise.all([listTeams(orgId), listMembers(orgId), listGroups(orgId), listOrgRoles(orgId)]);
      setTeams(t);
      setMembers(m);
      setGroups(g);
      setCustomRoles(r.customRoles);
      setError(null);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  useEffect(() => {
    if (selectedOrgId) void loadOrgDetail(selectedOrgId);
  }, [selectedOrgId, loadOrgDetail]);

  // Switching orgs resets the "view as" lens — members are org-scoped, so a
  // lens from another org would be confusing. Back to owner (full access).
  useEffect(() => {
    setViewAs(null);
    setActingMember(null);
    setViewScopes(new Set());
  }, [selectedOrgId]);

  const selectedOrg = orgs.find((o) => o.orgId === selectedOrgId) ?? null;

  // ── Org actions ──
  const onCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) return;
    try {
      const org = await createOrg({ name: orgName.trim() });
      setOrgName('');
      await loadOrgs();
      setSelectedOrgId(org.orgId);
    } catch (err) {
      fail(err);
    }
  };

  const onDeleteOrg = async (org: Organization) => {
    if (!(await confirm({ title: t('confirmDeleteOrg', { name: org.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteOrg(org.orgId);
      if (selectedOrgId === org.orgId) setSelectedOrgId(null);
      await loadOrgs();
    } catch (err) {
      fail(err);
    }
  };

  // ── Team actions ──
  const onCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId || !teamName.trim()) return;
    try {
      await createTeam(selectedOrgId, { name: teamName.trim() });
      setTeamName('');
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const onDeleteTeam = async (team: Team) => {
    if (!selectedOrgId) return;
    if (!(await confirm({ title: t('confirmDeleteTeam', { name: team.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteTeam(selectedOrgId, team.teamId);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  // ── Member actions ──
  const onCreateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId || !memberName.trim()) return;
    try {
      await createMember(selectedOrgId, {
        displayName: memberName.trim(),
        ...(memberEmail.trim() ? { email: memberEmail.trim() } : {}),
        roles: [...memberRoles],
      });
      setMemberName('');
      setMemberEmail('');
      setMemberRoles(new Set(['viewer']));
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const startEdit = (m: OrgMember) => {
    setEditingId(m.memberId);
    setDraftRoles(new Set(m.roles));
    setAccessFor(null);
  };

  const onSaveRoles = async (m: OrgMember) => {
    if (!selectedOrgId) return;
    try {
      await updateMember(selectedOrgId, m.memberId, { roles: [...draftRoles] });
      setEditingId(null);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const onDeleteMember = async (m: OrgMember) => {
    if (!selectedOrgId) return;
    if (!(await confirm({ title: t('confirmRemoveMember', { name: m.displayName }), danger: true }))) return;
    try {
      await deleteMember(selectedOrgId, m.memberId);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const onShowAccess = async (m: OrgMember) => {
    if (accessFor === m.memberId) {
      setAccessFor(null);
      setAccess(null);
      return;
    }
    try {
      const ea = await getEffectiveAccess({ memberId: m.memberId });
      setAccess(ea);
      setAccessFor(m.memberId);
    } catch (err) {
      fail(err);
    }
  };

  // ── Group actions ──
  const onCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId || !groupName.trim()) return;
    try {
      await createGroup(selectedOrgId, { name: groupName.trim(), roles: [...groupRoles] });
      setGroupName('');
      setGroupRoles(new Set(['editor']));
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const onDeleteGroup = async (g: Group) => {
    if (!selectedOrgId) return;
    if (!(await confirm({ title: t('confirmDeleteGroup', { name: g.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteGroup(selectedOrgId, g.groupId);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const startEditGroup = (g: Group) => {
    setEditingGroupId(g.groupId);
    setDraftGroupMembers(new Set(g.memberIds));
  };

  const onSaveGroupMembers = async (g: Group) => {
    if (!selectedOrgId) return;
    try {
      await updateGroup(selectedOrgId, g.groupId, { memberIds: [...draftGroupMembers] });
      setEditingGroupId(null);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const nameOfMember = (id: string): string => members.find((m) => m.memberId === id)?.displayName ?? id;

  // ── "View as" lens: a specific MEMBER (backend-enforced via x-openwop-act-as)
  //    OR a built-in ROLE (client-side preview, ADR 0015 — "preview, not grant").
  //    Encoding: '' → owner/full · 'role:<id>' → role preview · else a memberId.
  const changeView = async (value: string | null) => {
    setViewAs(value);
    try {
      if (value === null) {
        setActingMember(null);
        setViewScopes(new Set());
      } else if (value.startsWith('role:')) {
        // Pure preview: gate the UI on the built-in role's scopes. No
        // x-openwop-act-as header — nothing is granted, so a solo operator can
        // SEE how each role experiences the workspace without a second account.
        setActingMember(null);
        const role = roles.find((r) => r.id === value.slice('role:'.length));
        setViewScopes(new Set(role?.scopes ?? []));
      } else {
        // "View as member" — backend-enforced: the act-as header makes the host
        // resolve that member's real scopes.
        setActingMember(value);
        const ea = await getEffectiveAccess({ memberId: value });
        setViewScopes(new Set(ea.scopes));
      }
      if (selectedOrgId) await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };
  /** Is the current lens (owner, an acted-as member, or a previewed role)
   *  allowed this scope? Owner (viewAs===null) ⇒ full access. */
  const can = (scope: string): boolean => viewAs === null || viewScopes.has(scope);

  // ── Role catalog helpers (built-in + custom) ──
  const assignableRoleIds: string[] = assignableRoleIdsFor(customRoles);
  const roleLabel = (id: string): string =>
    isBuiltIn(id) ? t(BUILT_IN_ROLE_LABEL_KEY[id]) : roleLabelFor(customRoles, id);
  const assignableScopes: string[] = assignableScopesFor(roles);

  // ── Custom-role actions ──
  const onCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId || !roleName.trim() || roleScopes.size === 0) return;
    try {
      await createCustomRole(selectedOrgId, { name: roleName.trim(), scopes: [...roleScopes] });
      setRoleName('');
      setRoleScopes(new Set());
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const onDeleteRole = async (r: CustomRole) => {
    if (!selectedOrgId) return;
    if (!(await confirm({ title: t('confirmDeleteRole', { name: r.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteCustomRole(selectedOrgId, r.roleId);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  return {
    orgs,
    selectedOrg,
    selectedOrgId,
    setSelectedOrgId,
    teams,
    members,
    groups,
    roles,
    customRoles,
    error,
    orgName,
    setOrgName,
    teamName,
    setTeamName,
    memberName,
    setMemberName,
    memberEmail,
    setMemberEmail,
    memberRoles,
    setMemberRoles,
    editingId,
    setEditingId,
    draftRoles,
    setDraftRoles,
    accessFor,
    access,
    groupName,
    setGroupName,
    groupRoles,
    setGroupRoles,
    editingGroupId,
    setEditingGroupId,
    draftGroupMembers,
    setDraftGroupMembers,
    roleName,
    setRoleName,
    roleScopes,
    setRoleScopes,
    viewAs,
    viewScopes,
    onCreateOrg,
    onDeleteOrg,
    onCreateTeam,
    onDeleteTeam,
    onCreateMember,
    startEdit,
    onSaveRoles,
    onDeleteMember,
    onShowAccess,
    onCreateGroup,
    onDeleteGroup,
    startEditGroup,
    onSaveGroupMembers,
    nameOfMember,
    changeView,
    can,
    assignableRoleIds,
    roleLabel,
    assignableScopes,
    onCreateRole,
    onDeleteRole,
  };
}
