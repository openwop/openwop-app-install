import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { useAdminParentRoute } from './AdminRouteContext.js';

/** Standard admin title contract. Parent wayfinding is derived by AdminLayout
 * from manifest metadata, so feature packages never import the registry. */
export function AdminPageHeader(props: Omit<Parameters<typeof PageHeader>[0], 'breadcrumb'>): JSX.Element {
  const parent = useAdminParentRoute();
  const { t } = useTranslation('nav');
  const label = parent ? (parent.labelKey ? t(parent.labelKey, { defaultValue: parent.label }) : parent.label) : '';
  return <PageHeader {...props} breadcrumb={parent ? <Link className="page-header__back" to={parent.path}>← {label}</Link> : undefined} />;
}
