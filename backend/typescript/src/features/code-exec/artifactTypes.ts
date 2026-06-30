/**
 * ADR 0114 Phase 4a — register the `code.execution-result` artifact type.
 *
 * A code-exec run's stdout/stderr/exitCode/files become a TYPED artifact (ADR
 * 0055), so they flow through the existing run-artifact producer + render in the
 * workbench/Library. This registers the type + schema; the producer wiring (mapping
 * the node output into the artifact) is Phase 4b. The execution output is
 * model/code-derived, so it is content-trust UNTRUSTED downstream.
 *
 * @see docs/adr/0114-sandboxed-code-execution-node.md
 */
import { registerArtifactType } from '../../host/artifactTypes.js';

export function registerCodeExecArtifactType(): void {
  registerArtifactType({
    artifactTypeId: 'code.execution-result',
    title: 'Code execution result',
    registrationSource: 'host',
    export: ['raw', 'json'],
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        exitCode: { type: 'number' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        timedOut: { type: 'boolean' },
        language: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, mimeType: { type: 'string' } },
            required: ['name', 'mimeType'],
            additionalProperties: true,
          },
        },
      },
      required: ['exitCode', 'stdout', 'stderr'],
      additionalProperties: false,
    },
  });
}
