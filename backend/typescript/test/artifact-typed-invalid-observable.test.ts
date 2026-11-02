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
 *
 * TST-BZD-23 (grade-tests w66). Red when the invalid branch of `detectTypedArtifact` stops
 * logging, logs WITHOUT the validation errors, or logs only on a path that never runs.
 * Legs 2–4 drive the REAL function through the real sink (`process.stdout.write`, the
 * `adr0900-log-reason-code` pattern); the earlier source-regex legs could not tell a log
 * that fires from one that is dead code or carries `errors: []`. Leg 3 keeps ONE source
 * check — that the size sibling still logs — because that branch needs a >cap payload
 * through `persistRunArtifact` and its pairing is a structural claim.
 */
import { afterEach, describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerInteractiveArtifactTypes } from '../src/features/interactive-artifacts/artifactTypes.js';
import { validateArtifact } from '../src/host/artifactTypes.js';
import { detectTypedArtifact } from '../src/host/runArtifactStore.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const codeOf = (p: string): string =>
  readFileSync(p, 'utf8').split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');

/** Run `fn` with stdout captured; return its result and the parsed `run_artifact_typed_invalid` lines. */
function withCapturedLog<T>(fn: () => T): { result: T; invalidLines: Array<Record<string, unknown>> } {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
  let result: T;
  try { result = fn(); } finally { vi.restoreAllMocks(); }
  const invalidLines = lines
    .flatMap((l) => l.split('\n'))
    .filter((l) => l.includes('"msg":"run_artifact_typed_invalid"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { result, invalidLines };
}

beforeAll(() => registerInteractiveArtifactTypes());
afterEach(() => { vi.restoreAllMocks(); });

const invalidEnvelope = { artifact: { artifactTypeId: 'interactive.chart', payload: { chartType: 'pie', data: {} } } };
// ADR 1017 D5 — a valid chart now needs a dataset; `data: {}` is no longer the valid control.
const validEnvelope = { artifact: { artifactTypeId: 'interactive.chart', payload: { chartType: 'bar', data: { labels: ['a'], datasets: [{ label: 's', data: [1] }] } } } };

describe('ADR 0708 D1 — the typed-validation rejection is OBSERVABLE', () => {
  it('leg 1: the errors the call site needs are really produced (not an empty gesture)', () => {
    const bad = validateArtifact('interactive.chart', { chartType: 'pie', data: {} });
    expect(bad.valid).toBe(false);
    expect(bad.errors, 'validateArtifact computes Ajv messages — the fix logs what already existed').toBeDefined();
    expect((bad.errors ?? []).length, 'at least one human-readable reason').toBeGreaterThan(0);
  });

  it('leg 2: the persist seam LOGS the rejection instead of returning null in silence', () => {
    const { result, invalidLines } = withCapturedLog(() => detectTypedArtifact(invalidEnvelope, 'chart-node'));
    expect(result, 'the invalid typed payload is downgraded (not minted)').toBeNull();
    expect(invalidLines, 'exactly one run_artifact_typed_invalid line').toHaveLength(1);
    const line = invalidLines[0]!;
    expect(line['level']).toBe('warn');
    expect(line['artifactTypeId']).toBe('interactive.chart');
    expect(line['nodeId']).toBe('chart-node');
    // The log must carry the reasons, not just the fact.
    expect(Array.isArray(line['errors']) && (line['errors'] as unknown[]).length > 0, `errors carried: ${JSON.stringify(line['errors'])}`).toBe(true);
  });

  it('leg 3: it matches the sibling branch it was inconsistent with', () => {
    const src = codeOf(join(SRC, 'host', 'runArtifactStore.ts'));
    // Both "we decline to mint a typed artifact" branches must be observable.
    expect(src, 'the size sibling still logs').toMatch(/run_artifact_typed_too_large/);
    // …and the validation branch logs at RUNTIME, not merely in the source.
    expect(withCapturedLog(() => detectTypedArtifact(invalidEnvelope, 'n3')).invalidLines, 'and so does the validation branch').toHaveLength(1);
  });

  it('leg 4: a VALID typed payload is not logged as invalid (the gate discriminates)', () => {
    const good = validateArtifact('interactive.chart', { chartType: 'bar', data: { labels: ['a'], datasets: [{ label: 's', data: [1] }] } });
    expect(good.valid, 'a supported chart still validates').toBe(true);
    expect(good.errors, 'and carries no errors to log').toBeUndefined();
    const { result, invalidLines } = withCapturedLog(() => detectTypedArtifact(validEnvelope, 'n4'));
    expect(result?.artifactTypeId, 'a valid typed payload is minted').toBe('interactive.chart');
    expect(invalidLines).toEqual([]);
  });
});
