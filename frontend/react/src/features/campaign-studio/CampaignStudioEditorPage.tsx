/**
 * Campaign Studio full-screen editor route (ADR 0310 Phase C — the elements
 * trait's multi-collection consumer). Channels / funnel / assets lists + doc
 * strategy fields over the shared `CanvasEditorPage`; the campaign renders
 * through the ONE `CampaignContentView`. Reached at `/campaign-studio/:canvasId`,
 * or `/campaign-studio/new?fromArtifact=<runId:nodeId>` from a campaign chat card.
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { campaignStudioDefinition } from './definition.js';

export function CampaignStudioEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={campaignStudioDefinition} />;
}
