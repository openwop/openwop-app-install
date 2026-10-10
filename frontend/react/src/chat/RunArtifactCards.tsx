/**
 * ADR 0768 follow-up B3 — a completed run's DURABLE outputs as cards in the
 * thread, each opening in the Workbench.
 *
 * The completion card's "View" links derive terminal nodes from the locally
 * cached graph, so a workflow saved on another device lists nothing. The run's
 * artifacts are server rows (`?runId=`, ADR 0768 A2), so they list everywhere
 * the caller may read them — the filter is never wider than `GET /artifacts/:id`.
 *
 * Deliberately absent (design B3 v2): a renderer thumbnail and a "+N −M" diff
 * badge. Neither has a server source yet; drawing them would be a guess.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTextIcon } from '../ui/icons/index.js';
import { Button } from '../ui/Button.js';
import type { ArtifactProjection } from './artifacts/artifactClient.js';

export type RunArtifact = ArtifactProjection & { runNodeId: string };
export type RunArtifactsState =
  | { status: 'idle' | 'loading' | 'failed' }
  | { status: 'ready'; items: RunArtifact[] };

/** The run's artifacts; `idle` when not asked for (no Workbench, or no run id).
 *  A failed read is its own state, never an empty list. */
export function useRunArtifacts(runId: string | null | undefined, enabled: boolean): RunArtifactsState {
  const [state, setState] = useState<RunArtifactsState>({ status: 'idle' });
  useEffect(() => {
    if (!enabled || !runId) { setState({ status: 'idle' }); return undefined; }
    let live = true;
    setState({ status: 'loading' });
    // Loaded on demand: the artifact client must not ride the feed's entry chunk.
    void import('./artifacts/artifactClient.js')
      .then((m) => m.listRunArtifacts(runId))
      .then(
        (items) => { if (live) setState({ status: 'ready', items }); },
        () => { if (live) setState({ status: 'failed' }); },
      );
    return () => { live = false; };
  }, [runId, enabled]);
  return state;
}

export function RunArtifactCards({ items, onOpen }: {
  items: readonly RunArtifact[];
  onOpen: (a: { artifactId: string }) => void;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (items.length === 0) return null;
  return (
    <ul className="run-artifacts" aria-label={t('runArtifactsLabel')}>
      {items.map((a) => (
        <li key={a.artifactId}>
          <Button variant="secondary" className="run-artifact-card" onClick={() => onOpen({ artifactId: a.artifactId })}>
            <FileTextIcon size={16} />
            <span className="run-artifact-text">
              <span className="run-artifact-title">{a.title}</span>
              <span className="run-artifact-meta">{[a.kind, a.format].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="run-artifact-open">{t('openInWorkbench')}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
