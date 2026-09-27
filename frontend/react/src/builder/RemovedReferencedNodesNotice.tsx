/**
 * "This edit dropped a step your run history references" notice (ADR 0440 P2).
 *
 * Runs re-resolve their definition by id — there is no per-run snapshot
 * (ADR 0369). So deleting a node from a workflow that has already run leaves
 * that node's recorded outcomes unmappable: on `:fork` a side-effecting node
 * with no recorded outcome yields a typed `replay_source_missing` failure
 * rather than re-firing a side effect.
 *
 * The ADR originally proposed REFUSING such a save, mirroring the DELETE
 * route's `workflow_referenced` guard. A test (`fork-after-node-removed.test.ts`)
 * falsified the analogy: deleting a definition loses it for EVERY run with no
 * recourse, while this degrades ONE node and already fails closed. Refusing
 * would make an ordinary authoring action impossible — and the refusal would
 * arrive 1.5s after a keystroke, from an autosave the user never triggered,
 * with no way to satisfy it.
 *
 * So this informs rather than blocks. It is `variant="info"`, not `error`:
 * nothing failed, and the author may well intend the deletion. Contrast
 * `SyncFailureBanner`, which is an error because work is genuinely unsaved.
 */

import { useTranslation } from 'react-i18next';
import { useBuilderStore } from './store/builderStore.js';
import { Notice } from '../ui/Notice.js';

export function RemovedReferencedNodesNotice(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const removed = useBuilderStore((s) => s.removedReferencedNodeIds);

  if (removed.length === 0) return null;

  return (
    <Notice variant="info">
      <strong>{t('removedReferencedTitle', { count: removed.length })}</strong>
      <p className="u-fs-13 u-mt-4">
        {t('removedReferencedBody', { count: removed.length, ids: removed.join(', ') })}
      </p>
    </Notice>
  );
}
