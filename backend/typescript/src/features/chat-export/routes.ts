/**
 * Conversation export routes (ADR 0119 Phase 2) — host-extension, read-only.
 * `GET /v1/host/openwop-app/chat-export/:sessionId?format=md|json` — renders the
 * caller's OWN-or-participant conversation transcript (ADR 0119 renderer). Toggle-
 * gated; owner/participant visibility (ADR 0043) → uniform 404 (no existence leak).
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
  // export) and materialize a NEW owned conversation. Toggle-gated; imported bodies are
  // stamped `contentTrust:'untrusted'` at the write (Phase 4b), so a hostile import is
  // fenced, never silently trusted.
  app.post('/v1/host/openwop-app/chat-export/import', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? '_anon';
      const userId = req.userId ?? req.principal?.principalId;
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
