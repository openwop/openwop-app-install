/**
 * TeamsPanel — the Teams section of the Orgs admin page, extracted from
 * OrgsPage (GAP-ANALYSIS E11). Presentational; state + handlers stay lifted.
 */

import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Team } from '../client/accessClient.js';
import { ColumnsIcon, TrashIcon } from '../ui/icons/index.js';
import { NEUTRAL_CHIP } from './orgUi.js';

export interface TeamsPanelProps {
  teams: Team[];
  teamName: string;
  setTeamName: (v: string) => void;
  onCreateTeam: (e: FormEvent) => void;
  onDeleteTeam: (t: Team) => void;
  can: (scope: string) => boolean;
}

export function TeamsPanel({ teams, teamName, setTeamName, onCreateTeam, onDeleteTeam, can }: TeamsPanelProps): JSX.Element {
  const { t } = useTranslation('orgs');
  return (
    <>
      <h3 className="u-fs-14 u-flex u-items-center u-gap-2">
        <ColumnsIcon size={15} /> {t('teamsHeading')}
      </h3>
      <form onSubmit={onCreateTeam} className="action-bar u-mb-2">
        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder={t('newTeamPlaceholder')} aria-label={t('newTeamAriaLabel')} />
        <button type="submit" className="primary" disabled={!teamName.trim() || !can('host:teams:manage')} title={can('host:teams:manage') ? undefined : t('addTeamRequiresScope')}>{t('addTeam')}</button>
      </form>
      {teams.length === 0 ? (
        <p className="teams-muted">{t('noTeamsYet')}</p>
      ) : (
        <div className="u-flex u-wrap u-gap-2 u-mb-3">
          {teams.map((team) => (
            <span key={team.teamId} className={`${NEUTRAL_CHIP} u-iflex u-items-center u-gap-1-5`}>
              {team.name}
              <button
                type="button"
                aria-label={t('deleteTeamAriaLabel', { name: team.name })}
                disabled={!can('host:teams:manage')}
                onClick={() => void onDeleteTeam(team)}
                className="teams-chip-delete"
              >
                <TrashIcon size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
