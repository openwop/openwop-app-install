/**
 * useOrgsController — all state, data-loading, and action handlers for the Orgs
 * admin page, extracted verbatim from OrgsPage so the page component is a thin
 * JSX shell. Logic is unchanged; the hook returns every value the page (and the
 * panels it renders) consumes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { toast } from '../ui/toast.js';
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
import { invalidateOrgMembers } from './orgMembers.js';
import { assignableRoleIdsFor, assignableScopesFor, isBuiltIn, refusalKeyOf, roleLabelFor } from './orgsHelpers.js';

/** Built-in role code → orgs-catalog display-label key (codes stay as wire data). */
const BUILT_IN_ROLE_LABEL_KEY = {
  viewer: 'roleLabelViewer',
  editor: 'roleLabelEditor',
  admin: 'roleLabelAdmin',
  owner: 'roleLabelOwner',
} as const;

/** ADR 0815 D6 — a membership-derived resolution is authoritative for the UI.
 *  In a SHARED workspace (`ws:`, strictly membership-derived) "no membership in
 *  this org" is authoritative too: nothing is offered, since the server refuses
 *  all of it. Any other basis (the implicit personal owner, an operator, a
 *  superadmin) is `null` = unknown, and the server decides. */
const scopesOf = (ea: EffectiveAccess, tenantId: string | undefined): Set<string> | null => {
  if (ea.superadmin === true) return null;
  if (ea.basis === 'member') return new Set(ea.scopes);
  return ea.basis === 'none' && tenantId?.startsWith('ws:') === true ? new Set() : null;
};

