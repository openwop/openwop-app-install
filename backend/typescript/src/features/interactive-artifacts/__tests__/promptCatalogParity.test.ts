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
 *
 * Closed world, both directions (grade-tests wave 27): the prompt's offered list is
 * EXTRACTED from the prompt's own "`chartType` is …" sentence and checked against the
 * renderer's `SUPPORTED_CHART_TYPES`, so ANY phantom (`heatmap`, `bubble`, …) reds —
 * not only the five on the old hand list, which an unlisted phantom slipped past.
 * Red if: `SUPPORTED_CHART_TYPES` gains a type (`w27g2-pcp-renderer-adds-pie`), the
 * prompt drops the sentence or offers an unsupported type (`pcp-prompt-*`), or the
 * schema enum opens / widens (`pcp-schema-*`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { INTERACTIVE_ARTIFACT_TYPES, registerInteractiveArtifactTypes } from '../artifactTypes.js';
import { validateArtifact } from '../../../host/artifactTypes.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, '../../../../../../packs/vendor.openwop-app.interactive-artifacts.agents/prompts/visualizer.md');
const rendererPath = join(here, '../../../../../../frontend/react/src/chat/artifacts/ChartRenderer.tsx');

function rendererSupportedTypes(): string[] {
  const src = readFileSync(rendererPath, 'utf8');
  const m = src.match(/SUPPORTED_CHART_TYPES[^=]*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('ChartRenderer no longer declares SUPPORTED_CHART_TYPES — update this parity test');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The chartTypes the prompt OFFERS: every backticked token in its "`chartType` is …"
 *  clause (up to the first `;`, `)` or line break). Derived from the prompt itself, so the check is closed-world. */
function promptOfferedTypes(prompt: string): string[] {
  const marker = '`chartType` is';
  const at = prompt.indexOf(marker);
  if (at === -1) throw new Error('visualizer prompt no longer states the chartType closed world — update this parity test');
  const clause = prompt.slice(at + marker.length).split(/[;)\n]/)[0]!;
  return [...clause.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
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
    const offered = promptOfferedTypes(prompt);
    // non-vacuity: the extractor found the sentence's list (an empty list passes any `toContain` loop)
    expect(offered.length, 'the extractor found no offered chartTypes').toBeGreaterThan(0);
    for (const t of offered) {
      expect(supported, `prompt offers chartType '${t}', which the renderer dumps as raw JSON`).toContain(t);
    }
    // A phantom mentioned ANYWHERE else in the prompt (outside that sentence) still reds.
    for (const phantom of ['pie', 'scatter', 'area', 'donut', 'radar']) {
      expect(prompt, `prompt must not claim unsupported chartType '${phantom}'`).not.toContain(`\`${phantom}\``);
    }
  });
});

describe('ADR 0708 D2 — artifact SCHEMA ↔ ChartRenderer chartType parity', () => {
  const supported = rendererSupportedTypes();
  const chart = INTERACTIVE_ARTIFACT_TYPES.find((t) => t.artifactTypeId === 'interactive.chart');

  it('the schema enum EQUALS the renderer closed world, both ways', () => {
    const props = (chart?.schema as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties;
    // the schema declares a CLOSED world (not an open string) — folded in from its own case
    expect(props?.chartType?.enum, 'an open `type: string` lets any emitter persist an unrenderable chart').toBeDefined();
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
