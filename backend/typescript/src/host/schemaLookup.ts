/**
 * The ONE schema-lookup implementation (ADR 0785 P3 extraction). Two model-facing
 * lanes ask the app for the schemas it enforces:
 *   - the chat tool `openwop:schema.lookup` (host/agentToolProvider.ts), and
 *   - the MCP tool `claude-code-schema-lookup` (features/claude-code).
 * Both call THIS, so the answer a chat agent gets and the answer Claude Code gets
 * cannot drift (CLAUDE.md, "AI↔app information exchange": schema text reaching a
 * model is generated from its SSoT). Read-only and tenant-independent: all three
 * registries are host-global.
 */
export type SchemaLookupResult =
  | { ok: true; value: unknown }
  | { ok: false; error: 'validation_error'; message: string };

export async function lookupAppSchemas(input: Record<string, unknown>): Promise<SchemaLookupResult> {
  const kind = String(input.kind ?? '');
  if (kind === 'node') {
    const names = Array.isArray(input.names) ? input.names.filter((n): n is string => typeof n === 'string') : [];
    if (!names.length) return { ok: false, error: 'validation_error', message: 'kind "node" needs names[] (node typeIds).' };
    const { buildSchemaResponse } = await import('./schemaResponder.js');
    return { ok: true, value: buildSchemaResponse({ names }) };
  }
  if (kind === 'canvas-component') {
    const canvasTypeId = typeof input.canvasTypeId === 'string' ? input.canvasTypeId : '';
    if (!canvasTypeId) return { ok: false, error: 'validation_error', message: 'kind "canvas-component" needs canvasTypeId.' };
    const { listCanvasComponents, catalogPromptSchema } = await import('./canvasComponentCatalog.js');
    return { ok: true, value: { canvasTypeId, components: listCanvasComponents(canvasTypeId), promptSchema: catalogPromptSchema(canvasTypeId) } };
  }
  if (kind === 'artifact-type') {
    const { listArtifactTypes, getArtifactType } = await import('./artifactTypes.js');
    const names = Array.isArray(input.names) ? input.names.filter((n): n is string => typeof n === 'string') : [];
    if (names.length) {
      const found = names.map((n) => {
        const t = getArtifactType(n);
        return t ? { artifactTypeId: t.artifactTypeId, title: t.title, schema: t.schema } : { artifactTypeId: n, notFound: true };
      });
      return { ok: true, value: { artifactTypes: found } };
    }
    return { ok: true, value: { artifactTypes: listArtifactTypes().map((t) => ({ artifactTypeId: t.artifactTypeId, title: t.title })) } };
  }
  return { ok: false, error: 'validation_error', message: `unknown kind '${kind}'.` };
}
