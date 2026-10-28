/**
 * ADR 0993 D8 — the Team library's writes. Kept out of `client/promptLibraryClient`
 * (which the entry chunk carries for `listOrgs`) so these ship only with the lazy
 * `/prompts` route. A failed call throws a `TeamLibraryError` carrying the server
 * code, so the page can tell a stale edit (`conflict`) from anything else.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import type { PromptEntry, PromptKind, PromptVisibility } from '../client/promptLibraryClient.js';

export class TeamLibraryError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new TeamLibraryError(body.error ?? 'http_error', res.status, body.message ?? `HTTP ${res.status}`);
  return body as T;
}

const BASE = (orgId: string): string => `/host/openwop-app/prompts/orgs/${encodeURIComponent(orgId)}/entries`;

export async function listTeamPrompts(orgId: string): Promise<PromptEntry[]> {
  return (await http<{ entries: PromptEntry[] }>(BASE(orgId))).entries ?? [];
}

export interface PublishInput {
  name: string;
  description?: string;
  visibility: PromptVisibility;
  /** Publish this text as the library's own (D4)… */
  template?: { kind: PromptKind; text: string };
  /** …or bind a template that already lives in the prompt store. */
  promptRef?: string;
}

export async function publishTeamPrompt(orgId: string, input: PublishInput): Promise<PromptEntry> {
  return (await http<{ entry: PromptEntry }>(BASE(orgId), { method: 'POST', body: JSON.stringify(input) })).entry;
}

export interface EditInput {
  name?: string;
  description?: string;
  visibility?: PromptVisibility;
  text?: string;
  /** Only to repair a published entry whose body is gone (it has no kind left). */
  kind?: PromptKind;
  /** The revision the editor opened; a stale one is a 409 `conflict` (D3). */
  expectedRevision: number;
}

export async function editTeamPrompt(orgId: string, entryId: string, input: EditInput): Promise<PromptEntry> {
  return (await http<{ entry: PromptEntry }>(`${BASE(orgId)}/${encodeURIComponent(entryId)}`, { method: 'PATCH', body: JSON.stringify(input) })).entry;
}

export async function deleteTeamPrompt(orgId: string, entryId: string): Promise<void> {
  await http<void>(`${BASE(orgId)}/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
}

export async function renderTeamPrompt(orgId: string, entryId: string): Promise<string> {
  return (await http<{ composed: string }>(`${BASE(orgId)}/${encodeURIComponent(entryId)}/render`, { method: 'POST', body: JSON.stringify({ variables: {} }) })).composed ?? '';
}
