# ADR 0229 — Campaign Studio: creative asset operations (image-provider declarations, asset lineage, rendered concepts)

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `media` (lineage + `ctx.features.media` surface), `campaign-channels` (render-concepts node), connection-pack examples |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5D **D3** (E5's asset half: provider packs + channel wiring + lineage + a variants surface) |
| **Depends on** | ADR 0115 (image-generation seam + budget), ADR 0007 (media library), ADR 0157/0166 (creative-briefs channel), RFC 0095 (connection packs), RFC 0055 (media-asset serving) |
| **RFC gate** | **None** — host-ext composition over accepted seams (RFC 0095 packs are declarations; no wire change). |

> Numbering: verified next-free slot at authoring time was **0226** (main tops out
> at 0225; no open PRs claim 0226/0227). The delivery plan estimated "~0228".

## Decision

Three additive pieces, no new primitive:

1. **Image-gen provider declarations (RFC 0095 example packs).**
   `examples/connection-packs/openai-images` and `…/google-imagen` — `api_key`
   providers declaring the TARGET shape (API hosts, auth kind, consumer nodes
   `core.openwop.ai.image-generate` + `feature.campaign-channels.nodes.render-concepts`)
   for the host image seam's `openai` / `google` providers (ADR 0115 Phase 6).
   **Honesty statement (verified in `host/imageProviderAdapter.ts`):** the image
   seam resolves its endpoint + key from ENV
   (`OPENWOP_IMAGE_PROVIDER_ENDPOINT[_OPENAI|_GOOGLE]` +
   `OPENWOP_IMAGE_PROVIDER_KEY[_…]`, honest-off until set) — it does **NOT**
   resolve credentials through the Connections broker. These packs declare the
   shape only; each pack description says exactly that. **Broker resolution for
   the image seam is a recorded follow-on** — we did NOT wire a second
   credential path.

2. **Asset lineage on media.** `MediaAsset` gains OPTIONAL
   `lineage?: { derivedFrom?, generatedBy?: 'ai', prompt? (≤2000), model? (≤120), rightsNote? (≤400) }`
   — additive, sanitized by ONE `cleanLineage()` (bounded strings, unknown keys
   dropped, `generatedBy` a closed vocabulary), stored via the existing
   create/update paths (`createAsset`/`updateAsset` + the POST/PATCH asset
   routes), and surfaced in every asset read (`viewAsset` spreads the record).
   `lineage: null` on PATCH clears it — reversible, never partial-merged.

3. **Rendered concepts for the creative-briefs channel.**
   `feature.campaign-channels.nodes.render-concepts` (pack minor → 1.2.0), an
   **OPTIONAL** agent/chain-callable verb — deliberately NOT added to the channel
   child workflow spine (generate → approve is unchanged). It takes a
   `creative_briefs` draft + `{ maxImages?: 1..3, default 1 }`, renders one image
   per brief direction via the SAME ctx delegate `core.openwop.ai.image-generate`
   uses (`ctx.callImageGenerator` — never a pack HTTP client), and registers each
   image as a durable Media-Library asset WITH lineage (`generatedBy:'ai'`,
   prompt, model) through the new narrow `ctx.features.media` surface. Outputs
   carry asset refs + serve URLs so the EXISTING artifact workbench renders
   variants side-by-side. The Channel Generator agent's toolAllowlist gains the
   node (agents pack → 1.1.0).

### The `ctx.features.media` surface (narrow by design)

Media had no workflow surface; it gains exactly ONE method:
`createAssetFromServeUrl({ orgId, url, name?, tags?, collectionId?, lineage? })`.
Not create-from-base64: on this host generated image bytes never cross the node
result boundary (ADR 0115 stores them host-side and returns an RFC 0055 serve
URL), so the surface resolves the caller's serve token (tenant-checked — a
foreign/expired token reads as not-found), enforces the SAME upload-MIME
allowlist + org capacity gate as the upload route, and re-stores the bytes on
the durable library path (the seam's copy is scratch-TTL). Media is always-on
(ADR 0027) ⇒ the surface is ungated at the seam (the `gate()` always-on
exception).

### Budget & honesty

- **Budget:** the per-tenant daily image budget (ADR 0115 Phase 5,
  `host/imageGenBudget.ts`) is enforced INSIDE `callImageGenerator` before the
  metered dispatch — verified, so the node adds **no second budget path**; a
  spent budget surfaces as the seam's `provider_rate_limited` (partial renders
  are kept and reported via `truncatedBy`).
- **Honest-off:** no wired provider ⇒ the seam's `host_capability_missing`
  passes through unchanged — the node never fakes a render.

## Boundaries (explicit, from the plan)

- **No new studio UI** — variants render in the existing chat artifact
  workbench from the node's asset refs; zero SPA changes in this ADR.
- **Performance-linked creative scoring is OUT** — it needs C5 attribution data
  history before a score can mean anything (gap analysis §5D/§6).
- **No broker-resolved image credentials yet** — recorded follow-on (above). **RESOLVED by ADR 0244 (2026-07-04):** the image seam now resolves the api_key through the Connections broker (a workspace-scoped Connection, KMS-enveloped, wins over the env key); the endpoint stays env-configured (it is non-secret host infra, not a credential). The two connection-pack honesty statements are corrected accordingly.

## Alternatives weighed

- *Wire the packs into a real broker-resolved image credential path*: rejected
  here — it is a host-seam change (ADR 0115 territory) and would have made the
  packs' declarations load-bearing before the seam can honor them.
- *Put render-concepts on the channel workflow spine*: rejected — it would make
  every creative-briefs run image-budget-bearing and change the approval flow;
  optional verb keeps the spine byte-identical.
- *A second byte path (node-side base64 → media)*: rejected — ADR 0115's "raw
  bytes never cross the result boundary" stands; the surface resolves the serve
  token instead.

## Verification

`test/campaign-creative-assets.test.ts` — lineage sanitize/persist/read (+ clear
on PATCH), the media surface tenant/MIME/token guards, render-concepts honest-off
without the delegate/surface, stubbed-delegate render → asset with lineage +
outputs carry refs, maxImages clamp, budget-style mid-run failure keeps partial
renders (`truncatedBy`). Existing suites extended: `campaign-channels.test.ts`
(node inventory + allowlist).
