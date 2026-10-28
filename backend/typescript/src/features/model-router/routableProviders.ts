/**
 * ADR 0610 D4 / MRC-2 — the closed-world catalog a model-router routing target may
 * name. A rule routes a run's prompts to `{provider, model}` on the run's EXISTING
 * credentialRef; without this allowlist a `workspace:write` editor could route org
 * prompt data to an arbitrary external vendor (or the `compat` custom-endpoint — the
 * arbitrary-URL egress hole). The set is the sanctioned user BYOK providers: the
 * catalog's `!managed && !hidden` list (ADR 0990 D6), so MiniMax (free tier only)
 * and `compat`/`mock` (custom/test endpoints) are excluded.
 *
 * A tiny PURE module so both the write gate (`configService.asTarget`) and the
 * read gate (`applyRoute.effectiveModelTarget` — dispatch/`:fork`) share the ONE
 * predicate without dragging the heavier `configService` (a `DurableCollection`
 * owner) into the pure dispatch-read path.
 */
import { listSelectableProviderIds } from '../../providers/catalog.js';

export const ROUTABLE_PROVIDERS: readonly string[] = listSelectableProviderIds();

/** True when `provider` is a sanctioned routing target. Used at WRITE (reject a bad
 *  rule) AND at READ/dispatch (ignore a legacy/tampered/forked stamp). */
export function isRoutableProvider(provider: string): boolean {
  return ROUTABLE_PROVIDERS.includes(provider);
}
