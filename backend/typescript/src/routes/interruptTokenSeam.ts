/**
 * ADR 1059 P2 / RFC 0259 §C.1 — `POST /conformance/seams/sample/interrupts/token`
 * (`readInterruptToken`), served at its v1 address and reached at the v2 one
 * through the ADR 0634 alias (`routes/conformanceSeams.ts`, `sample/` rule).
 *
 * `{ runId, nodeId, bind? }` → `200 { token, resumeValueMembers? }`. v2 gives an
 * outside party no way to read a resume token, so without this seam the suite
 * cannot cause a token resolution and every `0259.*` host leg is unobserved.
 *
 * SAME VALUES AS PRODUCTION, NO SEAM BRANCH. `token` is the stored token the
 * suspend manager minted. `resumeValueMembers` is exactly what the approval
 * email puts in a link it addresses to a person (`emailApprovalDelivery.ts`:
 * `voter` + `signVoterBinding(token, voter)`), addressed to the CALLER. The seam
 * resolves nothing and mints nothing.
 *
 * WHEN IT BINDS. Only a signed-in person (`req.userId`) can be addressed, and
 * only when the Subject `resolvedVia.boundTo` would carry (`sessionSubjectV2`)
 * IS the caller's own owner stamp. A caller on another lane (an OIDC login, an
 * API key) gets no members, so the suite's bound leg records `inapplicable`
 * rather than comparing against a Subject this host would not stamp for it.
 *
 * GATES. `OPENWOP_TEST_SEAM_ENABLED !== 'true'` ⇒ `404 not_found`, the
 * route-miss every seam here gives. The run must be the caller's
 * (`loadOwnedRun`, `approvals:respond` — the authority a token stands in for).
 * No open interrupt on `nodeId`, including one already resolved ⇒ `404`.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import type { Storage } from '../storage/storage.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { OpenwopError } from '../types.js';
import { loadOwnedRun } from '../host/runAccess.js';
import { signVoterBinding } from '../host/interruptVoterBinding.js';
import { requestSubjectV2, sessionSubjectV2 } from '../host/runOwner.js';
import { isDeepStrictEqual } from 'node:util';

export const INTERRUPT_TOKEN_SEAM_PATH = '/host/sample/interrupts/token';

const KEYS = new Set(['runId', 'nodeId', 'bind']);

export interface InterruptTokenSeamResult {
  token: string;
  resumeValueMembers?: { voter: string; voterSig: string };
}

/** The seam's decision, separated from Express so it is tested without an app. */
export async function readInterruptTokenForCaller(storage: Storage, req: Request, body: unknown): Promise<InterruptTokenSeamResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new OpenwopError('validation_error', 'body must be a JSON object', 400, { field: 'runId' });
  }
  const b = body as Record<string, unknown>;
  const unknownKey = Object.keys(b).find((k) => !KEYS.has(k));
  if (unknownKey !== undefined) throw new OpenwopError('validation_error', `unknown key ${unknownKey}`, 400, { field: unknownKey });
  if (typeof b.runId !== 'string' || b.runId === '') throw new OpenwopError('validation_error', 'runId is required', 400, { field: 'runId' });
  if (typeof b.nodeId !== 'string' || b.nodeId === '') throw new OpenwopError('validation_error', 'nodeId is required', 400, { field: 'nodeId' });
  if (b.bind !== undefined && typeof b.bind !== 'boolean') throw new OpenwopError('validation_error', 'bind must be a boolean', 400, { field: 'bind' });
  const run = await loadOwnedRun(req, storage, b.runId, 'approvals:respond');
  const interrupt = (await storage.listOpenInterrupts(run.runId)).find((i) => i.nodeId === b.nodeId && !i.resolvedAt);
  if (!interrupt) throw new OpenwopError('not_found', `no open interrupt on node ${b.nodeId}`, 404);
  if (b.bind !== true) return { token: interrupt.token };
  const userId = (req as { userId?: unknown }).userId;
  if (typeof userId !== 'string' || userId === '') return { token: interrupt.token };
  if (!isDeepStrictEqual(requestSubjectV2(req, run.tenantId), sessionSubjectV2(userId, run.tenantId))) return { token: interrupt.token };
  return { token: interrupt.token, resumeValueMembers: { voter: userId, voterSig: signVoterBinding(interrupt.token, userId) } };
}

export function registerInterruptTokenSeam(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;
  app.post(INTERRUPT_TOKEN_SEAM_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
        sendError(res, 404, 'not_found', 'The conformance seam surface is not enabled on this host.');
        return;
      }
      res.status(200).json(await readInterruptTokenForCaller(storage, req, req.body as unknown));
    } catch (err) {
      next(err);
    }
  });
}
