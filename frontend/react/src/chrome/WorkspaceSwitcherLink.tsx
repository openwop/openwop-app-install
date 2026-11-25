/**
 * The workspace slot's static affordance: a link to /orgs naming the instance.
 * The switcher shows it until workspaces load (or for an anonymous visitor), and
 * the sidebar shows it while the switcher's own chunk loads, so the switcher and
 * the workspace client stay out of the entry chunk.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBrand } from '../brand/BrandProvider.js';
import { BuildingIcon, ChevronRightIcon } from '../ui/icons/index.js';

export function WorkspaceSwitcherLink(): JSX.Element {
  const { t } = useTranslation('chrome');
  const brand = useBrand(); // live runtime brand (ADR 0170)
  return (
    <Link to="/orgs" className="app-workspace-switcher" title={t('workspaceAndOrgs')}>
      <span className="app-workspace-icon" aria-hidden><BuildingIcon size={16} /></span>
      <span className="app-workspace-meta">
        <span className="app-workspace-eyebrow">{t('workspace')}</span>
        <span className="app-workspace-name">{brand.instanceName}</span>
      </span>
      <span className="app-workspace-caret" aria-hidden><ChevronRightIcon size={14} /></span>
    </Link>
  );
}
