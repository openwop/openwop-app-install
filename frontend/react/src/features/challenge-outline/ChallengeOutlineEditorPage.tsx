/**
 * Challenge-outline full-screen editor route (ADR 0458 §2.3). The whole editor
 * — day outline tree, per-node property panel, doc-level meta/outcomes/
 * achievements widgets, bounded undo/redo, optimistic-concurrency saves — is the
 * canvas framework's `CanvasEditorPage`, driven by the typed
 * `challengeOutlineDefinition`.
 *
 * Reached at `/challenge-outline/:canvasId`, opened from a candidate's workspace
 * ("Open outline"), which ensures the per-candidate canvas first.
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { challengeOutlineDefinition } from './definition.js';

export function ChallengeOutlineEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={challengeOutlineDefinition} />;
}
