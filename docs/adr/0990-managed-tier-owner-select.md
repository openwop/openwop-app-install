# ADR 0990 — The site owner chooses the free tier's provider and model

Status: Accepted (David, 2026-10-26: admin UI setting; keys in the Secrets Vault, typed by him)

## Context

This is a BYOK application with a free tier. The free tier (`managed:openwop-free`)
runs on a server-held key. Until #5285 its provider was hard-coded to MiniMax
(`providers/managedProvider.ts` `getTargets()`), with only `MINIMAX_MODEL`
configurable. #5285 added `OPENWOP_MANAGED_PROVIDER` (`minimax` | `anthropic`), but an
env var still means a Cloud Run env update and a new revision for every change.

The request, from David (2026-10-26, relayed by yc-a1 and confirmed directly): "we
need to offer an option to have the site owner to pick which model is the hard coded
free provider and model." MyndHyve's founding-agency pilots need a free tier on a
provider with business no-training API terms, and the owner should be able to make
that call without a deploy.

A second, related fact, also David's: "The user can't BYOK for minimax, that is a
hidden model to the user." MiniMax is a candidate for the free tier only. Measured on
`origin/main` (and the myndhyve pin) 2026-10-26:

- The SPA already hides it: `providers.json` marks `minimax` `hidden: true`, and
  every BYOK surface filters `!p.managed && !p.hidden` (`KeysPage.tsx`,
  `ProviderGrid.tsx`, `ProviderPickerInput.tsx`).
- The API does not: `host/chatByokConfig.ts` `CHAT_BYOK_PROVIDERS` includes
  `'minimax'`, so a hand-built call can bind chat to a stored MiniMax key; run
  admission (`advertisedByokProviders()`, ADR 0712) accepts a tenant's MiniMax run
  key; and the per-provider auth modes give MiniMax `apiKey`. ADR 0759 added the
  last two on purpose, for the openwop.dev launch-kit showcase.

## Decision

### D1. One resolver, a superadmin setting above the env default

A host-wide, superadmin-owned durable config, `ManagedTierConfig`:
`{ provider, model, updatedAt, updatedBy }`. Its provider is one of
`anthropic | openai | google | minimax`, the four with both a chat adapter
(`dispatchChat`) and a tools-round adapter (`dispatchAnthropicToolsRound`,
`dispatchOpenAIToolsRound`, `dispatchGoogleToolsRound`, `dispatchMiniMaxToolsRound`).

`getTargets()` becomes the ONE resolver of the managed target. Precedence:

