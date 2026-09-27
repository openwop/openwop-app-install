/**
 * XCH-IA-1 (LLM-EXCHANGE-AUDIT Wave 3): the Visualizer prompt tells the model
 * `chartType` is `bar` or `line`, because that is what the frontend ChartRenderer
 * actually renders (anything else falls back to a raw <pre>). The prompt and the
 * renderer lived in different trees with nothing pinning them. Pin both ways:
 * every renderer-supported type is offered to the model, and the prompt
 * claims no type the renderer would dump as raw JSON.
 *
 * CORRECTED (ADR 0708 D2) — this used to say the prompt was "deliberately TIGHTER
 * than the OPEN artifact schema". That was true and is no longer: the schema was
 * `chartType: { type: 'string' }`, so the closed world was enforced on the PROMPT
 * lane only and any other emitter could persist an unrenderable chart. The enum now
 * lives in the artifact type too, so all three sides are pinned — prompt ↔ renderer
 * (below) and SCHEMA ↔ renderer (the third describe). Leaving the old sentence would
 * have left a false current-state claim in the very file that exists to stop drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { INTERACTIVE_ARTIFACT_TYPES, registerInteractiveArtifactTypes } from '../artifactTypes.js';
import { validateArtifact } from '../../../host/artifactTypes.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, '../../../../../../packs/feature.interactive-artifacts.agents/prompts/visualizer.md');
const rendererPath = join(here, '../../../../../../frontend/react/src/chat/artifacts/ChartRenderer.tsx');

function rendererSupportedTypes(): string[] {
  const src = readFileSync(rendererPath, 'utf8');
  const m = src.match(/SUPPORTED_CHART_TYPES[^=]*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('ChartRenderer no longer declares SUPPORTED_CHART_TYPES — update this parity test');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('visualizer prompt ↔ ChartRenderer chartType parity (XCH-IA-1)', () => {
  const prompt = readFileSync(promptPath, 'utf8');
  const supported = rendererSupportedTypes();

  it('extracted the renderer closed world', () => {
    expect(supported).toEqual(['bar', 'line']);
  });

  it('offers every renderer-supported chartType to the model', () => {
    for (const t of supported) {
      expect(prompt, `prompt must offer chartType '${t}'`).toContain(`\`${t}\``);
    }
  });

  it('claims no chartType the renderer would dump as raw JSON', () => {
    for (const phantom of ['pie', 'scatter', 'area', 'donut', 'radar']) {
      expect(prompt, `prompt must not claim unsupported chartType '${phantom}'`).not.toContain(`\`${phantom}\``);
    }
  });
});

describe('ADR 0708 D2 — artifact SCHEMA ↔ ChartRenderer chartType parity', () => {
  const supported = rendererSupportedTypes();
  const chart = INTERACTIVE_ARTIFACT_TYPES.find((t) => t.artifactTypeId === 'interactive.chart');

  it('the chart schema declares a CLOSED world (not an open string)', () => {
    const props = (chart?.schema as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties;
    expect(props?.chartType?.enum, 'an open `type: string` lets any emitter persist an unrenderable chart').toBeDefined();
  });

  it('the schema enum EQUALS the renderer closed world, both ways', () => {
    const props = (chart?.schema as { properties?: Record<string, { enum?: unknown[] }> }).properties;
    expect([...(props!.chartType!.enum as string[])].sort()).toEqual([...supported].sort());
  });

  it('a chartType the renderer cannot draw FAILS validation (the gate is real, not decorative)', () => {
    registerInteractiveArtifactTypes();
    const bad = validateArtifact('interactive.chart', { chartType: 'pie', data: {} });
    expect(bad.valid, 'an unsupported chartType must not persist as a valid typed chart').toBe(false);
    const good = validateArtifact('interactive.chart', { chartType: 'bar', data: {} });
    expect(good.valid, 'a supported one still validates — the enum must not be a blanket refusal').toBe(true);
  });
});
