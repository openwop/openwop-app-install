/**
 * A6 (chat-first port) — igniting the orphaned `exportConversationAsDocument`
 * helper (ADR 0119 Phase 3) as a conversational tool:
 * `openwop:conversations.export-document`.
 *
 * "Save this conversation as a document." The helper already composes the ONE
 * documents owner (no new store); this tool is the missing agent-facing igniter.
 * It defaults to the CURRENT conversation (`scope.conversationId` — unforgeable,
 * never a tool input) and calls the SAME read helper the HTTP export route calls
 * (`access.ts` `authorizeConversationRead`, ADR 0992 D8) so an agent can never
 * export a conversation its acting user cannot read — a mismatch folds to a
 * uniform `not_found` (no existence leak). A Document is org-readable, so the tool
 * also refuses a conversation that is not the user's alone (`shared_conversation`,
 * `client_mismatch`). CORRECTED (ADR 0992): the description said "It never
 * publishes or shares"; every org member can read the draft, and it now says so. The write target is a Document, so
 * the tool is gated on the `documents` toggle exactly like `documents.draft`.
 *
 * Allowlist placement (the ADR 0315 baseline decision): NOT added to the
 * default-on baseline. That set is a deliberately minimal, universal "draft a
 * thing" surface offered to EVERY agent; conversation-transcript record-keeping
 * is a persona-specific need (a chief-of-staff / executive-assistant / the
 * document-author), not a universal one, and every default tool costs context on
 * every turn. The tool is registered and available to any pack that allowlists
 * it; recommended adopters are record-keeping personas.
 *
 * @see docs/adr/0119-conversation-export-import.md
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle, untrustedToolError } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { exportConversationAsDocument } from './asDocumentService.js';
import { authorizeConversationRead, refuseUnlessSoleAuthor, refuseUnlessSoleOwner } from './access.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

/** CX2CD-1 — the stored messages decide too: a removed participant's words stay. */
async function soleAuthorRefusal(sessionId: string, actor: string): Promise<ReturnType<typeof refuseUnlessSoleAuthor>> {
  return refuseUnlessSoleAuthor(await hostExtStorage().listChatSessionMessages(sessionId), actor);
}

export const CONVERSATIONS_EXPORT_DOCUMENT_TOOL_ID = 'openwop:conversations.export-document';

function toolError(error: string, message: string): { content: string; isError: true; hostMessage: true } {
  return { content: JSON.stringify({ error, message }), isError: true, hostMessage: true };
}
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function registerChatExportAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: CONVERSATIONS_EXPORT_DOCUMENT_TOOL_ID,
      description:
        'Save a conversation as a DRAFT document (a "conversation transcript") in the workspace Documents area. '
        + 'By default it exports THIS conversation — omit conversationId. Returns the new documentId + title; tell the '
        + 'user the title and that the transcript is a draft under Documents, visible to members of that organization. '
        + 'Only a conversation that is the user\'s alone can be saved (not a channel, group, project chat or a thread with other people).',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'The conversation (chat session) id to export. Omit to export the current conversation.' },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    async run(input: Record<string, unknown>, scope: BundleScope) {
      // Toggle honesty: the tool WRITES a Document, so honor the documents toggle
      // (parity with documents.draft) even though chat-export itself is always-on.
      const featureOn = await resolveFeatureToggle('documents', scope);
      if (!featureOn) {
        return toolError('feature_disabled', 'The Documents feature is not enabled for this workspace — tell the user you cannot save a transcript here.');
      }
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return toolError('acting_user_required', 'Exporting a conversation runs on behalf of a signed-in user.');
      }
      // The conversation: explicit id, else the current one (unforgeable — never a
      // tool input on the current-conversation path).
      const sessionId = optStr(input.conversationId) ?? scope.conversationId;
      if (!sessionId) {
        return toolError('validation_error', 'No conversation to export — pass `conversationId` or run this inside a conversation.');
      }
      // Existence + READ visibility: the SAME helper the HTTP export route calls
      // (ADR 0992 D8). Absent and invisible both fold to not_found (no existence leak).
      let read: Awaited<ReturnType<typeof authorizeConversationRead>>;
      try {
        read = await authorizeConversationRead(scope.tenantId, sessionId, actingUserId);
      } catch (err) {
        // Only the helper's uniform 404 means "no such conversation"; a storage
        // failure must not be told to the user as one (grade-code CX2CD-5).
        if (err instanceof OpenwopError && err.code === 'not_found') return toolError('not_found', 'No such conversation in this workspace.');
        throw err;
      }
      const { session, meta } = read;
      // Org resolution + the SAME write RBAC the documents write path enforces.
      const orgs = await listOrgs(scope.tenantId);
      const orgId = optStr(input.orgId) ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
      if (!orgId) {
        return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
      }
      if (!orgs.some((o) => o.orgId === orgId)) {
        return toolError('not_found', 'Organization not found in this workspace.');
      }
      const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
      if (!access.scopes.includes('workspace:write')) {
        return toolError('forbidden_scope', 'The user does not have write access to that organization.');
      }
      // ADR 0992 D8 — a Document is readable by every member of the org, so only a
      // conversation that is the acting user's alone may be copied into one.
      const refusal = refuseUnlessSoleOwner(meta, actingUserId, orgId) ?? await soleAuthorRefusal(sessionId, actingUserId);
      if (refusal === 'shared_conversation') {
        return toolError('shared_conversation', 'This conversation includes other people (a channel, group, project chat or shared thread). Saving it as a Document would show their messages to everyone in the organization, so it cannot be saved. Tell the user they can download it from the conversation menu instead.');
      }
      if (refusal === 'client_mismatch') {
        return untrustedToolError('client_mismatch', 'This conversation belongs to a client organization (named below); it can only be saved into that organization\'s Documents.', meta?.client?.name ?? '');
      }
      // Deterministic idempotency: an exact re-export in the same run reuses the
      // same transcript document instead of duplicating it.
      const idempotency = scope.runId
        ? (() => {
            const key = createHash('sha256')
              .update([scope.runId, CONVERSATIONS_EXPORT_DOCUMENT_TOOL_ID, orgId, sessionId].join('\u0000'))
              .digest('hex')
              .slice(0, 32);
            return { documentId: `doc:${key}`, idempotencyKey: key };
          })()
        : undefined;
      const { documentId } = await exportConversationAsDocument(scope.tenantId, orgId, actingUserId, sessionId, idempotency);
      return {
        content: JSON.stringify({
          documentId,
          title: (session.title || 'Conversation').slice(0, 200),
          kind: 'conversation-transcript',
          status: 'draft',
          location: 'Documents',
          url: `/documents?org=${encodeURIComponent(orgId)}&doc=${encodeURIComponent(documentId)}`,
          visibleTo: 'organization members',
          note: 'Conversation exported as a transcript draft. Tell the user the exact title, that it is in the Documents area, and that members of the organization can read it.',
        }),
      };
    },
  });
}
