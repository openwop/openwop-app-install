/**
 * OrgsListPanel — the left "Organizations" column of the Orgs admin page
 * (create form + clickable org cards), extracted verbatim from OrgsPage.
 * Presentational; state + handlers stay lifted in the container.
 */

import type { FormEvent } from 'react';
import type { Organization } from '../client/accessClient.js';
import { StateCard } from '../ui/StateCard.js';
import { BriefcaseIcon, TrashIcon } from '../ui/icons/index.js';

export interface OrgsListPanelProps {
  orgs: Organization[];
  selectedOrgId: string | null;
  setSelectedOrgId: (id: string) => void;
  orgName: string;
  setOrgName: (v: string) => void;
  onCreateOrg: (e: FormEvent) => void;
  onDeleteOrg: (org: Organization) => void;
  can: (scope: string) => boolean;
}

export function OrgsListPanel({
  orgs,
  selectedOrgId,
  setSelectedOrgId,
  orgName,
  setOrgName,
  onCreateOrg,
  onDeleteOrg,
  can,
}: OrgsListPanelProps): JSX.Element {
  return (
    <div className="orgslist-col">
      <h2 className="u-fs-16">Organizations</h2>
      <form onSubmit={onCreateOrg} className="action-bar u-mb-3">
        <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="New organization name" aria-label="New organization name" />
        <button type="submit" className="primary" disabled={!orgName.trim() || !can('host:org:manage')} title={can('host:org:manage') ? undefined : 'Requires host:org:manage'}>Create</button>
      </form>
      {orgs.length === 0 ? (
        <StateCard icon={<BriefcaseIcon size={32} />} title="No organizations yet" body="Create one to add teams and members." />
      ) : (
        orgs.map((o) => (
          // Clickable card, but NOT role="button": it contains its own
          // Delete <button>, and a button cannot nest interactive controls.
          // The proper a11y fix (make the org NAME the button, with a CSS
          // class to dodge the global button:hover dark-trap) needs a
          // browser-verified pass; until then this stays a plain clickable
          // div — a warn-first jsx-a11y backlog item, not an invalid-ARIA bug.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            key={o.orgId}
            className="surface-card orgslist-card"
            style={{
              borderColor: o.orgId === selectedOrgId ? 'var(--color-accent)' : undefined,
            }}
            onClick={() => setSelectedOrgId(o.orgId)}
          >
            <div className="u-flex u-justify-between u-items-center u-gap-2">
              <span className="u-iflex u-items-center u-gap-2">
                <BriefcaseIcon size={15} /> <strong>{o.name}</strong>
              </span>
              <button
                type="button"
                className="secondary"
                aria-label={`Delete ${o.name}`}
                disabled={!can('host:org:manage')}
                onClick={(e) => {
                  e.stopPropagation();
                  void onDeleteOrg(o);
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
            <div className="orgslist-muted">{o.slug}</div>
          </div>
        ))
      )}
    </div>
  );
}
