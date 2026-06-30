/**
 * ADR 0116 Phase 3a — prompt-library FE client. The data layer for the library UI +
 * the `/`-insertion menu: list/create/render org prompt entries. Org-scoped (RBAC at
 * the backend). `render` substitutes `{{var}}` server-side.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

export interface Org { orgId: string; name: string }

/** The caller's orgs (the library org picker). */
export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/v1/host/openwop-app/orgs')).orgs ?? [];
}

export interface PromptEntry { entryId: string; name: string; description?: string; promptRef: string }

const BASE = (orgId: string): string => `/v1/host/openwop-app/prompts/orgs/${encodeURIComponent(orgId)}/entries`;

export async function listPrompts(orgId: string): Promise<PromptEntry[]> {
  return (await http<{ entries: PromptEntry[] }>(BASE(orgId))).entries ?? [];
}

export async function createPrompt(orgId: string, input: { name: string; promptRef: string; description?: string }): Promise<PromptEntry> {
  return (await http<{ entry: PromptEntry }>(BASE(orgId), { method: 'POST', body: JSON.stringify(input) })).entry;
}

export async function renderPrompt(orgId: string, entryId: string, variables: Record<string, unknown>): Promise<string> {
  const r = await http<{ composed: string }>(`${BASE(orgId)}/${encodeURIComponent(entryId)}/render`, { method: 'POST', body: JSON.stringify({ variables }) });
  return r.composed ?? '';
}
