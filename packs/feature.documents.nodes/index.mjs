/**
 * feature.documents.nodes — Documents read + agentic-write nodes over the
 * `ctx.features.documents` surface (ADR 0053 / ADR 0014). All role:"action" so the
 * engine records outputs and replay/fork read the recorded result rather than
 * re-querying / re-generating. Pure-JS, Node-20 stdlib only.
 *
 * Generation is run-scoped: generate-from-template assembles the template (no LLM),
 * calls ctx.callAI to draft the content, then persists via createDocument/addVersion
 * with a deterministic idempotency key so a replay/fork reuses the same version.
 * Output is validated only against the template-owned outputSchema (artifact-types
 * RFC 0071/0075 are NOT implemented in this host — no typed artifact.created).
 */

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
    model: str(i.model) || 'claude-sonnet-4-6',
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
  //    idempotency key off the run/node so a replay/fork reuses the same rows.
  const idem = `${ctx.runId ?? 'run'}:${ctx.nodeId ?? 'gen'}`;
  const created = await documents.createDocument({
    orgId,
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
    artifact = { artifactTypeId, documentId, versionId: `${documentId}:${versioned.version}`, registered: !!v.registered, registrationSource: v.registrationSource, valid: !!v.valid, payload };
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
