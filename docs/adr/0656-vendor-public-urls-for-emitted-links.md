# ADR 0656 — links this host emits into the world use the RFC 0181 canonical root, not the `/v1` twin

Status: Accepted (implemented in this PR)

## Context

While enumerating self-addressed URLs for the December retirement flag (the
peer host's finding in crosstalk `35c8`: a retired host refused its own
callbacks), a different class surfaced: **45 line-level sites in 20 backend
files build absolute URLs under `/v1/host/openwop-app/…` and hand them to
OTHER parties** — email approval links, engagement click/open/unsubscribe/
preferences links, sitemaps, `llms.txt`, canonical and OG URLs, podcast feeds
and episode audio, share-card images, signed certificates, dealer tokens, the
UCP commerce manifest. The v1-reliance ratchet counts these as literals but
cannot see what they are: links that live in inboxes, search indexes and
podcast apps. `versioning.md` §5 retires the `/v1/host/openwop-app/` twin
atomically with `/v1`, so every such link emitted before the switch dies on
that day. The earlier the canonical form ships, the fewer dead links exist.

The inventory splits into classes with different dispositions
(`v1-deprecate-now-retire-on-clock` memory, 2026-09-11):

1. **Durable outbound artifacts** — move now (this PR): 25 sites in 12 files.
2. **Provider-registered URLs** — OAuth redirect URIs
   (`features/connections/oauthFlow.ts`) and inbound email-provider webhook
   addresses (`features/email/routes.ts`): the provider console holds the
   value, so they change only after re-registration. Untouched here; on the
   flag checklist.
3. **In-app relative URLs the SPA consumes** (`host/inMemorySurfaces.ts`,
   `host/runArtifactStore.ts`, `canvas-packs/feature.ts`): migrate with the
   SPA step. Untouched.
4. **Not emissions** (route-registration patterns, validators). Untouched.
5. **Self-traffic / peer calls** — `messaging/bridge.ts:330` (this host's own
   agent endpoint) and `priority-matrix/federationService.ts` (a PEER host's
   extension API, which may not serve the canonical root yet): stay on the
   twin through the overlap; the flag unit moves them.

## Decision

- `features/featureRoute.ts` gains `vendorPublicBase(base)` (=
  `<base>/host/openwop-app`) and `vendorPublicUrl(base, path)` beside the
  existing `publicBaseUrl(req)`. They are the ONE way an emitted link enters
  the vendor namespace; `VENDOR_ROOT` comes from the negotiator's single
  owner (ADR 0652).
- The 25 class-1 sites are rewritten `${base}/v1/host/openwop-app/…` →
  `${vendorPublicBase(base)}/…`. A regex codemod did it; a diff pass over all
  25 lines caught two that the regex could not judge — the federation peer
  call (reverted, class 5) and the engagement "already tracked" check, which
  must recognise BOTH spellings because bodies rendered before this ADR carry
  the twin form (fixed).
- The canonical links resolve through ADR 0652's mount; the five test files
  that pinned the twin spelling in fixtures, extractions and follow-up
  fetches now pin the canonical one and, by fetching it, witness the mount
  end to end for the email click, unsubscribe and preference routes.
- The ratchet's `backendHostExtensionPathRefs` falls 781 → 758 and is
  re-baselined with this attribution.

## Consequences

- New emails, feeds, sitemaps and cards carry links that survive the
  retirement. Links already in the world keep working through the overlap.
- A `vendorPublicBase` literal ratchet is the next tripwire: forbid
  `/v1/host/openwop-app/` in the class-1 files by name, so the twin cannot
  creep back into an emitter. Deferred to the flag unit, which owns the list.

## Implementation record

| what | where |
|---|---|
| `vendorPublicBase`, `vendorPublicUrl` | `backend/typescript/src/features/featureRoute.ts` |
| 25 emitter rewrites in 12 files (email approval, engagement, email service, publishing ×4, sharing, podcasts ×2, UCP) | `backend/typescript/src/{host,features}/…` |
| tests moved to the canonical spelling | `test/{adr0384-section-html,analytics-identity-link,consent-channels,email-engagement,email-markdown-body}.test.ts` |
| ratchet baseline 781 → 758 | `scripts/v1-reliance-baseline.json` |
