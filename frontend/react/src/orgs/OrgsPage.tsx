/**
 * Organizations / teams / members + roles — management UI for the
 * access-control host-extension (non-normative).
 *
 * Left: the caller's organizations + a create form. Right: the selected org's
 * teams and members, with per-member role assignment, an effective-access
 * preview (principal → roles → RFC 0049 scopes), and the built-in role catalog
 * for reference.
 *
 * Authority shown here resolves ONLY from a member's explicit roles — never
 * from the descriptive org-chart (RFC 0087 §B). This surface manages WHO has
 * WHICH role; it does not enforce on the protocol runs/artifacts paths yet, so
 * the host does not advertise capabilities.authorization.
 *
 * @see ../client/accessClient.ts
 */
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { OrgsListPanel } from './OrgsListPanel.js';
import { OrgDetailPanel } from './OrgDetailPanel.js';
import { toggleStr } from './orgsHelpers.js';
import { useOrgsController } from './useOrgsController.js';

export function OrgsPage(): JSX.Element {
  const c = useOrgsController();

  return (
    <section>
      <PageHeader
        eyebrow="Settings"
        title="Organizations & access"
        lede={<>Organizations, teams, and members with role-based access. Roles map to OpenWOP authorization scopes (RFC 0049); a member&rsquo;s authority comes from its assigned roles only — org-chart position confers none.</>}
      />
      {c.error ? <Notice variant="error">{c.error}</Notice> : null}

      <div className="orgspage-columns">
        {/* ── Left: orgs ── */}
        <OrgsListPanel
          orgs={c.orgs}
          selectedOrgId={c.selectedOrgId}
          setSelectedOrgId={c.setSelectedOrgId}
          orgName={c.orgName}
          setOrgName={c.setOrgName}
          onCreateOrg={c.onCreateOrg}
          onDeleteOrg={c.onDeleteOrg}
          can={c.can}
        />

        {/* ── Right: selected org detail ── */}
        <OrgDetailPanel
          selectedOrg={c.selectedOrg}
          members={c.members}
          teams={c.teams}
          groups={c.groups}
          roles={c.roles}
          customRoles={c.customRoles}
          viewAs={c.viewAs}
          viewScopes={c.viewScopes}
          changeView={c.changeView}
          nameOfMember={c.nameOfMember}
          teamName={c.teamName}
          setTeamName={c.setTeamName}
          onCreateTeam={c.onCreateTeam}
          onDeleteTeam={c.onDeleteTeam}
          memberName={c.memberName}
          setMemberName={c.setMemberName}
          memberEmail={c.memberEmail}
          setMemberEmail={c.setMemberEmail}
          memberRoles={c.memberRoles}
          setMemberRoles={c.setMemberRoles}
          assignableRoleIds={c.assignableRoleIds}
          editingId={c.editingId}
          setEditingId={c.setEditingId}
          draftRoles={c.draftRoles}
          setDraftRoles={c.setDraftRoles}
          accessFor={c.accessFor}
          access={c.access}
          onCreateMember={c.onCreateMember}
          onShowAccess={c.onShowAccess}
          startEdit={c.startEdit}
          onDeleteMember={c.onDeleteMember}
          onSaveRoles={c.onSaveRoles}
          groupName={c.groupName}
          setGroupName={c.setGroupName}
          groupRoles={c.groupRoles}
          setGroupRoles={c.setGroupRoles}
          editingGroupId={c.editingGroupId}
          setEditingGroupId={c.setEditingGroupId}
          draftGroupMembers={c.draftGroupMembers}
          setDraftGroupMembers={c.setDraftGroupMembers}
          onCreateGroup={c.onCreateGroup}
          startEditGroup={c.startEditGroup}
          onDeleteGroup={c.onDeleteGroup}
          onSaveGroupMembers={c.onSaveGroupMembers}
          roleName={c.roleName}
          setRoleName={c.setRoleName}
          roleScopes={c.roleScopes}
          setRoleScopes={c.setRoleScopes}
          assignableScopes={c.assignableScopes}
          onCreateRole={c.onCreateRole}
          onDeleteRole={c.onDeleteRole}
          can={c.can}
          roleLabel={c.roleLabel}
          toggleStr={toggleStr}
        />
      </div>
    </section>
  );
}
