# Silent film rehearsal timing and replay

Status: Accepted for implementation, 2026-11-09. DT-G83 follows ADR 1075.

A presenter explicitly starts cue-timing capture, rehearses using the existing
manual controls, stops to review, and saves a new private take. A saved take is
bound to an exact authorized source revision and an audience-safe visual hash.
The shared player replays, pauses and seeks by one monotonic clock. Nothing
requests microphone permission, captures audio, invokes a provider or changes
an existing film/release approval. Live presentation remains the default.

The host-local contract stores bounded cue IDs, transition anchors, blanking
and monotonic relative timestamps, not narration, speaker notes, source text,
wall-clock meeting telemetry or executable content. Rewind, jumps and blanking
are reconstructible at any timestamp. Reduced motion changes the displayed
interpolation, not the timing or final information. A rehearsal is limited to
one hour / 4096 events. Interrupted capture remains an explicit unsaved draft;
no draft becomes a published automatic path. Repeating capture preserves saved
takes. Saving is explicit, idempotent and append-only through Documents/CAS;
no new database, permissions model or wire capability is introduced.

Shared films owns capture/replay, validation and reusable take routes/storage.
Documents' service is an existing always-installed persistence primitive even
when its user-facing feature is off (ADR 0439); this is a documented soft
service dependency, not a new disable-lock on manual films. Documents owns
private-user ACLs, retention, deletion and version history. Take routes also
recheck the current source's tenant/org/owner authority on every request. They
read the immutable first Document version, never trust a mutable document head.
A take is private to its recorder; sharing/collaborative approval is deferred.
Canvas adapters reject a changed source version. DeckTalk may address an
explicit historical storyboard revision through its existing current ACL gate.
No stale take is silently rebound to new visuals or a new source revision.

Acceptance: deterministic pause/seek/back/jump/blank replay; invalid/unordered
or oversized tracks refused; no implicit timing/microphone/provider call; prior
takes retained; idempotent save and conflicts; foreign user/org/revoked source
refused; audience sees only visual position, never timing records or notes.
Heavy tests, builds and browser acceptance run only in bounded remote CI.
