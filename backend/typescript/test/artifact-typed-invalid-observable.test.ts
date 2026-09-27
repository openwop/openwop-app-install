/**
 * ADR 0708 D1 — a typed artifact that fails schema validation is DOWNGRADED to an
 * untyped blob, and that downgrade used to be SILENT.
 *
 * The downgrade itself is deliberate ("rather than minting a typed artifact that can't
 * render"). Its silence was not: nothing reached the model, the operator, or the logs.
 * Two facts made it a defect rather than a preference —
 *   - the SIBLING branch in the same function already logs
 *     (`run_artifact_typed_too_large`) for the same class, and
 *   - `validateArtifact` had ALREADY computed the Ajv messages the call site discarded.
 *
 * BORN RED: before the fix, removing the log changed nothing observable — there was no
 * witness at all, which is why this file exists rather than an assertion bolted onto a
 * neighbouring suite.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerInteractiveArtifactTypes } from '../src/features/interactive-artifacts/artifactTypes.js';
import { validateArtifact } from '../src/host/artifactTypes.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const codeOf = (p: string): string =>
  readFileSync(p, 'utf8').split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');

beforeAll(() => registerInteractiveArtifactTypes());

describe('ADR 0708 D1 — the typed-validation rejection is OBSERVABLE', () => {
  it('leg 1: the errors the call site needs are really produced (not an empty gesture)', () => {
    const bad = validateArtifact('interactive.chart', { chartType: 'pie', data: {} });
    expect(bad.valid).toBe(false);
    expect(bad.errors, 'validateArtifact computes Ajv messages — the fix logs what already existed').toBeDefined();
    expect((bad.errors ?? []).length, 'at least one human-readable reason').toBeGreaterThan(0);
  });

  it('leg 2: the persist seam LOGS the rejection instead of returning null in silence', () => {
    const src = codeOf(join(SRC, 'host', 'runArtifactStore.ts'));
    expect(src, 'a bare `return null` on invalid is the silent downgrade').toMatch(/run_artifact_typed_invalid/);
    // And it must carry the reasons, not just the fact — a bare event name would make
    // the log present but useless, which is the shape this ADR is about.
    expect(src, 'the log must carry the validation errors').toMatch(/run_artifact_typed_invalid[\s\S]{0,160}errors/);
  });

  it('leg 3: it matches the sibling branch it was inconsistent with', () => {
    const src = codeOf(join(SRC, 'host', 'runArtifactStore.ts'));
    // Both "we decline to mint a typed artifact" branches must be observable. If the
    // size branch ever loses its log this leg should fail too — they stand together.
    expect(src, 'the size sibling still logs').toMatch(/run_artifact_typed_too_large/);
    expect(src, 'and so does the validation branch').toMatch(/run_artifact_typed_invalid/);
  });

  it('leg 4: a VALID typed payload is not logged as invalid (the gate discriminates)', () => {
    const good = validateArtifact('interactive.chart', { chartType: 'bar', data: {} });
    expect(good.valid, 'a supported chart still validates').toBe(true);
    expect(good.errors, 'and carries no errors to log').toBeUndefined();
  });
});
