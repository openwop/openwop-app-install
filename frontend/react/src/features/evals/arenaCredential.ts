/**
 * Which credential an arena contestant dispatches with (ADR 0986 D7, architect B2).
 *
 * The arena used to open both panes with `{provider, model}` and no credential,
 * so the host defaulted both to the managed tier: every match compared one
 * managed model with itself under two labels. A contestant now dispatches with
 * the credential the caller actually holds for its provider — the managed
 * sentinel for a managed provider, else the preferred stored BYOK ref (the same
 * choice the main chat's key adoption makes). No credential ⇒ null, and the
 * arena refuses to start rather than silently answering with something else.
 */
import { PROVIDERS } from '../../byok/lib/providers.js';
import { preferredRefForProvider } from '../../byok/lib/useBYOKConfig.js';

export function arenaCredentialRef(provider: string, storedRefs: readonly string[]): string | null {
  if (PROVIDERS.some((p) => p.id === provider && p.managed)) return `managed:${provider}`;
  return preferredRefForProvider(storedRefs, provider);
}
