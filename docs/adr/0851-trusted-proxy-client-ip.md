# ADR 0851 — One client-IP helper: walk X-Forwarded-For from the right, skipping trusted hops

Status: Accepted — implemented 2026-10-07 (this PR). The post-deploy witness (§Rollout) is owed.

Fixes #4516 (HIGH). Supersedes the "first `X-Forwarded-For` hop" convention cited
in ADR 0640 §Context, ADR 0785 §Security and ADR 0798 §"Deliberately not shipped".

## Context

`middleware/rateLimit.ts` `clientIp(req)` returned the **leftmost**
`X-Forwarded-For` entry. Google's front end (GFE) **appends** the TCP peer it saw,
so everything to the left of the appended entries is whatever the client sent. A
client that sends a fresh `X-Forwarded-For: <random>` on every request gets a
fresh bucket every time. Every per-IP budget was bypassable: reads, writes,
run creation, pairing and CLI-login starts, and the public email, consent and
form endpoints.

The same reading had been copied, not imported, into four more places:

| Site | Reading | Effect |
|---|---|---|
| `host/sseChannel.ts` `capKey` | leftmost | anon SSE stream cap spoofable |
| `features/analytics/visitorIdentity.ts` | leftmost | visitor hash attacker-chosen |
| `routes/authBreakGlass.ts` | **rightmost** | correct at a direct door; at the Firebase door the rightmost entry is Hosting's egress, so every caller shares ONE brute-force window |
| `features/crm/signRoutes.ts` | `req.ip` | no `trust proxy` is set, so this is the front end's address, not the signer's — the e-signature audit `ipHash` records Google, not the signer |

`auth.ts` (key `lastUsedIp`), `claude-code/routes.ts` and
`developer-keys/cliLoginRoutes.ts` already import `clientIp`, so they inherit the fix.

### What the doors actually send (MEASURED 2026-10-07, read-only)

Cloud Run's request log `httpRequest.remoteIp` is the TCP peer the GFE saw,
i.e. the entry the GFE appends. Grouped by host over 5,000 requests since
2026-10-05:

| Door | Host seen by Cloud Run | `remoteIp` (GFE-appended entry) |
|---|---|---|
| Firebase Hosting rewrite (`app.openwop.dev/api/**`, and `/` prerender) | `…jkav3gnlqa-uc.a.run.app` | **always Google**: 74.125/16, 192.178/15, 66.102/20, 64.233/19, 66.249/19, 142.250/15 |
| Direct `*.run.app` (SSE `streamBase`, CLI) | `…89896419173.us-central1.run.app` | the real client (IPv4 and IPv6) |
| Domain mapping | `api.openwop.dev` | the real client |

1,732 of 1,732 Firebase-door requests carried a Google peer; zero direct-door
requests did. So the header shapes are:

```
direct / domain mapping : <client-supplied…>, <client>
Firebase rewrite        : <client-supplied…>, <client>, <Hosting egress>
```

That the client sits immediately left of the Hosting entry at the Firebase door
is MEASURED by correlation, not read off a header (there is no echo route).
The old code logged its leftmost entry on every `ip rate limit hit`. Since
2026-08-01 there are 860 such lines, all for two non-Google addresses
(`24.247.253.170`, `207.91.239.87`). Matching each line to the 429 request log
within 0.5 s, 859 match a Firebase-door request whose `remoteIp` is a Google
egress address. A browser sends no `X-Forwarded-For`, so Hosting itself wrote
the client address into the header. The post-deploy witness in §Rollout checks
the remaining case: a client that sends its own header.

## Decision

**ONE helper, `clientIp(req)` in `host/clientIp.ts`**, with Express's own
`trust proxy` algorithm (`proxy-addr`'s closest-untrusted walk, implemented over
`node:net` `BlockList` so no dependency or lockfile change is added) and a trust
predicate over **address ranges**, not hop counts:

