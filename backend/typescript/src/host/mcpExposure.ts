/**
 * ADR 0788 D5 — per-workspace MCP exposure control: the set of entries an admin
 * has switched OFF for external AI clients (the AnythingLLM per-tool
 * suppression every leader in the competitive scan ships).
 *
 * The set only ever NARROWS: `mcpServerRegistry.computeExposure` drops a
 * disabled entry from `tools/list`, `tools/call` and `/v1/tools` alike, and can
 * never re-admit an entry the gate refuses.
 *
 * Keyed `source:workflowId:toolName`, never by name alone (architect M4): a
 * builder rename would otherwise silently re-enable a tool an admin disabled.
 * The row carries no person — who changed it lives in the audit log — so it is
 * tenant configuration, not personal data.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import type { McpEntrySource } from './mcpServerRegistry.js';

export interface McpExposureRecord {
  tenantId: string;
  disabled: string[];
  updatedAt: string;
}

/** Bounded so one PUT cannot grow a row without limit. */
export const MAX_DISABLED_ENTRIES = 500;
const KEY_RE = /^(host|workspace):[^\s:]{1,300}:[^\s]{1,200}$/;

const store = new DurableCollection<McpExposureRecord>('mcp-exposure', (r) => r.tenantId, undefined, (r) => r.tenantId);

export function exposureKey(source: McpEntrySource, workflowId: string, name: string): string {
  return `${source}:${workflowId}:${name}`;
}

/** The tenant's disabled set. THROWS on a storage error (grade-code MCPCD-8):
 *  reading a failure as "nothing disabled" would re-enable every tool an admin
 *  switched off for the length of a database blip. The MCP mount turns the throw
 *  into a JSON-RPC internal error. */
export async function getDisabledEntries(tenantId: string): Promise<ReadonlySet<string>> {
  const row = await store.get(tenantId);
  return new Set(row?.disabled ?? []);
}

/**
 * Switch ONE entry on or off, merged into the stored set by compare-and-swap
 * (grade-code MCPCD-3 / grade-ux MCPUX-3). The first cut replaced the whole set
 * with whatever the page sent, and the page built it from the admin's OWN
 * filtered view — so any disabled tool the admin could not currently see (its
 * toggle off, its workflow archived, outside their permissions) was silently
 * re-enabled by an unrelated click, and two admins overwrote each other.
 */
export async function setEntryDisabled(tenantId: string, rawKey: unknown, rawDisabled: unknown): Promise<McpExposureRecord> {
  if (typeof rawKey !== 'string' || !KEY_RE.test(rawKey)) {
    throw new OpenwopError('validation_error', 'key must be a "source:workflowId:name" entry key.', 400, {});
  }
  if (typeof rawDisabled !== 'boolean') throw new OpenwopError('validation_error', 'disabled must be a boolean.', 400, {});
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.get(tenantId);
    const keys = new Set(current?.disabled ?? []);
    if (rawDisabled) keys.add(rawKey);
    else keys.delete(rawKey);
    if (keys.size > MAX_DISABLED_ENTRIES) {
      throw new OpenwopError('validation_error', `at most ${MAX_DISABLED_ENTRIES} disabled entries.`, 400, {});
    }
    const next: McpExposureRecord = { tenantId, disabled: [...keys].sort(), updatedAt: new Date().toISOString() };
    if (await store.compareAndSwap(current, next)) return next;
  }
  throw new OpenwopError('conflict', 'The tool list changed while saving. Reload and try again.', 409, {});
}
