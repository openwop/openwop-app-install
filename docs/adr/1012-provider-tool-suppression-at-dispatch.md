# ADR 1012 — a provider-executed search is suppressed where it is dispatched

Status: implemented (2026-10-30)

## Context

RFC 0256 §F requires suppression of provider-executed tools on a replay fork. The effect-seam manifest listed `provider.native-web-search` as guarded, but the only `assertEffectAllowed` was in `headlessAi.ts`. Two other lanes hand a search to the provider:

- the tools round in `aiProviders/aiProvidersHost.ts`, BYOK and managed. A replay miss falls through `viaReplayLane` to the live call;
- `dispatchReply` in `host/exchange/dispatchTurn.ts`.

So the manifest row claimed more than was true.

## Decision

Each live dispatch with `webSearch` calls `assertEffectAllowed('network-egress', …)` first, and each call site is listed in `SEAM_CALL_SITES`.

The BYOK and managed guards sit inside the `live` callback, so a recorded round is still served on replay and only a miss is refused.

## Alternatives

- **Guard inside the provider adapters.** Rejected. Those are below the run context, and they serve three unrelated lanes.
- **Fail every replay miss on a tools round.** Out of scope here. `guardModelRound` already handles the agent runner.

## Consequences

- A replay miss on a search round fails the node with `replay_source_missing` and spends nothing.
- A live run is unchanged.
- Outside a run the guard is a no-op, so ordinary chat turns are unaffected.

## Implementation record

| Phase | Result | Witness |
| --- | --- | --- |
| P1 | `aiProviders/aiProvidersHost.ts`, `host/exchange/dispatchTurn.ts`, `host/effectSeamManifest.ts` | `test/adr1002-managed-and-tools-round-replay.test.ts`, `test/adr1012-chat-native-search-replay.test.ts`, `test/effect-seam-manifest.test.ts`, sabotage-witnessed |
