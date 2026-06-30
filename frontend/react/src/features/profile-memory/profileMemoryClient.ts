/**
 * Personal Memory client (ADR 0041) — the human counterpart of the agent
 * knowledge client. Drives /v1/host/openwop-app/profiles/me/memory: list, add,
 * and delete the caller's OWN memories (self-service; the server keys every call
 * on the caller's resolved userId).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface MemoryNote { id: string; content: string; contentTrust: 'trusted' | 'untrusted'; createdAt: string }

const base = `${config.baseUrl}/v1/host/openwop-app/profiles/me/memory`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw new Error(`${ctx} failed (${res.status})`);
  return res.json() as Promise<T>;
}

/** List the caller's own memories (newest first). */
export async function listMemories(): Promise<MemoryNote[]> {
  const res = await fetch(base, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ notes: MemoryNote[] }>(res, 'listMemories')).notes;
}

/** Add a memory; returns the refreshed list. */
export async function addMemory(content: string): Promise<MemoryNote[]> {
  const res = await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }));
  return (await asJson<{ notes: MemoryNote[] }>(res, 'addMemory')).notes;
}

/** Delete a memory by id. */
export async function deleteMemory(noteId: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(noteId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteMemory failed (${res.status})`);
}
