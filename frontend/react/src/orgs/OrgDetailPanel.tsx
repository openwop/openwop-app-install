/**
 * OrgDetailPanel — the right "selected org detail" column of the Orgs admin
 * page: the org header, the "View as" enforcement lens, and the Teams /
 * Members / Groups / Role-catalog / Custom-roles sub-panels. Extracted verbatim
 * from OrgsPage; presentational, with state + handlers lifted in the container.
 */

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AccessRole,
  CustomRole,
  EffectiveAccess,
  Group,
  Organization,
  OrgMember,
  Team,
} from '../client/accessClient.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { BriefcaseIcon } from '../ui/icons/index.js';
import { MembersPanel } from './MembersPanel.js';
import { GroupsPanel } from './GroupsPanel.js';
import { TeamsPanel } from './TeamsPanel.js';
import { RoleCatalogPanel } from './RoleCatalogPanel.js';
import { CustomRolesPanel } from './CustomRolesPanel.js';

export interface OrgDetailPanelProps {
  selectedOrg: Organization | null;
  members: OrgMember[];
  teams: Team[];
  groups: Group[];
  roles: AccessRole[];
  customRoles: CustomRole[];

  // "View as" lens.
  viewAs: string | null;
  viewScopes: Set<string>;
  /** Lens value: '' → owner · 'role:<id>' → role preview · else a memberId. */
  changeView: (value: string | null) => void;
  nameOfMember: (id: string) => string;

  // Teams.
  teamName: string;
  setTeamName: (v: string) => void;
  onCreateTeam: (e: FormEvent) => void;
  onDeleteTeam: (t: Team) => void;

  // Members.
  memberName: string;
  setMemberName: (v: string) => void;
  memberEmail: string;
  setMemberEmail: (v: string) => void;
  memberRoles: Set<string>;
  setMemberRoles: Dispatch<SetStateAction<Set<string>>>;
  assignableRoleIds: string[];
  editingId: string | null;
  setEditingId: (v: string | null) => void;
  draftRoles: Set<string>;
  setDraftRoles: Dispatch<SetStateAction<Set<string>>>;
  accessFor: string | null;
  access: EffectiveAccess | null;
  onCreateMember: (e: FormEvent) => void;
  onShowAccess: (m: OrgMember) => void;
  startEdit: (m: OrgMember) => void;
  onDeleteMember: (m: OrgMember) => void;
  onSaveRoles: (m: OrgMember) => void;

  // Groups.
  groupName: string;
  setGroupName: (v: string) => void;
  groupRoles: Set<string>;
  setGroupRoles: Dispatch<SetStateAction<Set<string>>>;
  editingGroupId: string | null;
  setEditingGroupId: (v: string | null) => void;
  draftGroupMembers: Set<string>;
  setDraftGroupMembers: Dispatch<SetStateAction<Set<string>>>;
  onCreateGroup: (e: FormEvent) => void;
  startEditGroup: (g: Group) => void;
  onDeleteGroup: (g: Group) => void;
  onSaveGroupMembers: (g: Group) => void;

  // Custom roles.
  roleName: string;
  setRoleName: (v: string) => void;
  roleScopes: Set<string>;
  setRoleScopes: Dispatch<SetStateAction<Set<string>>>;
  assignableScopes: string[];
  onCreateRole: (e: FormEvent) => void;
  onDeleteRole: (r: CustomRole) => void;

  // Shared helpers.
  can: (scope: string) => boolean;
  roleLabel: (id: string) => string;
  toggleStr: (set: Set<string>, id: string) => Set<string>;
}

