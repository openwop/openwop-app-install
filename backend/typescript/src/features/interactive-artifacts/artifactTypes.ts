/**
 * ADR 0128 Phase 1 — register the interactive artifact TYPES (html/react/mermaid/
 * chart) in the ADR 0055 registry. THIS PHASE REGISTERS TYPES ONLY — there is no
 * renderer yet (the CSP-sandboxed canvas is Phase 2, the load-bearing security
 * piece requiring /architect + /browser). So an artifact tagged with these types
 * VALIDATES + persists, but the workbench falls back to raw until Phase 2 — honest:
 * the live-render capability is NOT advertised until the renderer is wired.
 *
 * @see docs/adr/0128-interactive-artifacts-canvas.md
 */
import { registerArtifactType, type ArtifactType } from '../../host/artifactTypes.js';

const obj = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: props, required, additionalProperties: false,
});

// IART-3: the schemas now MATCH the real content contract (the node pack + the workbench
// renderers). html/mermaid/react carry RAW TEXT (the HTML body / mermaid source / JSX), so
// their payload is a STRING; chart carries the `{chartType,data,options}` spec, so it stays
// an object. (The prior object schemas for html/mermaid/react never matched the emitted
// payloads — validation was dead; this makes validateArtifact meaningful in detectTypedArtifact
// AND in documents/surface.ts.)
const rawText = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' as const };

export const INTERACTIVE_ARTIFACT_TYPES: ArtifactType[] = [
  { artifactTypeId: 'interactive.html', title: 'Interactive HTML', registrationSource: 'host', export: ['html', 'raw'],
    schema: rawText },
  { artifactTypeId: 'interactive.react', title: 'Interactive React component', registrationSource: 'host', export: ['raw'],
    schema: rawText },
  { artifactTypeId: 'interactive.mermaid', title: 'Mermaid diagram', registrationSource: 'host', export: ['raw', 'svg'],
    schema: rawText },
  { artifactTypeId: 'interactive.chart', title: 'Chart', registrationSource: 'host', export: ['raw', 'json'],
    schema: obj({ chartType: { type: 'string' }, data: { type: 'object' }, options: { type: 'object' } }, ['chartType', 'data']) },
];

export function registerInteractiveArtifactTypes(): void {
  for (const t of INTERACTIVE_ARTIFACT_TYPES) registerArtifactType(t);
}
