/**
 * Campaign Studio full-screen editor route (ADR 0310 Phase C — the elements
 * trait's multi-collection consumer). Channels / funnel / assets lists + doc
 * strategy fields over the shared `CanvasEditorPage`; the campaign renders
 * through the ONE `CampaignContentView`. Reached at `/campaign-studio/plans/:canvasId`,
 * or `/campaign-studio/plans/new?fromArtifact=<runId:nodeId>` from a campaign chat
 * card (ADR 0941 D5; the old one-segment path redirects).
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { campaignStudioDefinition } from './definition.js';

export function CampaignStudioEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={campaignStudioDefinition} />;
}
