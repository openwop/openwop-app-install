/**
 * feature.documents.nodes — Documents read + agentic-write nodes over the
 * `ctx.features.documents` surface (ADR 0053 / ADR 0014). Read nodes are
 * role:"action"; the two durable writers — generate-from-template and render —
 * declare role:"side-effect" so the ADR 0572 manifest-derived floor binds the
 * host (GEN-DOC-1: a durable writer declared "action" silently exits both
 * replay-protection legs). Pure-JS, Node-20 stdlib only.
 *
 * Generation is run-scoped: generate-from-template assembles the template (no
 * LLM), calls ctx.callAI to draft the content, then persists via
 * createDocument/addVersion with a deterministic document id AND idempotency
 * key derived from the run/node (WF-DOC-1 — the `surface.ts`
 * createDraftDocument pattern), so a resume/crash-replay of the SAME run
 * converges on the SAME document + version instead of minting duplicates.
 * A `:fork` mints a fresh runId and therefore — deliberately — its own
 * document (the fork-backstop posture: a fork is a new run, not a re-read
 * of the old one's rows). Output is validated
 * against the template-owned outputSchema; when the template binds a
 * registered host artifact type, a typed `artifact.created` run event is
 * emitted (RFC 0071 / ADR 0055 — see the correction note at the emit site).
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function ensureDocuments(ctx) {
  const documents = ctx.features && ctx.features.documents;
  if (!documents || typeof documents.assemble !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.documents — the Documents feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.documents' },
    );
  }
  return documents;
}

function ensureAi(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — generate-from-template requires aiProviders'),
      { code: 'host_capability_missing', capability: 'host.aiProviders' },
    );
  }
}

function str(v) { return typeof v === 'string' ? v : ''; }

export async function listDocuments(ctx) {
  const documents = ensureDocuments(ctx);
  const i = ctx.inputs ?? {};
  const out = await documents.listDocuments({ orgId: str(i.orgId), ...(i.kind ? { kind: str(i.kind) } : {}) });
  return { status: 'success', outputs: { documents: out.documents ?? [] } };
}

export async function listTemplates(ctx) {
  const documents = ensureDocuments(ctx);
  const i = ctx.inputs ?? {};
  const out = await documents.listTemplates({ orgId: str(i.orgId), ...(i.kind ? { kind: str(i.kind) } : {}) });
  return { status: 'success', outputs: { templates: out.templates ?? [] } };
}

export async function getTemplate(ctx) {
  const documents = ensureDocuments(ctx);
  const i = ctx.inputs ?? {};
  const out = await documents.getTemplate({ orgId: str(i.orgId), templateId: str(i.templateId) });
  return { status: 'success', outputs: { template: out.template ?? null } };
}

export async function getDocument(ctx) {
  const documents = ensureDocuments(ctx);
  const i = ctx.inputs ?? {};
  const out = await documents.getDocument({ orgId: str(i.orgId), documentId: str(i.documentId) });
  return { status: 'success', outputs: { document: out.document ?? null } };
}

export async function assemble(ctx) {
  const documents = ensureDocuments(ctx);
  const i = ctx.inputs ?? {};
  const result = await documents.assemble({ orgId: str(i.orgId), templateId: str(i.templateId), params: i.params ?? {} });
  return { status: 'success', outputs: result };
}

export async function generateFromTemplate(ctx) {
  const documents = ensureDocuments(ctx);
  ensureAi(ctx);
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const templateId = str(i.templateId);

  // 1) Assemble (validate + render) — no LLM.
  const asm = await documents.assemble({ orgId, templateId, params: i.params ?? {} });

  // 2) Draft the content with the run-scoped provider.
  const ai = await ctx.callAI({
    provider: str(i.provider) || 'anthropic',
    model: str(i.model) || DEFAULT_MODEL,
    systemPrompt: 'You are a precise business-document author. Produce the requested document in clean Markdown. Output only the document body.',
    messages: [{ role: 'user', content: asm.augmentedPrompt }],
    ...(asm.outputSchema ? { responseSchema: asm.outputSchema } : {}),
    ...(i.maxTokens ? { maxTokens: Number(i.maxTokens) } : {}),
  });
  const content = typeof ai.content === 'string' && ai.content.length > 0
    ? ai.content
    : (ai.data !== undefined ? JSON.stringify(ai.data, null, 2) : '');
  if (!content) return { status: 'failed', error: { code: 'generation_empty', message: 'The provider returned no content.' } };

  // 3) Persist — create the document, then an immutable version. Deterministic
  //    DOCUMENT ID + idempotency key off the run/node (the surface
  //    createDraftDocument pattern): createDocument short-circuits on the prior
  //    row and addVersion dedupes on the key, so a resume/crash-replay of the
  //    SAME run reuses the SAME rows. A `:fork` carries a fresh runId, so it
  //    mints its OWN document — deliberate (fork-backstop): a fork is a new
  //    run, not a re-read of the old one's rows. WF-DOC-1: without the id, the
  //    service minted `doc:${randomUUID()}` per execution, so even a same-run
  //    re-execution produced a 2nd document + 2nd version.
  const idem = `${ctx.runId ?? 'run'}:${ctx.nodeId ?? 'gen'}`;
  const created = await documents.createDocument({
    orgId,
    documentId: `doc:${idem}`,
    title: str(i.title) || `${str(i.kind) || 'document'} (generated)`,
    kind: str(i.kind) || 'doc',
    format: asm.outputFormat || 'markdown',
    templateId,
    ...(i.ownerSubject ? { ownerSubject: i.ownerSubject } : {}),
  });
  const documentId = created.document && created.document.documentId;
  const versioned = await documents.addVersion({ orgId, documentId, content, idempotencyKey: idem });

  // 4) ADR 0055 — if the template binds a host artifact type, validate the artifact
  //    payload and emit a typed `artifact.created` run event (RFC 0071). Best-effort:
  //    a host without ctx.emit / validateArtifact still produces the document.
  let artifact = null;
  const artifactTypeId = str(asm.artifactTypeId);
  if (artifactTypeId && typeof documents.validateArtifact === 'function') {
    const payload = { content, title: created.document && created.document.title, kind: str(i.kind) || 'doc', documentId };
    const v = await documents.validateArtifact({ artifactTypeId, payload });
    const versionId = `${documentId}:${versioned.version}`;
    // RFC 0071 — the emitted payload MUST satisfy `run-event-payloads.schema.json`
    // §artifactCreated, whose REQUIRED fields are `artifactId` + `artifactType`.
    // CORRECTION 2026-08-10: this emitted `artifactTypeId` and neither required
    // field, so every `artifact.created` this host ever produced was off-contract.
    // It went unnoticed because the in-repo test asserted `payload.artifactTypeId`
    // — the shape the code emitted — instead of the shape the SCHEMA requires; the
    // RFC 0142 leg-B witness caught it on its first real run.
    // `artifactTypeId` is retained as a deprecated alias: internal readers use it,
    // and §artifactCreated is `additionalProperties: true`.
    artifact = {
      artifactId: versionId,
      artifactType: artifactTypeId,
      artifactTypeId,
      documentId,
      versionId,
      registered: !!v.registered,
      registrationSource: v.registrationSource,
      valid: !!v.valid,
      payload,
    };
    if (typeof ctx.emit === 'function') await ctx.emit('artifact.created', artifact);
  }

  return { status: 'success', outputs: { document: created.document, version: versioned.version, ...(artifact ? { artifact } : {}) } };
}

export async function renderDocument(ctx) {
  const documents = ensureDocuments(ctx);
  const i = ctx.inputs ?? {};
  const out = await documents.render({ orgId: str(i.orgId), documentId: str(i.documentId), format: str(i.format) || 'pdf' });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.documents.nodes.list-documents': listDocuments,
  'feature.documents.nodes.list-templates': listTemplates,
  'feature.documents.nodes.get-template': getTemplate,
  'feature.documents.nodes.get-document': getDocument,
  'feature.documents.nodes.assemble': assemble,
  'feature.documents.nodes.generate-from-template': generateFromTemplate,
  'feature.documents.nodes.render': renderDocument,
};

export default nodes;
