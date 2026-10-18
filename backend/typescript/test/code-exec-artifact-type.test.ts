/**
 * ADR 0114 Phase 4a — code.execution-result artifact type.
 *
 * The chat code tool (`agentToolProvider.ts` CODE_EXEC) and the node (`packs/feature.code-exec.nodes`)
 * both persist/project a `code.execution-result` artifact; the chat path relies on this schema's
 * `required` list and `additionalProperties:false`. Breaks if the type is unregistered or its schema
 * loosens/drifts — the Library would accept (or fail to validate) malformed execution results.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerCodeExecArtifactType } from '../src/features/code-exec/artifactTypes.js';
import { getArtifactType, isRegisteredArtifactType, validateArtifact } from '../src/host/artifactTypes.js';

const OK = { exitCode: 0, stdout: '4\n', stderr: '', language: 'python', files: [] } as const;

beforeAll(() => { registerCodeExecArtifactType(); });

describe('code.execution-result artifact type', () => {
  it('is registered', () => {
    expect(isRegisteredArtifactType('code.execution-result')).toBe(true);
    expect(getArtifactType('code.execution-result')?.title).toBe('Code execution result');
  });
  it('validates a conforming execution result', () => {
    expect(validateArtifact('code.execution-result', { ...OK }).valid).toBe(true);
  });
  it.each(['exitCode', 'stdout', 'stderr'] as const)('rejects a result missing required fields: %s', (field) => {
    const partial: Record<string, unknown> = { ...OK };
    delete partial[field];
    expect(validateArtifact('code.execution-result', partial).valid).toBe(false);
  });
  it('rejects a stray field (additionalProperties:false)', () => {
    expect(validateArtifact('code.execution-result', { ...OK, extra: 1 }).valid).toBe(false);
  });
});
