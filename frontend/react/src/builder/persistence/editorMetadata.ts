/** Host-owned editor state inside the canonical customProperties extension slot.
 * Names/author text only: never resolve a credential ref or materialize a key. */
export const BUILDER_EDITOR_METADATA_CONFLICT = 'builder_editor_metadata_conflict';
const EDITOR_NAMESPACE = 'openwop-app.builder';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class BuilderEditorMetadataError extends Error {
  readonly reason = BUILDER_EDITOR_METADATA_CONFLICT;
  constructor(message = 'Workflow editor metadata has an incompatible format.') {
    super(message);
    this.name = 'BuilderEditorMetadataError';
  }
}

/** A passive read never rewrites malformed/foreign metadata. Blank is a value. */
export function builderDefaultInputsFromMetadata(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.customProperties)) return undefined;
  const editor = metadata.customProperties[EDITOR_NAMESPACE];
  return isRecord(editor) && typeof editor.defaultInputs === 'string' ? editor.defaultInputs : undefined;
}

/** Preserve unknown siblings; refuse an occupied incompatible reserved slot.
 * Raw editor text deliberately does not require valid JSON until Run. */
export function withBuilderDefaultInputs(metadata: Record<string, unknown>, raw: string): Record<string, unknown> {
  const properties = metadata.customProperties;
  if (properties !== undefined && !isRecord(properties)) throw new BuilderEditorMetadataError();
  const customProperties = properties ?? {};
  const occupied = customProperties[EDITOR_NAMESPACE];
  if (occupied !== undefined && !isRecord(occupied)) throw new BuilderEditorMetadataError();
  const editor = occupied ?? {};
  if (Object.hasOwn(editor, 'defaultInputs') && typeof editor.defaultInputs !== 'string') throw new BuilderEditorMetadataError();
  return { ...metadata, customProperties: { ...customProperties, [EDITOR_NAMESPACE]: { ...editor, defaultInputs: raw } } };
}
