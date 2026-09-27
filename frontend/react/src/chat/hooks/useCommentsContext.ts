/**
 * Resolves the inline-chat comment context (ADR 0021 extension): the org
 * namespace a `chat_message` thread lives under, gated by the `comments`
 * feature toggle. A chat session is tenant-private (it carries no org field,
 * unlike the org-shared cms/kb resources), so its comments are namespaced under
 * the caller's PRIMARY org — the same org the CommentsPage deep-link lands in.
 *
 * Returns null when comments are disabled OR the tenant has no org, so the
 * caller simply renders no affordance. The single `listOrgs()` call runs once
 * per surface mount (not per message), keeping chat load off the rate-limit
 * fan-out path.
 */
import { useEffect, useState } from 'react';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { listOrgs } from '../../features/comments/commentsClient.js';

export function useCommentsContext(): { orgId: string } | null {
  const access = useFeatureAccess('comments');
  const [orgId, setOrgId] = useState<string>('');
  useEffect(() => {
    if (!access.enabled) { setOrgId(''); return; }
    let alive = true;
    void listOrgs()
      .then((orgs) => { if (alive) setOrgId(orgs[0]?.orgId ?? ''); })
      .catch(() => { if (alive) setOrgId(''); });
    return () => { alive = false; };
  }, [access.enabled]);
  return access.enabled && orgId ? { orgId } : null;
}
