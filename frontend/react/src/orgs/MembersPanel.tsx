/**
 * MembersPanel — the members management section of the Orgs admin page,
 * extracted from the 728-line OrgsPage god-component (GAP-ANALYSIS E11).
 * Presentational: all state + handlers stay lifted in OrgsPage and arrive as
 * props, so behavior is unchanged; this just gives the section its own file +
 * a named, typed surface. The remaining sections (Groups, Teams, Custom roles)
 * extract the same way.
 */

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgMember, EffectiveAccess } from '../client/accessClient.js';
import { StateCard } from '../ui/StateCard.js';
import { UserIcon, ShieldIcon, PencilIcon, TrashIcon } from '../ui/icons/index.js';
import { NEUTRAL_CHIP } from './orgUi.js';

export interface MembersPanelProps {
  members: OrgMember[];
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
  can: (scope: string) => boolean;
  roleLabel: (id: string) => string;
  toggleStr: (set: Set<string>, id: string) => Set<string>;
}

export function MembersPanel({
  members, memberName, setMemberName, memberEmail, setMemberEmail, memberRoles, setMemberRoles,
  assignableRoleIds, editingId, setEditingId, draftRoles, setDraftRoles, accessFor, access,
  onCreateMember, onShowAccess, startEdit, onDeleteMember, onSaveRoles, can, roleLabel, toggleStr,
}: MembersPanelProps): JSX.Element {
  const { t } = useTranslation('orgs');
  return (
    <>
      <h3 className="u-fs-14 u-flex u-items-center u-gap-2">
        <UserIcon size={15} /> {t('membersHeading')}
      </h3>
      <form onSubmit={onCreateMember} className="action-bar u-wrap u-mb-3">
        <input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder={t('memberNamePlaceholder')} aria-label={t('memberNameAriaLabel')} />
        <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} placeholder={t('memberEmailPlaceholder')} aria-label={t('memberEmailAriaLabel')} />
        <span className="action-bar u-gap-1-5">
          {assignableRoleIds.map((role) => (
            <label key={role} className={`${NEUTRAL_CHIP} members-chip-toggle`} style={{ opacity: memberRoles.has(role) ? 1 : 0.6 }}>
              <input
                type="checkbox"
                checked={memberRoles.has(role)}
                onChange={() => setMemberRoles((s) => toggleStr(s, role))}
                className="u-mr-1"
              />
              {roleLabel(role)}
            </label>
          ))}
        </span>
        <button type="submit" className="primary" disabled={!memberName.trim() || !can('host:members:manage')} title={can('host:members:manage') ? undefined : t('addMemberRequiresScope')}>{t('addMember')}</button>
      </form>

      {members.length === 0 ? (
        <StateCard icon={<UserIcon size={28} />} title={t('noMembersTitle')} body={t('noMembersBody')} />
      ) : (
        members.map((m) => (
          <div key={m.memberId} className="surface-card u-mb-2">
            <div className="u-flex u-justify-between u-items-baseline u-gap-2">
              <span>
                <strong>{m.displayName}</strong>
                {m.email ? <span className="members-muted"> · {m.email}</span> : null}
              </span>
              <span className="action-bar">
                <button type="button" className="secondary" onClick={() => void onShowAccess(m)}>
                  <ShieldIcon size={13} /> {t('accessButton')}
                </button>
                <button type="button" className="secondary" disabled={!can('host:members:manage')} onClick={() => startEdit(m)} aria-label={t('editRolesAriaLabel', { name: m.displayName })}>
                  <PencilIcon size={13} /> {t('rolesButton')}
                </button>
                <button type="button" className="secondary" disabled={!can('host:members:manage')} onClick={() => void onDeleteMember(m)} aria-label={t('removeMemberAriaLabel', { name: m.displayName })}>
                  <TrashIcon size={13} />
                </button>
              </span>
            </div>

            {/* role chips */}
            <div className="u-flex u-wrap u-gap-1-5 u-mt-1-5">
              {m.roles.length === 0 ? (
                <span className="chip chip--muted">{t('noRoles')}</span>
              ) : (
                m.roles.map((r) => <span key={r} className={NEUTRAL_CHIP}>{roleLabel(r)}</span>)
              )}
            </div>

            {/* inline role editor */}
            {editingId === m.memberId ? (
              <div className="action-bar u-wrap u-mt-2">
                {assignableRoleIds.map((role) => (
                  <label key={role} className={`${NEUTRAL_CHIP} members-chip-toggle`} style={{ opacity: draftRoles.has(role) ? 1 : 0.6 }}>
                    <input
                      type="checkbox"
                      checked={draftRoles.has(role)}
                      onChange={() => setDraftRoles((s) => toggleStr(s, role))}
                      className="u-mr-1"
                    />
                    {roleLabel(role)}
                  </label>
                ))}
                <button type="button" className="primary" onClick={() => void onSaveRoles(m)}>{t('common:save')}</button>
                <button type="button" className="secondary" onClick={() => setEditingId(null)}>{t('common:cancel')}</button>
              </div>
            ) : null}

            {/* effective-access preview */}
            {accessFor === m.memberId && access ? (
              <div className="u-mt-2">
                <div className="members-muted">
                  {t('effectiveScopesBasis', { basis: access.basis })}
                </div>
                <div className="u-flex u-wrap u-gap-1-5 u-mt-1">
                  {access.scopes.length === 0 ? (
                    <span className="chip chip--muted">{t('noScopesFailClosed')}</span>
                  ) : (
                    access.scopes.map((s) => (
                      <span key={s} className={NEUTRAL_CHIP}>{s}</span>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ))
      )}
    </>
  );
}
