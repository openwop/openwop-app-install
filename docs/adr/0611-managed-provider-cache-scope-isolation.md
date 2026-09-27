# ADR 0611 — managed provider cache scope isolation (MMXC-1)

Status: implemented

## Context

The managed free tier (`managed:openwop-free`, `providers/managedProvider.ts`)
dispatches to MiniMax with **one server-held API key shared across ALL tenants**
(`resolveManagedKey` reads a single `storageRef`; the per-tenant cap is the only
per-tenant thing). MiniMax is OpenAI-compatible and runs an **automatic
prompt-prefix cache** (ADR 0148 A2; `cachedReadTokens`, ≥512-token floor) keyed by
prompt content on that key.

Because the key is shared, two tenants sending the **same ≥512-token prefix** would
share a MiniMax cache entry. Cross-tenant provider-cache sharing is the exact hazard
RFC 0116 §43 elevates to a **protocol-tier invariant**
(`prompt-prefix-cache-cross-tenant-isolation`: "distinct tenants **MUST NOT** share a
provider cache entry"), mirroring the `kv`/`queue`/`workspace` cross-tenant-isolation
family. CEC-2 (#3535) wired RFC 0116's `cachePrefixScope` sentinel for the **Anthropic
BYOK** path only — the managed MiniMax dispatch had **no** cache-scope marker.

### Risk characterization
- The prefix cache stores the KV-computation of the **shared** prompt tokens, not
  response bodies — not a direct content leak.
- On the managed path `cachedReadTokens` is **internal-only** (never emitted on the
  wire — `managedProvider.ts` `logManagedCache`), so the explicit membership signal
  is already closed. The residual is a **latency** channel plus, depending on
  MiniMax's (undocumented) cache granularity, a potential cross-tenant prefix
  **probing/extraction** vector — the reason to close it as defense-in-depth.

### Scope of RFC 0116 §43
§43's `MUST` binds the host's **`cachePrefixId`-routed** cache for **advertised**
providers; this host advertises `promptPrefixCache.providers:["anthropic"]` only, so
MiniMax's **automatic** cache is not literally covered. This is therefore
**defense-in-depth honoring the invariant's spirit**, NOT a compliance catch-up.

## Decision

Stamp a **per-tenant cache-scope sentinel** into the leading system content of every
managed dispatch (`prepareManagedDispatch`):

- The sentinel is `[cache-scope <hash>]` where `<hash>` is a SHA-256 slice of the
  tenant id — **opaque** (never the raw id → no PII/handle to the provider or logs),
  **stable per tenant** (so a tenant's own prefix reuse still hits the cache), and
  **brand-neutral** (no product name — preserves the white-label
  no-`OPENWOP`-in-the-prompt guarantee).
- It is **prepended to the first system message's content**, NOT added as a second
  system message: the Anthropic dispatch path keeps only the first system turn and
  the chat-responder de-dupes back-to-back systems, so a separate sentinel message
  could be silently dropped. A leading sentinel *inside* the one system message
  survives every provider path.
- Effect: identical prompts across tenants produce **different prefix bytes** → the
  provider prefix cache structurally **misses** cross-tenant, while each tenant's own
  reuse still **hits** (within-tenant economy preserved).

Properties: **wire-invisible** (never on the OpenWOP wire, an event, or an advert —
so **no RFC and no capability advertisement**), **replay-invariant** (present on every
call → hit-vs-miss outcome unchanged), **secret-free**.

### Economy analysis
`OPENWOP_MANAGED_SYSTEM_PROMPT`'s fallback (`FALLBACK_SYSTEM_PROMPT`) is ~3 sentences
(**≪512 tokens**), so the default prompt alone never reaches MiniMax's cache floor —
cross-tenant sharing only fires on **tenant-supplied ≥512-token prefixes** (exactly
the potentially-private content we want isolated). So the caching economy the
sentinel forgoes is minimal; the isolation invariant dominates.

## Alternatives

1. **Do nothing** — rejected: abandons the elevated cross-tenant-cache-isolation
   invariant for the one place it silently doesn't hold.
2. **Stop surfacing `cachedReadTokens`** — moot: already internal-only on the managed
   path, and it treats the symptom (a signal) not the cause (a shared cache entry).
3. **A `user`/metadata provider param** — rejected as unreliable: OpenAI's `user`
   field does not scope prompt caching (abuse-monitoring only) and MiniMax's behavior
   for it is undocumented, so it would be an **unverified** isolation claim. A
   content sentinel is guaranteed (content-addressed caches key on the bytes).
4. **Advertise `promptPrefixCache.providers:["minimax"]`** — rejected: a dishonest
   wire claim (we are not shipping the RFC 0116 `cachePrefixId` feature for MiniMax,
   only closing its automatic-cache leak).

### Precondition (adversarial-review note)
Isolation assumes the tenant's system message is the **leading** prefix — the stamp
targets the first `system` message wherever it sits, so a caller that led with a
≥512-token *user* turn *before* any system message would present an un-scoped shared
prefix. This holds for every in-tree managed caller today (the default injection puts
system at index 0, and `conversationToolLoop` leads with a system turn), but it is a
caller convention, not an invariant of the stamp. If a future managed caller can lead
with non-system content, move the sentinel to the absolute message[0] (accepting the
second-system-message dedup risk that motivated the in-system placement) or enforce
system-leading at the managed boundary.

## Follow-up (not blocking)
If an operator sets a **long** custom `OPENWOP_MANAGED_SYSTEM_PROMPT` (≥512 tokens)
AND the resulting per-tenant re-caching cost proves material, refine to
**identity-class scoping**: isolate authenticated `user:`/`org:` tenants (who may load
private context) while letting transient `anon:` tenants share the public default
prefix. Deferred — the current default-prompt length makes it unnecessary today.

## Implementation record
- `providers/managedProvider.ts` — `cacheScopeHash` + `prependCacheScope`; the
  sentinel prepend in `prepareManagedDispatch`.
- `test/mmxc1-managed-cache-scope.test.ts` — born-red witness on the REAL outbound
  MiniMax body (captured off the fetch mock): sentinel present, differs cross-tenant,
  stable within-tenant, raw id never sent. Sabotage-verified (no-op the stamp → all
  four red).
- `test/managed-provider.test.ts` — the system-prompt-injection tests updated: the
  caller/override prompt is preserved (containment) and led by the brand-neutral
  sentinel; the white-label `not.toMatch(/OpenWOP/i)` guarantee still holds.
