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
import { chatAuthorSubject } from '../../host/chatAuthorSubject.js';
import { transcriptToJson, transcriptToMarkdown } from './transcriptRenderer.js';
import { parseOpenwopExport, parseChatGptExport } from './importParser.js';
import { importConversation, IDEMPOTENCY_KEY } from './importService.js';
import { authorizeConversationRead } from './access.js';

/** An ASCII file name from a conversation title (header-safe; any title, any language). */
export function exportFileName(title: string, ext: 'md' | 'json'): string {
  const slug = (title || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'conversation'}.${ext}`;
}

export function registerChatExportRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/host/openwop-app/chat-export/:sessionId', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? '_anon';
      const actingUserId = req.userId ?? req.principal?.principalId;
      const sessionId = req.params.sessionId;
      // ADR 0992 D8 — the one read helper the agent tool also calls (uniform 404).
      const { session } = await authorizeConversationRead(tenantId, sessionId, actingUserId);
      const messages = await hostExtStorage().listChatSessionMessages(sessionId);
      const json = req.query.format === 'json';
      // ADR 0992 D9 — name the download after the conversation, not its UUID.
      res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(session.title, json ? 'json' : 'md')}"`);
      if (json) {
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
  app.post('/host/openwop-app/chat-export/import', async (req, res, next) => {
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
      // ADR 0992 D4 — an optional idempotency key (the SPA sends a digest of the file).
      const key = (req.body as { idempotencyKey?: unknown }).idempotencyKey;
      if (key !== undefined && (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))) {
        throw new OpenwopError('validation_error', '`idempotencyKey` MUST match /^[A-Za-z0-9_.:-]{1,128}$/.', 400, { field: 'idempotencyKey' });
      }
      const parsed = body.format === 'chatgpt' ? parseChatGptExport(body.data) : parseOpenwopExport(body.data);
      // D3 — the rows carry the importer's chat-author spelling, the same stamp the
      // chat append route writes, so DSAR erasure and author edits reach them.
      const author = chatAuthorSubject(req) ?? userId;
      const result = await importConversation(tenantId, userId, parsed, author, key);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) { next(err); }
  });
}