1. Build the chain `[socket peer, xffN, …, xff1]` (closest first).
2. Return the first address that is **not** trusted. If every address is
   trusted, return the farthest one.

Trusted by default:

- loopback, RFC 1918 / ULA private, link-local (`169.254/16`, `fe80::/10`) —
  the Cloud Run container's own socket peer is a link-local front-end address,
  and a self-hosted reverse proxy on a private network needs no config;
- Google's own (non-GCP-customer) front-end and egress netblocks, which is where
  the Firebase Hosting hop and the documented GFE proxy ranges
  (`35.191.0.0/16`, `130.211.0.0/22`) live;
- `OPENWOP_TRUSTED_PROXY_CIDRS` — comma-separated CIDRs an operator ADDS (a
  white-label adopter behind Cloudflare, an internal LB).

`OPENWOP_TRUSTED_PROXY_DEFAULTS=private` drops the Google ranges (a deployment
that is not behind Google's front end should not trust them).

Why ranges, not a hop count: the two doors differ by one hop, and nothing in the
request tells them apart that a client cannot forge (a direct caller can send the
Firebase door's `Host` and `/api` path). A hop count of 2 would hand a direct
caller the spoofed entry; a hop count of 1 would bucket every Firebase-door user
on Hosting's egress address — one global limit for the main door. The range rule
is door-independent: the GFE-appended entry is either the client (direct) or a
Google address we skip (Firebase).

On Cloud Run (`K_SERVICE` is set by the platform) the socket peer is always the
platform's front end, so it is trusted unconditionally there. The container's
peer address is not documented and was not measured; trusting it by range alone
would turn a wrong guess into ONE bucket for every user.

Entries are normalised before the trust check: IPv4-mapped IPv6
(`::ffff:a.b.c.d`) becomes `a.b.c.d`, and a `host:port` / `[v6]:port` suffix is
removed. An entry that is not an IP address is never trusted, so the walk stops
on it.

Why the socket peer is in the chain: with it, a deployment exposed directly to
the internet (no proxy) ignores `X-Forwarded-For` entirely, because its socket
peer is untrusted — which is what `trust proxy` gets right and a bare
"rightmost entry" rule gets wrong.

Why not app-wide `app.set('trust proxy', fn)` and `req.ip`: it also makes
`req.protocol` / `req.secure` / `req.hostname` honour forwarded headers, which
`host/requestOrigin.ts` deliberately reads locally instead. Changing cookie
`secure` semantics is out of scope for a rate-limit fix. The helper exports its
trust predicate, which is the shape `app.set('trust proxy', fn)` takes, so
switching later is a small change.

Every consumer above uses the helper. The rate limiter's loopback self-traffic
exemption (`isLoopbackSelf`) reads the socket too, so it moves into the helper
as `isDirectLoopback(req)`. A ratchet test fails on any other
`x-forwarded-for`, `req.ip`, `req.ips` or `socket.remoteAddress` read under
`src/`.

### Per-principal second layer — not in this ADR

Self-service API keys (ADR 0798 `apiKeyRateLimitMiddleware`), operator env keys
(ADR 0771) and MCP principals (ADR 0087) already have their own buckets. A
cookie-session principal bucket would not stop the abuse this fixes (anonymous
sessions are minted on demand), so it is residue, not part of the fix.

## Alternatives weighed

| Option | Verdict |
|---|---|
| Leftmost entry (status quo) | the defect |
| Rightmost entry (break-glass) | correct at direct doors; one global bucket at the Firebase door |
| Fixed hop count | wrong at one of the two doors, whichever count is chosen |
| Per-door hop count keyed on `Host`/path | the door signal is forgeable at the direct door |
| `Fastly-Client-IP` / `X-Appengine-User-Ip` | forgeable at the direct door; Fastly no longer fronts Hosting |
| **Range-trust walk (chosen)** | door-independent; Express's own algorithm |

## Residue (stated, accepted)

- **Google-owned non-Cloud egress can still spoof.** Apps Script `UrlFetchApp`
  and some Google crawler and proxy paths connect from the same goog-not-cloud
  blocks as Hosting's egress. A caller using one of them, at the Firebase door or
  directly at `jkav3gnlqa-uc.a.run.app`, has its Google address skipped as a
  trusted hop, and its spoofed entry is read. GCP customer VMs (`cloud.json`) are
  NOT trusted; a test pins that against a committed snapshot. Mitigations weighed:
  - *A Firebase-only marker that turns Google trust on.* None exists that a direct
    caller cannot forge. With `ingress=all` anyone can send any header to the
    run.app URL, and the only unforgeable signal is the TCP peer, which Apps Script
    shares with Hosting. (The measurement read request-log `remoteIp` and host, not
    request headers, so this is reasoned, not header-measured.)
  - *A per-principal second layer.* It does not close this: anonymous sessions are
    minted on demand, and API keys, operator keys and MCP principals already have
    their own buckets.
  - *Real closure:* an origin in front of the backend whose own address can be
    trusted alone (an external load balancer in `OPENWOP_TRUSTED_PROXY_CIDRS`, with
    `OPENWOP_TRUSTED_PROXY_DEFAULTS=private`). That is a deploy-topology decision,
    and its compatibility with the Firebase rewrite is not checked here.
  Left as residue. Apps Script's own UrlFetch quotas bound the volume.
- **Google netblocks change.** The default list is a snapshot; a new Hosting
  egress range would bucket those Firebase-door users on the egress address
  (fail-closed toward the limit, never a bypass). The per-instance diagnostic
  below makes that visible; `OPENWOP_TRUSTED_PROXY_CIDRS` fixes it without a build.
- **An adopter with their own public-address proxy in front** (an external
  Application Load Balancer appends its forwarding-rule address; Cloudflare) gets
  that address as every caller's IP until they set `OPENWOP_TRUSTED_PROXY_CIDRS`.
  Before this ADR such a deployment read the leftmost entry, which was spoofable
  but per-user. This is the upgrade note in the CHANGELOG and `.env.example`.
- Per-cookie-principal budget (above).
- The limiter is per-instance (unchanged; ADR 0640).

## Architect review (2026-10-07, before implementation)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | HIGH | Where Hosting places the client in the chain is inferred, not measured. If Hosting forwarded the client's header without adding the client, the Firebase door would stay spoofable (the spoofed entry would be the first untrusted one). | Mostly retired by the log correlation in §Context: Hosting does write the client address. The case of a client-supplied header is not observable before deploy; the post-deploy witness covers it. If that witness fails, the Firebase door is no worse than before this ADR, and the direct door is still fixed |
| A2 | HIGH | The container's socket peer on Cloud Run is unmeasured. If it fell outside the trusted ranges, `X-Forwarded-For` would be ignored and every user would share one bucket | Trust the peer when `K_SERVICE` is set (above) |
| A3 | MED | `::ffff:` mapped addresses and `ip:port` entries would miss the range check | Normalise first (above) |
| A4 | MED | `isLoopbackSelf` was a second reader of the peer address | Moved into the helper (above) |
| A5 | MED | A stale Google list fails toward over-throttling, silently | `ip rate limit hit` already logs the bucket address; a Google address there is the signal. Named in Residue |
| A6 | LOW | No forms, email or consent file reads an address; they rely on the global limiter | No forms-feature edit needed |

## Rollout

1. Ship with the ratchet + spoof witness tests (sabotage-witnessed red on the
   old code).
2. Post-deploy witness (prod, read-only): 70 writes to a cheap write route with a
   different leftmost `X-Forwarded-For` each, at BOTH the Firebase door and the
   direct `run.app` door — each must 429 inside the write budget. Then confirm
   `ip rate limit hit` log lines name a non-Google address for Firebase-door
   callers.

## Implementation record

| Phase | What | Commit |
|---|---|---|
| 1 | helper + all consumers + tests + ratchet | (this PR) |
