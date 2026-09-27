/**
 * ADR 0610 D4 / MRC-2 — the closed-world catalog a model-router routing target may
 * name. A rule routes a run's prompts to `{provider, model}` on the run's EXISTING
 * credentialRef; without this allowlist a `workspace:write` editor could route org
 * prompt data to an arbitrary external vendor (or the `compat` custom-endpoint — the
 * arbitrary-URL egress hole). The set is the sanctioned real BYOK providers (the SSoT
 * `CHAT_BYOK_PROVIDERS`); `compat`/`mock` (custom/test endpoints) are excluded.
 *
 * A tiny PURE module so both the write gate (`configService.asTarget`) and the
 * read gate (`applyRoute.effectiveModelTarget` — dispatch/`:fork`) share the ONE
 * predicate without dragging the heavier `configService` (a `DurableCollection`
 * owner) into the pure dispatch-read path.
 */
import { CHAT_BYOK_PROVIDERS } from '../../host/chatByokConfig.js';

export const ROUTABLE_PROVIDERS: readonly string[] = CHAT_BYOK_PROVIDERS;

/** True when `provider` is a sanctioned routing target. Used at WRITE (reject a bad
 *  rule) AND at READ/dispatch (ignore a legacy/tampered/forked stamp). */
export function isRoutableProvider(provider: string): boolean {
  return ROUTABLE_PROVIDERS.includes(provider);
}
