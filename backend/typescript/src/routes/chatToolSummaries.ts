/**
 * ADR 1040 D7 F3 — `GET /host/openwop-app/chat/tool-summaries?conversationRunId&turnMessageId`:
 * the display summaries one chat turn's tool calls recorded (host-only; see
 * `host/chatToolSummaries.ts`). Gated by `canReadChatTurn`, the predicate a turn's artifacts are read under; a
 * caller who cannot read that conversation gets `{ summaries: [] }`.
 */
import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import { listToolSummariesForTurn } from '../host/chatToolSummaries.js';

export function registerChatToolSummaryRoutes(app: Express): void {
  app.get('/host/openwop-app/chat/tool-summaries', async (req, res, next) => {
    try {
      const runId = typeof req.query.conversationRunId === 'string' ? req.query.conversationRunId.trim() : '';
      const turnMessageId = typeof req.query.turnMessageId === 'string' ? req.query.turnMessageId.trim() : '';
      if (!runId || runId.length > 200) throw new OpenwopError('validation_error', '`conversationRunId` must be a non-empty run id.', 400, { field: 'conversationRunId' });
      if (!turnMessageId || turnMessageId.length > 400) throw new OpenwopError('validation_error', '`turnMessageId` must be a non-empty turn message id.', 400, { field: 'turnMessageId' });
      const subject = req.userId ?? req.principal?.principalId;
      res.status(200).json({ summaries: await listToolSummariesForTurn(tenantOf(req), subject, runId, turnMessageId, { personalTenant: req.personalTenant }) });
    } catch (err) {
      next(err);
    }
  });
}
