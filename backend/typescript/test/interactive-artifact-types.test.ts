/**
 * ADR 0128 Phase 1 + IART-3 — the four interactive types register, and the raw-text
 * kinds (html / mermaid / react) validate STRINGS only; chart validates an object.
 * Red if a type stops registering (an unregistered type validates `valid:true`, so the
 * negatives below would pass vacuously — the registration case guards that), or a schema
 * reopens to objects / drops chart's required `data` (`w27g2-iat-*` probes).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerInteractiveArtifactTypes } from '../src/features/interactive-artifacts/artifactTypes.js';
import { getArtifactType, isRegisteredArtifactType, validateArtifact } from '../src/host/artifactTypes.js';

beforeAll(() => { registerInteractiveArtifactTypes(); });

describe('interactive artifact types', () => {
  it('registers all four types', () => {
    for (const id of ['interactive.html', 'interactive.react', 'interactive.mermaid', 'interactive.chart']) {
      expect(isRegisteredArtifactType(id)).toBe(true);
      expect(getArtifactType(id)).toBeDefined();
    }
  });

  // IART-3: html/mermaid/react carry RAW TEXT (HTML body / mermaid source / JSX), so the
  // payload is a STRING — the prior object schemas never matched the actual emitted payloads.
  it('validates a raw-string html payload + rejects a non-string', () => {
    expect(validateArtifact('interactive.html', '<p>hi</p>').valid).toBe(true);
    expect(validateArtifact('interactive.html', { html: '<p>x</p>' }).valid).toBe(false); // an object is NOT the contract
    expect(validateArtifact('interactive.html', 42).valid).toBe(false);                   // non-string rejected
  });

  it('validates mermaid (string) + chart (object) payloads', () => {
    expect(validateArtifact('interactive.mermaid', 'graph TD; A-->B').valid).toBe(true);
    expect(validateArtifact('interactive.mermaid', {}).valid).toBe(false); // object is not the raw-text contract
    expect(validateArtifact('interactive.react', 'const A = () => <div/>;').valid).toBe(true);
    expect(validateArtifact('interactive.react', { jsx: 'x' }).valid).toBe(false); // IART-3: react is raw JSX text too
    expect(validateArtifact('interactive.chart', { chartType: 'bar', data: { labels: [], datasets: [] } }).valid).toBe(true);
    expect(validateArtifact('interactive.chart', { chartType: 'bar' }).valid).toBe(false); // missing data
  });
});