export function useOrgsController() {
  const { t } = useTranslation('orgs');
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const orgsRef = useRef(orgs);
  orgsRef.current = orgs;
  const orgsLoaded = orgs.length > 0;
  // R2 IN-SP-13 — honor a `?org=` deep link (the DocumentsPage convention) so
  // the invite-accept done state can land a new member IN the org they joined.
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => {
    try { return new URLSearchParams(window.location.search).get('org'); } catch { return null; }
  });
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

  // ADR 0815 (grade-ux ORGUX-1) — the caller's OWN access. The lens only ever
  // NARROWS (the server enforces that too, D1), so "no lens" means "what YOU may
  // do", never "full access": an admin used to be offered every owner-tier
  // control and got a 403 on each. `null` = not membership-derived (the implicit
  // personal owner, an operator, a superadmin) — the server decides.
  const [ownScopes, setOwnScopes] = useState<Set<string> | null>(null);
  const [rootScopes, setRootScopes] = useState<Set<string> | null>(null);

  // Memoized so the loaders below can depend on it without re-creating every
  // render (exhaustive-deps). `t` is stable in react-i18next, so `fail` is too.
  const fail = useCallback((err: unknown) => {
    // ADR 0815 (ORGUX-2) — a typed refusal gets its own localized, actionable
    // copy; everything else keeps the friendly transport copy (GAP-ANALYSIS E5).
    const key = refusalKeyOf(err);
    if (key) {
      setError(t(key));
      return;
    }
    const c = classifyHttpError(err);
    setError(t('errorWithDetail', { title: c.title, detail: c.detail }));
  }, [t]);

  const loadOrgs = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([listOrgs(), listRoles()]);
      setOrgs(o);
      setRoles(r);
      // ORGUX-1 — creating an org inside a shared workspace is owner-tier at the
      // workspace ROOT (ADR 0815 D1a); a tenant without a root is left to the server.
      const root = o.find((org) => org.orgId === org.tenantId);
      let rootLens: Set<string> | null = null;
      if (root) {
        try {
          rootLens = scopesOf(await getEffectiveAccess({ orgId: root.orgId }), root.tenantId);
        } catch {
          // An unreadable resolution is UNKNOWN, not "no access": the controls stay
          // offered and the server's refusal (typed, localized) is the answer.
          rootLens = null;
        }
      }
      setRootScopes(rootLens);
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
    // Review F9 — a deep-linked org may not exist in THIS workspace's list
    // (bogus param, or a cross-tenant invite landing): clear it instead of
    // firing a 404 detail read that paints an error banner.
    if (selectedOrgId && orgs.length > 0 && !orgs.some((o) => o.orgId === selectedOrgId)) {
      setSelectedOrgId(null);
      return;
    }
    if (selectedOrgId && orgs.some((o) => o.orgId === selectedOrgId)) void loadOrgDetail(selectedOrgId);
  }, [selectedOrgId, orgs, loadOrgDetail]);

  // Switching orgs resets the "view as" lens — members are org-scoped, so a
  // lens from another org would be confusing. Back to owner (full access).
  useEffect(() => {
    setViewAs(null);
    setActingMember(null);
    setViewScopes(new Set());
    setOwnScopes(null);
    if (!selectedOrgId) return;
    let live = true;
    // Read through a ref: a reload of the org list must not reset the lens. Re-run
    // once the list first arrives (`orgsLoaded`), so a `?org=` deep link is not
    // judged without its tenant.
    const tenantId = orgsRef.current.find((o) => o.orgId === selectedOrgId)?.tenantId;
    getEffectiveAccess({ orgId: selectedOrgId })
      .then((ea) => { if (live) setOwnScopes(scopesOf(ea, tenantId)); })
      .catch(() => { /* unknown ⇒ the server decides; the load error path owns the banner */ });
    return () => { live = false; };
  }, [selectedOrgId, orgsLoaded]);

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
      // ADR 0815 D1a — in a shared tenant (a workspace, or the SAML tenant every
      // SAML user shares) creating an org is owner-tier: say what to do about it.
      if (refusalKeyOf(err) === 'errorOwnerTier') setError(t('errorCreateOrgOwnerRequired'));
      else fail(err);
    }
  };

  const onDeleteOrg = async (org: Organization) => {
    // SET-R2-1 — an org delete cascades to every team + member it holds; the
    // highest-blast-radius action in the admin cluster earns the typed gate
    // (the Vercel delete-project convention), not just a click-confirm.
    if (!(await confirm({ title: t('confirmDeleteOrg', { name: org.name }), danger: true, confirmLabel: t('common:delete'), typeToConfirm: org.name }))) return;
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
      invalidateOrgMembers(selectedOrgId); // CLNP-2(d) — pickers elsewhere must not keep the old list
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
      invalidateOrgMembers(selectedOrgId); // CLNP-2(d) — pickers elsewhere must not keep the old list
      setEditingId(null);
      await loadOrgDetail(selectedOrgId);
    } catch (err) {
      fail(err);
    }
  };

  const onDeleteMember = async (m: OrgMember) => {
    if (!selectedOrgId) return;
    // ORGUX-3 — say what ELSE happens (ADR 0815 D4): removal is not only the row.
    if (!(await confirm({
      title: t('confirmRemoveMember', { name: m.displayName }),
      // Leaving the workspace ROOT is leaving: keys, invites, schedules. A sub-org
      // removal takes down only that org's pending invites (ADR 0815 D4).
      // In a root-less tenant (no `ws:` root) presence is ANY membership, so the
      // copy cannot know whether this was their last one and says so.
      body: t(!m.tenantId.startsWith('ws:') ? 'confirmRemoveMemberBodyNeutral'
        : m.orgId === m.tenantId ? 'confirmRemoveMemberBody' : 'confirmRemoveSubOrgMemberBody'),
      danger: true,
      confirmLabel: t('removeMemberConfirm'),
    }))) return;
    try {
      await deleteMember(selectedOrgId, m.memberId);
      invalidateOrgMembers(selectedOrgId); // CLNP-2(d) — pickers elsewhere must not keep the old list
      toast.success(t('memberRemoved', { name: m.displayName }));
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
  const lens = (scope: string): boolean => viewAs === null || viewScopes.has(scope);
  const can = (scope: string): boolean => lens(scope) && (ownScopes === null || ownScopes.has(scope));
  /** Tenant-level actions (create / delete an org) — judged at the workspace root. */
  const canTenant = (scope: string): boolean => lens(scope) && (rootScopes === null || rootScopes.has(scope));
  /** ADR 0815 D2 — the owner tier (granting `owner`, touching an owner row or an
   *  owner-carrying group) is owner-only; the panels judge rows with the same
   *  `can('host:org:manage')`. */
  const ownerTier = can('host:org:manage');

  // ── Role catalog helpers (built-in + custom) ──
  // Without the owner tier, `owner` is not offered at all (the server refuses it).
  const assignableRoleIds: string[] = assignableRoleIdsFor(customRoles).filter((id) => id !== 'owner' || ownerTier);
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
    canTenant,
    assignableRoleIds,
    roleLabel,
    assignableScopes,
    onCreateRole,
    onDeleteRole,
  };
}
