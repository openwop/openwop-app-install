/**
 * Quick create tile (ADR 0377 Wave 3) — the launchpad shortcut type (MyndHyve's
 * `quick-create` / Monday's bookmarks): config-driven in-app links styled as
 * quiet buttons. ZERO data calls. The link list is build-time config here —
 * deliberately NOT user-editable state (that would be new data, ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MessageSquareIcon, WorkflowIcon, FileTextIcon } from '../../../ui/icons/index.js';
import type { DashboardTileProps } from '../tileTypes.js';

const ACTIONS = [
  { key: 'chat', to: '/chat', icon: MessageSquareIcon, labelKey: 'quickNewChat' },
  { key: 'workflow', to: '/builder', icon: WorkflowIcon, labelKey: 'quickNewWorkflow' },
  { key: 'document', to: '/documents', icon: FileTextIcon, labelKey: 'quickNewDocument' },
  // (The "customize" shortcut was dropped 2026-07-16 — it linked to '/', the page
  // the tile lives on; the header's Customize button is the real affordance.)
] as const;

export default function QuickCreateTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  return (
    <div className="dash-tile__quick">
      {ACTIONS.map((a) => {
        const Icon = a.icon;
        return (
          <Link key={a.key} to={a.to} className="btn-ghost btn-sm dash-tile__quick-link">
            <Icon size={14} /> {t(a.labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
