/**
 * ADR 1109 D4 — what a request is about, on its inbox card. The name comes from
 * the projects THIS reader can list, never from the notification, so a project
 * they cannot see stays "A project", with no link.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function SubjectChip({ projectId, projectNames }: {
  projectId: string | undefined;
  /** The reader's visible projects, id → name. */
  projectNames: ReadonlyMap<string, string>;
}): JSX.Element | null {
  const { t } = useTranslation('notifications');
  if (!projectId) return null;
  const name = projectNames.get(projectId);
  return name
    ? <Link to={`/projects/${encodeURIComponent(projectId)}`} className="chip">{name}</Link>
    : <span className="chip chip--muted">{t('subjectUnknownProject')}</span>;
}
