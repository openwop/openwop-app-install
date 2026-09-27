/**
 * Conversation-search routes (ADR 0112 Phase 2) — host-extension, read-only.
 *
 * `GET|POST /v1/host/openwop-app/chat/search?q&type&role&limit` — full-text search
 * over the CALLER's conversations + messages. Gated by the `conversation-search`
 * toggle (404 when off, so the rail self-hides). The caller's owned-or-participant
 * conversations are resolved through the shared ADR 0043 visibility predicate
 * (`isVisibleToAsync`) BEFORE the query, and only those ids enter the search scope
 * — a co-tenant non-participant's conversation can never surface (no existence
 * leak). No mutation surface: indexing is internal (lazy backfill in the engine).
 *
 * @see docs/adr/0112-conversation-full-text-search.md
 */
import type { Request, Response, NextFunction } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { ConversationType } from '../../host/conversationStore.js';
import { searchVisibleConversations } from './searchEngine.js';

const MAX_LIMIT = 50;
const VALID_TYPES: ReadonlySet<string> = new Set<ConversationType>(['agent', 'person', 'group', 'workspace']);

function param(req: Request, key: string): string | undefined {
  const fromQuery = req.query?.[key];
  if (typeof fromQuery === 'string') return fromQuery;
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.[key];
  return typeof fromBody === 'string' ? fromBody : undefined;
}

export function registerConversationSearchRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  const handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Mirror the chat-sessions list route EXACTLY (`tenantFromReq` +
      // `actingUserOf`): tenant from the session (`_anon` for bearer probes, NOT
      // `default`), acting-user from the session/principal (undefined for
      // anon/legacy → unowned conversations stay tenant-visible per the ADR 0043
      // predicate). No requireSignedIn — search is available to the same callers
      // who can list their conversations, over the same corpus.
      const tenantId = req.tenantId ?? '_anon';
      const actingUserId = req.userId ?? req.principal?.principalId;

      const q = param(req, 'q') ?? '';
      const typeParam = param(req, 'type');
      const type = typeParam && VALID_TYPES.has(typeParam) ? (typeParam as ConversationType) : undefined;
      const role = param(req, 'role');
      const limitRaw = Number.parseInt(param(req, 'limit') ?? '', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 20;

      // XCH-HOLE-5 (Wave 4): visibility resolution + scope + query live in the
      // ONE shared helper so this route and the agent tool cannot drift.
      const hits = await searchVisibleConversations(storage, tenantId, actingUserId, q, {
        ...(type ? { type } : {}),
        ...(role ? { role } : {}),
        limit,
      });
      res.json({ hits });
    } catch (err) {
      next(err);
    }
  };

  app.get('/v1/host/openwop-app/chat/search', handle);
  app.post('/v1/host/openwop-app/chat/search', handle);
}
