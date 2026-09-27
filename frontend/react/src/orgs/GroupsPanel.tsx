/**
 * GroupsPanel — the cross-cutting role-bundle ("Groups") section of the Orgs
 * admin page, extracted from OrgsPage (GAP-ANALYSIS E11, same presentational
 * pattern as MembersPanel). State + handlers stay lifted in OrgsPage.
 */

import { Button } from '../ui/Button.js';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { StateCard } from '../ui/StateCard.js';
import { useTranslation } from 'react-i18next';
import type { Group, OrgMember } from '../client/accessClient.js';
import { LockIcon, PencilIcon, TrashIcon } from '../ui/icons/index.js';
import { NEUTRAL_CHIP } from './orgUi.js';

export interface GroupsPanelProps {
  groups: Group[];
  members: OrgMember[];
  groupName: string;
  setGroupName: (v: string) => void;
  groupRoles: Set<string>;
  setGroupRoles: Dispatch<SetStateAction<Set<string>>>;
  assignableRoleIds: string[];
  editingGroupId: string | null;
  setEditingGroupId: (v: string | null) => void;
  draftGroupMembers: Set<string>;
  setDraftGroupMembers: Dispatch<SetStateAction<Set<string>>>;
  onCreateGroup: (e: FormEvent) => void;
  startEditGroup: (g: Group) => void;
  onDeleteGroup: (g: Group) => void;
  onSaveGroupMembers: (g: Group) => void;
  nameOfMember: (id: string) => string;
  can: (scope: string) => boolean;
  roleLabel: (id: string) => string;
  toggleStr: (set: Set<string>, id: string) => Set<string>;
}

export function GroupsPanel({
  groups, members, groupName, setGroupName, groupRoles, setGroupRoles, assignableRoleIds,
  editingGroupId, setEditingGroupId, draftGroupMembers, setDraftGroupMembers,
  onCreateGroup, startEditGroup, onDeleteGroup, onSaveGroupMembers, nameOfMember, can, roleLabel, toggleStr,
}: GroupsPanelProps): JSX.Element {
  const { t } = useTranslation('orgs');
  return (
    <>
      <h3 className="u-fs-14 u-mt-5 u-flex u-items-center u-gap-2">
        <LockIcon size={15} /> {t('groupsHeading')} <span className="groups-muted">{t('groupsHeadingSuffix')}</span>
      </h3>
      <p className="groups-muted">
        {t('groupsIntro')}
      </p>
      <form onSubmit={onCreateGroup} className="action-bar u-wrap u-mb-2">
        <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder={t('newGroupPlaceholder')} aria-label={t('newGroupAriaLabel')} />
        <span className="action-bar u-gap-1-5">
          {assignableRoleIds.map((role) => (
            <label key={role} className={`${NEUTRAL_CHIP} groups-chip-toggle${groupRoles.has(role) ? '' : ' u-dim-unselected'}`}>
              <input type="checkbox" checked={groupRoles.has(role)} onChange={() => setGroupRoles((s) => toggleStr(s, role))} className="u-mr-1" />
              {roleLabel(role)}
            </label>
          ))}
        </span>
        <Button variant="primary" type="submit" disabled={!groupName.trim() || !can('host:groups:manage')} title={can('host:groups:manage') ? undefined : t('addGroupRequiresScope')}>{t('addGroup')}</Button>
      </form>
      {groups.length === 0 ? (
        <StateCard title={t('noGroupsYet')} />
      ) : (
        groups.map((g) => (
          <div key={g.groupId} className="surface-card u-mb-2">
            <div className="u-flex u-justify-between u-items-baseline u-gap-2">
              <span className="u-iflex u-items-center u-gap-2">
                <LockIcon size={14} /> <strong>{g.name}</strong>
              </span>
              <span className="action-bar">
                <Button variant="secondary" disabled={!can('host:groups:manage')} onClick={() => startEditGroup(g)} aria-label={t('editGroupMembersAriaLabel', { name: g.name })}>
                  <PencilIcon size={13} /> {t('membersButton')}
                </Button>
                <Button variant="secondary" disabled={!can('host:groups:manage')} onClick={() => void onDeleteGroup(g)} aria-label={t('deleteGroupAriaLabel', { name: g.name })}>
                  <TrashIcon size={13} />
                </Button>
              </span>
            </div>
            <div className="u-flex u-wrap u-gap-1-5 u-mt-1-5">
              {g.roles.length === 0 ? <span className="chip chip--muted">{t('noGroupRoles')}</span> : g.roles.map((r) => <span key={r} className={NEUTRAL_CHIP}>{roleLabel(r)}</span>)}
            </div>
            <div className="groups-muted-mt">
              {t('groupMemberCount', { count: g.memberIds.length })}
              {g.memberIds.length ? t('groupMemberListSuffix', { names: g.memberIds.map(nameOfMember).join(', ') }) : ''}
            </div>
            {editingGroupId === g.groupId ? (
              <div className="action-bar u-wrap u-mt-2">
                {members.length === 0 ? (
                  <span className="groups-muted">{t('addMembersToOrgFirst')}</span>
                ) : (
                  members.map((m) => (
                    <label key={m.memberId} className={`${NEUTRAL_CHIP} groups-chip-toggle${draftGroupMembers.has(m.memberId) ? '' : ' u-dim-unselected'}`}>
                      <input
                        type="checkbox"
                        checked={draftGroupMembers.has(m.memberId)}
                        onChange={() => setDraftGroupMembers((s) => toggleStr(s, m.memberId))}
                        className="u-mr-1"
                      />
                      {m.displayName}
                    </label>
                  ))
                )}
                <Button variant="primary" onClick={() => void onSaveGroupMembers(g)}>{t('common:save')}</Button>
                <Button variant="secondary" onClick={() => setEditingGroupId(null)}>{t('common:cancel')}</Button>
              </div>
            ) : null}
          </div>
        ))
      )}
    </>
  );
}
