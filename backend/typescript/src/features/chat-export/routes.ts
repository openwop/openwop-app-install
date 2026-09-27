/**
 * Conversation export + import routes (ADR 0119 Phase 2 / 4b) — host-extension.
 * `GET /v1/host/openwop-app/chat-export/:sessionId?format=md|json` — renders the
 * caller's OWN-or-participant conversation transcript (ADR 0119 renderer).
 * `POST …/chat-export/import` — materializes a NEW owned conversation (a WRITE).
 *
 * CORRECTED (ADR 0698, `CXC-8`) — this header said "read-only" and "Toggle-gated".
 * Both were false: the import route below writes, and the feature is ALWAYS-ON
 * (`feature.ts:23` — no `toggleDefault`; the toggle was graduated away under
 * ADR 0010/0024, and the route test asserts it serves without one).
 *
 * Visibility is owner/participant (ADR 0043) → uniform 404, no existence leak.
 *
 * @see docs/adr/0119-conversation-export-import.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { transcriptToJson, transcriptToMarkdown } from './transcriptRenderer.js';
import { parseOpenwopExport, parseChatGptExport } from './importParser.js';
import { importConversation } from './importService.js';

export function registerChatExportRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/v1/host/openwop-app/chat-export/:sessionId', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? '_anon';
      const actingUserId = req.userId ?? req.principal?.principalId;
      const sessionId = req.params.sessionId;
      const session = await hostExtStorage().getChatSession(tenantId, sessionId);
      if (!session) throw new OpenwopError('not_found', 'Conversation not found.', 404, { sessionId });
      const meta = await getConversationMeta(tenantId, sessionId);
      if (!(await isVisibleToAsync(meta, tenantId, actingUserId))) {
        throw new OpenwopError('not_found', 'Conversation not found.', 404, { sessionId }); // owner/participant only
      }
      const messages = await hostExtStorage().listChatSessionMessages(sessionId);
      if (req.query.format === 'json') {
        res.json(transcriptToJson(session, messages));
      } else {
        res.type('text/markdown').send(transcriptToMarkdown(session, [...messages]));
      }
    } catch (err) { next(err); }
  });

  // ADR 0119 — import. Parse a supported export (openwop-v1 round-trip, or an OpenAI
  // export) and materialize a NEW owned conversation.
  //
  // CORRECTED (ADR 0698 D1) — this used to say imported bodies are "stamped
  // `contentTrust:'untrusted'` at the write (Phase 4b), so a hostile import is
  // fenced, never silently trusted". The stamp is written but read by NOTHING; the
  // fencing on the model-facing path comes from the search TOOL's own
  // `contentTrust` declaration (`conversation-search/agentTools.ts:22` ->
  // `host/toModelToolResult.ts:101`). See `importService.ts`'s docblock.
  app.post('/v1/host/openwop-app/chat-export/import', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? '_anon';
      const userId = req.userId ?? req.principal?.principalId;
      // CXC-1 (ADR 0119 grade pass) — the WRITE must resolve an owning identity, in
      // parity with the sibling `conversations.export-document` tool's
      // `acting_user_required`. Auth middleware already 401s a principal-less request
      // upstream, so this never rejects a legitimate caller; it makes the "owned, not
      // tenant-visible" guarantee STRUCTURAL here instead of depending on middleware —
      // an unowned import would be readable by every co-tenant (conversationVisibility
      // `isVisibleTo` treats an owner-less conversation as tenant-visible).
      if (!userId) throw new OpenwopError('unauthenticated', 'Importing a conversation requires a signed-in user or principal.', 401, {});
      const body = (req.body ?? {}) as { format?: unknown; data?: unknown };
      // CONV-4: reject a present-but-unknown format with a clear error instead of silently
      // falling back to the openwop parser (a typo like 'chatgtp' used to import as openwop).
      if (body.format !== undefined && body.format !== 'openwop' && body.format !== 'chatgpt') {
        throw new OpenwopError('validation_error', "`format` must be 'openwop' or 'chatgpt'.", 400, { field: 'format' });
      }
      const parsed = body.format === 'chatgpt' ? parseChatGptExport(body.data) : parseOpenwopExport(body.data);
      res.status(201).json(await importConversation(tenantId, userId, parsed));
    } catch (err) { next(err); }
  });
}