export function OrgDetailPanel(props: OrgDetailPanelProps): JSX.Element {
  const { t } = useTranslation('orgs');
  const {
    selectedOrg,
    members,
    teams,
    groups,
    roles,
    customRoles,
    viewAs,
    viewScopes,
    changeView,
    nameOfMember,
    teamName,
    setTeamName,
    onCreateTeam,
    onDeleteTeam,
    memberName,
    setMemberName,
    memberEmail,
    setMemberEmail,
    memberRoles,
    setMemberRoles,
    assignableRoleIds,
    editingId,
    setEditingId,
    draftRoles,
    setDraftRoles,
    accessFor,
    access,
    onCreateMember,
    onShowAccess,
    startEdit,
    onDeleteMember,
    onSaveRoles,
    groupName,
    setGroupName,
    groupRoles,
    setGroupRoles,
    editingGroupId,
    setEditingGroupId,
    draftGroupMembers,
    setDraftGroupMembers,
    onCreateGroup,
    startEditGroup,
    onDeleteGroup,
    onSaveGroupMembers,
    roleName,
    setRoleName,
    roleScopes,
    setRoleScopes,
    assignableScopes,
    onCreateRole,
    onDeleteRole,
    can,
    roleLabel,
    toggleStr,
  } = props;

  return (
    <div className="orgdetail-col">
      {!selectedOrg ? (
        <StateCard title={t('selectOrgTitle')} body={t('selectOrgBody')} />
      ) : (
        <>
          <h2 className="u-fs-16 u-flex u-items-center u-gap-2">
            <BriefcaseIcon size={16} /> {selectedOrg.name}
          </h2>

          {/* "View as" lens — preview a built-in ROLE (UI-only, no second account
              needed) or enforce as a specific MEMBER (server-side via act-as). */}
          <div className="action-bar u-mb-2">
            <label className="orgdetail-viewas-label">
              {t('viewAsLabel')}
              <select aria-label={t('viewAsLabel')} value={viewAs ?? ''} onChange={(e) => void changeView(e.target.value || null)}>
                <option value="">{t('viewAsOwnerOption')}</option>
                <optgroup label={t('viewAsRoleGroupLabel')}>
                  {roles.filter((r) => r.id !== 'owner').map((r) => (
                    <option key={`role:${r.id}`} value={`role:${r.id}`}>{t('viewAsRoleOption', { name: r.name })}</option>
                  ))}
                </optgroup>
                {members.length > 0 ? (
                  <optgroup label={t('viewAsMemberGroupLabel')}>
                    {members.map((m) => (
                      <option key={m.memberId} value={m.memberId}>
                        {t('viewAsMemberOption', { name: m.displayName, roles: m.roles.join('/') || t('viewAsMemberNoRoles') })}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
          </div>
          {viewAs ? (
            <Notice variant="info">
              {viewAs.startsWith('role:') ? (
                <>
                  {t('previewingRolePrefix')}{' '}
                  <strong>{roles.find((r) => r.id === viewAs.slice('role:'.length))?.name ?? viewAs.slice('role:'.length)}</strong>{' '}
                  {t('previewingRoleSuffix', { count: viewScopes.size })}
                </>
              ) : (
                <>
                  {t('enforcingMemberPrefix')} <strong>{nameOfMember(viewAs)}</strong> {t('enforcingMemberSuffix', { count: viewScopes.size })}
                </>
              )}
            </Notice>
          ) : null}

          {/* Teams (extracted — GAP-ANALYSIS E11) */}
          <TeamsPanel
            teams={teams}
            teamName={teamName}
            setTeamName={setTeamName}
            onCreateTeam={onCreateTeam}
            onDeleteTeam={onDeleteTeam}
            can={can}
          />

          {/* Members (extracted — GAP-ANALYSIS E11) */}
          <MembersPanel
            members={members}
            memberName={memberName}
            setMemberName={setMemberName}
            memberEmail={memberEmail}
            setMemberEmail={setMemberEmail}
            memberRoles={memberRoles}
            setMemberRoles={setMemberRoles}
            assignableRoleIds={assignableRoleIds}
            editingId={editingId}
            setEditingId={setEditingId}
            draftRoles={draftRoles}
            setDraftRoles={setDraftRoles}
            accessFor={accessFor}
            access={access}
            onCreateMember={onCreateMember}
            onShowAccess={onShowAccess}
            startEdit={startEdit}
            onDeleteMember={onDeleteMember}
            onSaveRoles={onSaveRoles}
            can={can}
            roleLabel={roleLabel}
            toggleStr={toggleStr}
          />

          {/* Groups — cross-cutting role bundles (extracted — GAP-ANALYSIS E11) */}
          <GroupsPanel
            groups={groups}
            members={members}
            groupName={groupName}
            setGroupName={setGroupName}
            groupRoles={groupRoles}
            setGroupRoles={setGroupRoles}
            assignableRoleIds={assignableRoleIds}
            editingGroupId={editingGroupId}
            setEditingGroupId={setEditingGroupId}
            draftGroupMembers={draftGroupMembers}
            setDraftGroupMembers={setDraftGroupMembers}
            onCreateGroup={onCreateGroup}
            startEditGroup={startEditGroup}
            onDeleteGroup={onDeleteGroup}
            onSaveGroupMembers={onSaveGroupMembers}
            nameOfMember={nameOfMember}
            can={can}
            roleLabel={roleLabel}
            toggleStr={toggleStr}
          />

          {/* Role catalog reference (extracted — GAP-ANALYSIS E11) */}
          <RoleCatalogPanel roles={roles} />

          {/* Custom roles — org-defined role bundles (extracted — GAP-ANALYSIS E11) */}
          <CustomRolesPanel
            customRoles={customRoles}
            roleName={roleName}
            setRoleName={setRoleName}
            roleScopes={roleScopes}
            setRoleScopes={setRoleScopes}
            assignableScopes={assignableScopes}
            onCreateRole={onCreateRole}
            onDeleteRole={onDeleteRole}
            can={can}
            toggleStr={toggleStr}
          />
        </>
      )}
    </div>
  );
}
