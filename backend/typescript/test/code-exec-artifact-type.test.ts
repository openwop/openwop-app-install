/**
 * ADR 0114 Phase 4a — code.execution-result artifact type.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerCodeExecArtifactType } from '../src/features/code-exec/artifactTypes.js';
import { getArtifactType, isRegisteredArtifactType, validateArtifact } from '../src/host/artifactTypes.js';

beforeAll(() => { registerCodeExecArtifactType(); });

describe('code.execution-result artifact type', () => {
  it('is registered', () => {
    expect(isRegisteredArtifactType('code.execution-result')).toBe(true);
    expect(getArtifactType('code.execution-result')?.title).toBe('Code execution result');
  });
  it('validates a conforming execution result', () => {
    expect(validateArtifact('code.execution-result', { exitCode: 0, stdout: '4\n', stderr: '', language: 'python', files: [] }).valid).toBe(true);
  });
  it('rejects a result missing required fields', () => {
    expect(validateArtifact('code.execution-result', { stdout: 'x' }).valid).toBe(false); // missing exitCode/stderr
  });
});
