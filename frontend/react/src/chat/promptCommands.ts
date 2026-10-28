/**
 * ADR 0116 Phase 3c + ADR 0993 D1 — the org prompt library as `/p-<slug>` chat
 * commands, in the EXISTING CommandRegistry + SlashAutocomplete (the one-chat
 * rule: no bespoke composer affordance).
 *
 * A command INSERTS the rendered prompt into the composer it was typed in and
 * sends nothing. It used to send the text as the member's turn without their
 * ever seeing it, and any org writer authors that text (ADR 0993 PL2-3).
 *
 * Registration covers every org of the active workspace and is re-read (a
 * re-read removes what the previous one registered); `ChatTab` owns when, and
 * lazy-imports this module so it stays out of the entry chunk.
 *
 * @see docs/adr/0993-prompt-library-owner-lanes-and-tenant-templates.md
 */
import { listCommands, registerCommand, unregisterCommand } from './registry/CommandRegistry.js';
import { listOrgs, listPrompts, renderPrompt, type PromptEntry } from '../client/promptLibraryClient.js';
import { seedLiveComposer } from './composerSeed.js';
import i18n from '../i18n/index.js';

/** A DOM/command-safe kebab slug from a prompt's display name. */
export function promptSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'prompt';
}

/** Re-read after this long when the tab becomes visible again. */
const STALE_MS = 60_000;

let registered: string[] = [];
let readKey: string | null = null;
let readAt = 0;
/** Bumped by every read, so a slow response from an older read never registers. */
let generation = 0;

/** Register the prompts of `orgIds` as `/p-<slug>` commands, replacing the last
 *  set. Skips the network when the same orgs were read less than a minute ago,
 *  unless `force`. Best-effort: an org whose read fails contributes nothing. */
export async function registerPromptCommands(orgIds: readonly string[], opts: { force?: boolean } = {}): Promise<void> {
  const key = [...orgIds].sort().join('\u0000');
  if (!opts.force && key === readKey && Date.now() - readAt < STALE_MS) return;
  const mine = ++generation;
  // The command copy lives in the lazily-loaded `prompts` namespace.
  await i18n.loadNamespaces('prompts').catch(() => undefined);
  const lists = await Promise.allSettled(orgIds.map(async (orgId) => ({ orgId, entries: await listPrompts(orgId) })));
  if (mine !== generation) return; // a newer read owns the registry
  for (const name of registered) unregisterCommand(name);
  registered = [];
  for (const res of lists) {
    if (res.status !== 'fulfilled') continue;
    const { orgId, entries } = res.value;
    // Oldest first, so an entry keeps its command name when a newer one with the
    // same slug is published (code-review P61CR-13: the list is newest first).
    const oldestFirst = [...entries].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    for (const entry of oldestFirst) {
      if (entry.available === false) continue; // its template or body is gone (D4)
      const name = freeName(`/p-${promptSlug(entry.name)}`);
      // "Insert: …" says what the command does, for anyone who learned that it sent.
      registerCommand({ name, description: () => i18n.t('prompts:commandInsertDescription', { name: entry.description || entry.name }), handler: handlerFor(orgId, entry, name) });
      registered.push(name);
    }
  }
  readKey = key;
  readAt = Date.now();
}

/** The one call `ChatTab` makes: every org of the active workspace. A workspace
 *  switch reloads the SPA (`WorkspaceSwitcher` `reloadInto`), so the org set read
 *  here is the active workspace's. Never throws: prompts are an optional surface. */
export async function registerWorkspacePromptCommands(opts: { force?: boolean } = {}): Promise<void> {
  try {
    await registerPromptCommands((await listOrgs()).map((o) => o.orgId), opts);
  } catch { /* signed out, or the org list failed: register nothing new */ }
}

/** Force the next registration to re-read (the library page calls this after a write). */
export function invalidatePromptCommands(): void {
  readKey = null;
}

/** `/p-x`, then `/p-x-2`, `/p-x-3`, … — never overwrite another command. */
function freeName(base: string): string {
  const taken = new Set(listCommands().flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function handlerFor(orgId: string, entry: PromptEntry, command: string) {
  return async (_args: string, ctx: { insert?: (text: string) => void; emitSystem: (text: string) => void }): Promise<boolean> => {
    const insert = ctx.insert ?? seedLiveComposer;
    try {
      const text = await renderPrompt(orgId, entry.entryId, {});
      if (!text) throw new Error('empty prompt');
      insert(text);
    } catch {
      // The composer was cleared on submit, so a failure would otherwise drop the
      // user's command with nothing said (grade-ux P61UX-3). Put the command back
      // and say why; never fall through, which would SEND `/p-…` as a message.
      insert(command);
      ctx.emitSystem(i18n.t('prompts:commandInsertFailed', { command }));
    }
    return true;
  };
}

/** Test-only: forget what was registered and read. */
export function resetPromptCommandsForTest(): void {
  registered = [];
  readKey = null;
  readAt = 0;
  generation = 0;
}
