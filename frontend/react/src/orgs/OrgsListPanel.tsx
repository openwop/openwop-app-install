/**
 * OrgsListPanel — the left "Organizations" column of the Orgs admin page
 * (create form + clickable org cards), extracted verbatim from OrgsPage.
 * Presentational; state + handlers stay lifted in the container.
 */

import { Button } from '../ui/Button.js';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Organization } from '../client/accessClient.js';
import { StateCard } from '../ui/StateCard.js';
import { WorkspaceCreateSection } from './WorkspaceCreateSection.js';
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
  /** Optional: override the post-create refresh (tests inject; app reloads). */
  onWorkspaceCreated?: () => void;
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
  onWorkspaceCreated,
}: OrgsListPanelProps): JSX.Element {
  const { t } = useTranslation('orgs');
  return (
    <div className="orgslist-col">
      {/* A WORKSPACE is the tenant (ADR 0015); an ORGANIZATION is a grouping
          INSIDE it. This page only ever managed the latter, but its title and lede
          ("Organize your team…") read as the entry point for both — so people came
          here to make a workspace and found no way to. Creating one lives in the
          sidebar switcher, which is labelled "switch", so it was not discoverable
          from here either. Name the distinction and offer the action. */}
      <WorkspaceCreateSection {...(onWorkspaceCreated ? { onCreated: onWorkspaceCreated } : {})} />
      <h2 className="u-fs-16">{t('orgsHeading')}</h2>
      <form onSubmit={onCreateOrg} className="action-bar u-mb-3">
        <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder={t('newOrgPlaceholder')} aria-label={t('newOrgAriaLabel')} />
        <Button variant="primary" type="submit" disabled={!orgName.trim() || !can('host:org:manage')} title={can('host:org:manage') ? undefined : t('createOrgRequiresScope')}>{t('common:create')}</Button>
      </form>
      {orgs.length === 0 ? (
        <StateCard icon={<BriefcaseIcon size={32} />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        orgs.map((o) => (
          // ARIA 1.2 / keyboard access (UX-ASSESSMENT ADM-1): the open action
          // is a real <button> (the card body — name + slug), with the Delete
          // control as a SIBLING, never an interactive descendant. Selection is
          // announced via aria-current and styled via the card's data-selected
          // class, not an inline border color (ADM-2). Same shape as the
          // ConversationsRail row refactor. `.orgslist-open:hover` pins the
          // colors the global button:hover would otherwise repaint.
          <div
            key={o.orgId}
            className="surface-card orgslist-card"
            data-selected={o.orgId === selectedOrgId ? 'true' : undefined}
          >
            <div className="u-flex u-justify-between u-items-center u-gap-2">
              <button
                type="button"
                className="orgslist-open"
                onClick={() => setSelectedOrgId(o.orgId)}
                aria-current={o.orgId === selectedOrgId ? 'true' : undefined}
              >
                <span className="u-iflex u-items-center u-gap-2">
                  <BriefcaseIcon size={15} /> <strong>{o.name}</strong>
                </span>
                <span className="orgslist-muted u-block">{o.slug}</span>
              </button>
              <Button
                variant="secondary"
                aria-label={t('deleteOrgAriaLabel', { name: o.name })}
                disabled={!can('host:org:manage')}
                onClick={() => {
                  void onDeleteOrg(o);
                }}
              >
                <TrashIcon size={14} />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