1. the stored `ManagedTierConfig`, when present and valid;
2. else the env (`OPENWOP_MANAGED_PROVIDER` plus `<PROVIDER>_MODEL`, from #5285);
3. else MiniMax with `MiniMax-M3`, unchanged for every existing deploy.

This is the ADR 0318 fill-a-seam shape: the feature registers a config provider into
core (`registerManagedTierConfigProvider`), and core never imports the feature. The
resolver reads the config once per dispatch (a short in-process memo, invalidated on
write), so a change takes effect on the next call with no redeploy. An unregistered
provider, or a failed read, falls back to the env default (step 2), never to "no
tier". The one exception is an explicitly invalid stored value (D4).

> **CORRECTED 2026-10-27 (P2, #5305): a failed read keeps the LAST GOOD selection,
> and falls to the env default only when there has never been one.** Falling straight
> to env on a transient storage error would silently move a site off the provider its
> owner chose for its data terms, which is the promise D4 exists to keep. The memo is
> a 15 s TTL with a single-flight refresh; a write invalidates it. Witnessed in
> `test/managed-tier-owner-select.test.ts` ("a failed read keeps the last good selection").

### D2. Keys live in the Secrets Vault, one host-global ref per provider

Each provider's free-tier key is a host-global (scopeless) Secrets Vault ref,
`managed:key:<provider>`. David types it himself in `/access?tab=connections`, under
Host-global scope (the same place as `billing:stripe-key`). This host never shows,
logs or returns a key. The env var (`ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, …) stays
as the fallback, and the vault wins when both are set, as `webResearchSurface.ts`
does for `web-search`.

> **CORRECTED 2026-10-27 (P2, #5305): the ref is `free-tier:<provider>`, not
> `managed:key:<provider>`.** The `managed:` prefix is owned (ADR 0779
> `OWNED_REF_PREFIXES`), so the Secrets Vault refuses to store `managed:key:*`; the
> name above could never have been saved. The resolver reads `free-tier:<provider>`
> through scopeless `resolveSecret` (try/catch), then the env-seeded row.

The #5285 rule carries over: each provider's key resolves only from that provider's
own ref or env, so a missing key reads as `managed_unavailable`, never as another
provider's key. The env-seeded per-provider storage rows (`managed:openwop-free`,
`managed:openwop-free@anthropic`) become the env fallback's cache, and the vault ref
is read through `resolveSecret` (it is already encrypted at rest).

`OPENWOP_BYOK_EPHEMERAL=false` is required, for the same reason as the Stripe key
(CLAUDE.md § Stripe): under ephemeral mode a scopeless ref resolves to null. The admin
UI says so when it detects that mode, rather than offering providers that can never
resolve.

### D3. The admin UI picks only among providers that have a key

A superadmin page (Settings → AI → Free tier) shows:

- a provider dropdown. Each option is marked ready or "no key", by reading only
  whether the provider's ref or env key resolves, as `getManagedProviderStatuses`
  already does. Selecting a provider without a key is refused (`409
  managed_key_missing`), so the owner cannot turn the free tier off by accident;
- a model id field, defaulting to the provider's current recommended model from
  `providers.json`, free text bounded to the existing model-id pattern;
- a "Send a test message" button. It runs one bounded managed call through the real
  dispatch, charged to the operator's own bucket, and shows success or the provider's
  error code. This is how a wrong model id is caught before visitors hit it;
- the effective source (setting, env or default), so the owner can see what is
  serving.

No key field. A link goes to the Secrets Vault for adding one.

### D4. A stored value that no longer validates is unavailable, not a fallback

If the stored provider is not in the supported set (for example, a downgrade removed
it), the tier is `managed_unavailable` and the readiness probe says why, the same
rule #5285 applied to an unknown env value. The owner chose the provider for its data
terms, so a silent fallback to MiniMax would break a promise they made to their
customers. A failed READ (D1) is different: it is not a choice, so it falls back to
env.

### D5. Caps and the cached-read weight follow the selected provider

The daily caps (`OPENWOP_MANAGED_DAILY_TOKEN_CAP`, the tenant and global caps) stay
host-wide token counts, unchanged. The setting adds an optional per-provider override,
because a token on Claude costs many times a token on MiniMax-M3 and the owner's spend
backstop must move with the provider. `cachedReadWeight` comes from the selected
provider's default (MiniMax 0.2, Anthropic 0.1, OpenAI and Google from their cache
pricing in `providers.json`), still overridable by `OPENWOP_MANAGED_CACHED_READ_WEIGHT`.

For Anthropic, the cap bucket must count cache reads. Anthropic reports
`cache_read_input_tokens` separately from (disjoint with) `input_tokens`, so the
current `input + output` count leaves cached prompt tokens out of the daily cap.
`prepaidDrawTokens` already handles the disjoint shape for money. The cap must count
them at full weight, as it does for MiniMax.

### D6. MiniMax is never a user BYOK provider (David, 2026-10-26: "hidden everywhere")

The user-BYOK provider list is the catalog's `!managed && !hidden` set, the predicate
the SPA already uses. Three surfaces read it:

- run admission (`advertisedByokProviders()`), so a tenant's MiniMax run key is
  refused (`403 credential_forbidden`);
- the per-provider auth modes, so MiniMax has no `apiKey` mode;
- chat bindings (`setChatBinding`) and the model router's routable targets, so a
  binding or routing rule naming `minimax` with a stored key is refused
  (`400`, `reason: provider_not_byok`).

MiniMax stays a valid free-tier provider (D1). A managed binding still carries
`provider: minimax` as the managed rewrite produces it, so that shape is allowed only
with a `managed:` ref. MiniMax also stays in discovery's `aiProviders.providers[]`,
which names the providers the host DISPATCHES to, not the ones a user may key: the
host still routes the free tier and RFC 0105 speech there, and RFC 0105 requires the
speech provider to be in that list.

This corrects ADR 0759, whose showcase now needs an Anthropic, OpenAI or Google key.
Existing tenant bindings to `minimax` on a stored key are measured before deploy and
reported, not rewritten: a tenant's own key is theirs.

### D7. Out of scope

- Managed speech (TTS) stays MiniMax-only (`MANAGED_SPEECH_PROVIDERS`). A separate
  setting can follow the same pattern.

  > **CORRECTED 2026-10-27 (#5305): "stays MiniMax-only" was not true on #5285.**
  > `resolveManagedSpeechKey` resolved through the SELECTED chat target, so with
  > `OPENWOP_MANAGED_PROVIDER=anthropic` a managed speech call would have sent the
  > Anthropic key to MiniMax's T2A endpoint. It now always resolves the MiniMax key.
  > Witnessed at the route by `test/managed-speech-key-isolation.test.ts`. No deploy
  > may set `OPENWOP_MANAGED_PROVIDER=anthropic` until #5305 is live.
- Per-tenant free-tier selection. Host-wide only, matching the env it replaces.
- No wire change. The managed tier is already reported under its user-facing id
  (`openwop-free`), and the underlying provider never leaves the host (the
  managedProvider.ts result-rewriting contract). D6 changes this host's per-provider
  auth modes, which is a host fact, not a spec change; `providers[]` is unchanged.

## Alternatives

- **Env only (#5285 extended to four providers).** Rejected by David: a change needs
  a revision, and the owner cannot test it first.
- **Key typed into the setting form.** Rejected: it would be a second place keys enter
  the host. The Secrets Vault is the one door for operator secrets (CLAUDE.md
  § Stripe).
- **Fall back to MiniMax when the selected provider has no key.** Rejected (D4).

## Implementation plan

| Phase | What | Gate |
|---|---|---|
| P0 | #5285: env-selectable provider (`minimax`/`anthropic`), separate key rows | merged in slot 112 |
| P1 | D6: derive run admission, auth modes, chat bindings and router targets from the catalog; tests that a stored-key `minimax` run key and binding are refused (sabotage-witnessed) | `npm run ci` |
| P2 | D1, D2, D4, D5: `ManagedTierConfig` store, seam, vault-then-env key resolution, OpenAI and Google targets, the cap counting Anthropic cache reads; tests for precedence, no cross-provider key, unavailable on invalid, fallback on read failure | `npm run ci` |
| P3 | D3: the admin page, with i18n in four locales, dark mode, and the test-message route (superadmin-only, rate-limited) | frontend build + vitest |
| ~~P4~~ | ~~MyndHyve: upgrade, David adds the Anthropic key in the Vault, picks the provider, sends a test message~~ | **Cancelled** (David, 2026-10-26: "Don't move MyndHyve's free tier to Claude") |

**Record (2026-10-27).** P0 merged as #5285 (`c431c62b4`). P1 merged as #5294
(`cd25b017b`). P2 and P3 are one PR, #5305: the `features/managed-tier-admin` store
and superadmin routes, the core seam, vault-then-env keys, OpenAI and Google targets,
Anthropic cache reads in the cap, the speech-key fix (D7 correction), and the
`/free-tier-settings` page. MyndHyve's free tier stays on MiniMax, so P4 is cancelled
rather than pending. P2/P3 do not change any deploy's provider: with no setting and no
env, the tier is MiniMax `MiniMax-M3` as before.

## Open questions

- [ ] The default model per provider shown in the dropdown. Proposed: the first
      non-deprecated chat model in `providers.json`, refreshed by
      `/refresh-model-catalog`.
      **Resolved differently in P2:** each provider's default is pinned in
      `managedProvider.ts` `PROVIDER_SPECS` (`claude-sonnet-5-5`, `gpt-5.6-terra`,
      `gemini-3.8-flash`, `MiniMax-M3`), next to its key name and cached-read weight,
      so the free tier's default cannot move when the catalog is refreshed.
- [ ] Should switching provider reset the per-subject daily buckets? Proposed: no.
      The buckets count tokens, and the cap override (D5) is the lever.
