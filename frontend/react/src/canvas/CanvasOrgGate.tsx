/**
 * What a canvas surface shows when it cannot know which org to open.
 *
 * Shared by all four surfaces so the honesty does not drift: the four used to
 * hold four copies of `orgs[0]?.orgId`, and a wrong answer is exactly the sort
 * of thing that gets fixed in one copy and left in three.
 *
 * Each branch says what is actually true. None of them guesses, because a guess
 * here is indistinguishable to the user from the canvas being broken — which is
 * how the original defect presented: a canvas in your second workspace came back
 * as a generic load error, with no hint that the workspace was the problem.
 */
import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';

import { Notice } from '../ui/index.js';
import type { CanvasOrgResolution } from './resolveCanvasOrg.js';

export function CanvasOrgGate({
  resolution,
  onPick,
}: {
  resolution: Exclude<CanvasOrgResolution, { kind: 'ok' }>;
  /** Supplied by editable surfaces; omit to render the ambiguous case read-only. */
  onPick?: (orgId: string) => void;
}): JSX.Element {
  const { t } = useTranslation('canvas');

  if (resolution.kind === 'none') {
    return <Notice variant="error" announce={t('orgNoneBody')}>{t('orgNoneBody')}</Notice>;
  }

  if (resolution.kind === 'notMember') {
    // Deliberately does NOT name what lives in that org, or whether it exists.
    return (
      <Notice variant="error" announce={t('orgNotMemberBody')}>{t('orgNotMemberBody')}</Notice>
    );
  }

  return (
    <div className="u-grid u-gap-2">
      <Notice variant="warning" announce={t('orgAmbiguousBody')}>{t('orgAmbiguousBody')}</Notice>
      <ul className="list-plain u-grid u-gap-1">
        {resolution.orgs.map((o) => (
          <li key={o.orgId}>
            <Button
              variant="secondary" size="sm"
              onClick={() => onPick?.(o.orgId)}
              disabled={!onPick}
            >
              {o.name || o.orgId}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
