# Shared HTML film timeline and presenter

Status: Accepted, 2026-11-07; first manual increment implemented. Focused
builds, packaging and browser acceptance passed in hosted CI. Full canonical
qualification remains in progress; local heavy checks stay stopped after the
recorded macOS VM-pressure incident.

David authorized a shared upstream film capability, beginning with timeline,
manual animation controls and presenter view, followed by DeckTalk integration.

## Decision and boundaries

Add the `films` host feature and `canvas.film`, distinct from `canvas.slides`.
One pure host-local contract in `contracts/films.ts` owns schema, bounds,
semantic validation, note-free audience projection and deterministic cue
evaluation. Both backend and frontend consume it; neither imports the other's
internals. This is not an OpenWOP wire change or a portable canvas claim.

Canvas persistence, snapshots/CAS, feature authority, Media and existing
artifact registries remain authoritative. New films default to caller-owned
canvases through an additive factory option; other canvas types keep their
existing creation behavior. No new database, token store, provider dispatcher,
workflow, recording service or message bus is introduced.

The shared player renders typed text, images and shapes as React DOM, never
customer HTML, scripts or arbitrary CSS. Cue groups simultaneously interpolate
bounded poses from prior states. Completed states hold indefinitely. Next
during a transition completes it; another distinct command advances. Back/jump
reconstruct state, not side effects. Live speaking does not imply recording,
microphone permission, transcription or TTS. Reduced motion snaps to the same
target. The first increment has no automatic narration, public sharing, hosted
rendering, remote audience networking or AI authoring; those need their own
integration/acceptance, as recorded in the film platform PRD.

Presenter and audience are different projections. Notes are absent from the
audience response and window. A same-origin paired window receives only the
sanitized film and bounded playback state, with a per-opening channel and
release/revision binding; it is not a public share link. Adopters can embed the
same player/console with their own authorized projection and source identity.

## Alternatives

Extending slide builds would retain frame-centric semantics and duplicate the
continuous film contract. A private DeckTalk engine would force later adopters
to fork it. An arbitrary HTML iframe would broaden executable-content trust.
reveal.js/Slidev provide useful UX references, but do not remove the need for
typed data, deterministic evaluation or host authority. The trade-off is a
constrained visual vocabulary initially; it can grow through the shared owner.

## Phases and verification

1. Closed FilmSpec/schema and deterministic evaluator: malformed/oversize,
   duplicate IDs/targets, forward/back/jump/group interpolation and no mutation.
2. Shared canvas feature, saved revision/editor and audience projection:
   toggle/tenant/owner/type/CAS refusal and notes omission at response boundary.
3. Manual player and presenter: indefinite holds, completion-first next,
   keyboard/focus, reduced motion, blackout and private paired audience window.
4. DeckTalk adapter: authorized saved storyboard to film, stable IDs within a
   revision, client Media references and no paid/recording requirement.

Require focused behavior tests and canonical builds/browser acceptance under
the existing resource supervisor. Do not claim a full gate from targeted checks.
The focused backend suite passed 32 tests (5 files), including caller-owned
privacy, CAS, private artifact-copy scopes and existing shared gate regressions.
The shared UI suite passed 11 tests and the canonical frontend build passed
before the final audience overlay refinement. Chromium two-window acceptance
passed before the overlay/editor-save additions; light/dark/mobile screenshots
were inspected. The branch was then refreshed onto `c9b3d0dca`.

Final build checks on that refreshed tree remain pending. The resumed UI
suite passed 11 tests; the shared/adopter browser lane passed both cases,
including the editor's explicit save and clean audience portal. During
adopter validation the resource supervisor stopped a browser run at its memory
headroom floor; the adopter's frontend type check later exhausted its capped
2304 MiB heap. David explicitly approved resuming one supervised heavy job at a
time with a 3072 MiB heap, unchanged 4 GiB process-tree budget and the same
pressure/swap stop rules. Logs/metrics are retained under
`/Users/david/.codex/outputs/shared-films-20261107/`. No full gate, release,
deployment, paid-provider run or public sharing is claimed.

The adopter's canonical frontend build then passed (2617.5 MiB measured peak,
no swap growth), but backend packaging hit the free-memory-percentage floor
(874 MiB measured peak, no swap growth). Heavy checks are stopped. A replacement
guard using the actual macOS VM pressure level, swap headroom/growth and the
same approved heap/process limits was then explicitly approved by David. Its
single backend-bundle attempt stopped at VM pressure level 2 (warning), with
1060.2 MiB measured process-tree RSS and no swap growth. Heavy work is stopped
under the persistent policy. Backend bundles and the final upstream
build/type/browser checks still require a quieter window with fresh go, or
separately approved CI. The local source and verified adopter frontend/browser
results are preserved; no release qualification is implied.

## Open decisions

The initial timeline editor edits existing scene text/notes and cue durations;
it is not yet a graphical keyframe editor or a scene/cue construction tool.
DeckTalk adapts an immutable storyboard revision into this contract. It does not
yet replace the existing narrated production bundle or migrate paid workflows.

An access witness found that user-owned canvases fell through to tenant scope:
`subjectAccess` has no user-kind membership resolver. The shared canvas read and
write predicates now enforce an exact canonical user owner match (or an explicit
already-authorized internal caller). This applies consistently to existing
user-owned canvases as well as films; unowned/project/agent policies are retained.

Later output profiles, richer primitives, narration alignment, public release
projection and remote sessions remain separate work. The first caller-owned
film canvas can later be assigned an existing project subject through the
ordinary canvas ownership rules; client labels never grant access.

## Full-gate corrections (2026-11-08)

The full backend lane exposed two film validation responses with noncanonical
top-level `errors`. They now use the shared error middleware and `details.errors`;
a real HTTP test covers both presenter and audience projections for malformed
stored films. The drawing tools' org-RBAC test now uses an org-owned drawing
for its allowed viewer read, while a separate case refuses that viewer's read
of a user-owned drawing. The private-owner predicate is retained.

This record was renumbered to 1075 after current main reserved 1074 for CMS.
The implementing correction cites ADR 1075 so the existing stale-status sweep
can see it; no ratchet admission or assertion is weakened. These corrections
require focused regression checks and a fresh full gate before promotion.
