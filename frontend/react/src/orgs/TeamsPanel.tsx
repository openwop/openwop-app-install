/**
 * TeamsPanel — the Teams section of the Orgs admin page, extracted from
 * OrgsPage (GAP-ANALYSIS E11). Presentational; state + handlers stay lifted.
 */

import type { FormEvent } from 'react';
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
  return (
    <>
      <h3 className="u-fs-14 u-flex u-items-center u-gap-2">
        <ColumnsIcon size={15} /> Teams
      </h3>
      <form onSubmit={onCreateTeam} className="action-bar u-mb-2">
        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name" aria-label="New team name" />
        <button type="submit" className="primary" disabled={!teamName.trim() || !can('host:teams:manage')} title={can('host:teams:manage') ? undefined : 'Requires host:teams:manage'}>Add team</button>
      </form>
      {teams.length === 0 ? (
        <p className="teams-muted">No teams yet.</p>
      ) : (
        <div className="u-flex u-wrap u-gap-2 u-mb-3">
          {teams.map((t) => (
            <span key={t.teamId} className={`${NEUTRAL_CHIP} u-iflex u-items-center u-gap-1-5`}>
              {t.name}
              <button
                type="button"
                aria-label={`Delete team ${t.name}`}
                disabled={!can('host:teams:manage')}
                onClick={() => void onDeleteTeam(t)}
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
