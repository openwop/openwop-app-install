/**
 * ADR 0116 Phase 3c — surface the org's prompt-library entries as `/p-<slug>` chat
 * slash commands. Reuses the EXISTING CommandRegistry + SlashAutocomplete (the
 * `/`-insertion seam) — NO bespoke composer affordance (the one-chat rule, the
 * AiAuthorPanel lesson). On invoke, a command renders the entry server-side
 * (`{{var}}` substitution; an unbound var stays literal) and SENDS it as the user's
 * turn. Idempotent per org. (Insert-for-edit of `{{vars}}` before send is a deferred
 * follow-on needing a composer `setText` API; v1 fires the canned prompt.)
 *
 * @see docs/adr/0116-prompt-library.md
 */
import { registerCommand } from './registry/CommandRegistry.js';
import { listPrompts, renderPrompt } from '../client/promptLibraryClient.js';

/** A DOM/command-safe kebab slug from a prompt's display name. */
export function promptSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'prompt';
}

let registeredForOrg: string | null = null;

/** Register the org's prompts as `/p-<slug>` commands (once per org). Best-effort —
 *  prompts are an optional surface; a fetch failure simply registers nothing. */
export async function registerPromptCommands(orgId: string): Promise<void> {
  if (registeredForOrg === orgId) return;
  const entries = await listPrompts(orgId);
  for (const entry of entries) {
    registerCommand({
      name: `/p-${promptSlug(entry.name)}`,
      description: () => entry.description || entry.name,
      handler: async (_args, ctx) => {
        const text = await renderPrompt(orgId, entry.entryId, {});
        await ctx.send(text);
        return true;
      },
    });
  }
  registeredForOrg = orgId;
}

/** Test-only: reset the once-per-org guard. */
export function resetPromptCommandsForTest(): void { registeredForOrg = null; }
