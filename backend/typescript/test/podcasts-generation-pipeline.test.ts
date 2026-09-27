/**
 * ADR 0603 — the ADR 0086 podcast GENERATION pipeline (`packs/feature.podcasts.nodes`
 * + `ctx.features.podcasts`), which nothing had ever imported (DEBT-POD-1: 373 LOC
 * exercised by zero tests, which is why PODC-1 shipped and survived review).
 *
 * PODC-1 — the DESTRUCTIVE one. `mix` wrote `recordEpisodeResult({episodeId, clips})`
 * unconditionally, and `clips` is `[]` whenever the synthesize node produced nothing
 * (a degraded transcript on `POST /episodes/:id/retry`; a deleted cast profile, which
 * skips every turn at the `if (!voiceId) continue` guard). `recordEpisodeResult`
 * merges with `...(patch.clips ? { clips: patch.clips } : {})` — and `[]` is TRUTHY,
 * so the empty list OVERWROTE the recorded one, under a docblock reading "Merges
 * (never clears)". The mux gate (`clips.length > 0`) then left `audioMediaRef`
 * pointing at the PREVIOUS audio: a published show serving old audio under a Studio
 * episode showing no clips.
 *
 * These drive the REAL pack module against the REAL surface (the `adr0411-reel-node`
 * precedent), so they redden on either the service-side or the node-side guard.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { selectContent, outline, transcript, synthesize, mix } from '../../../packs/feature.podcasts.nodes/index.mjs';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createEpisode, getEpisode, recordEpisodeResult, clearEpisodeError, type EpisodeClip,
} from '../src/features/podcasts/podcastsService.js';
import { buildPodcastsSurface } from '../src/features/podcasts/surface.js';

const TENANT = 'tenant-podc1';
const ORG = 'org-podc1';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

const CLIPS: EpisodeClip[] = [
  { speaker: 'Host', voiceId: 'v-host', url: '/media/clip-one', mimeType: 'audio/mpeg' },
  { speaker: 'Guest', voiceId: 'v-guest', url: '/media/clip-two', mimeType: 'audio/mpeg' },
];

const surface = (): ReturnType<typeof buildPodcastsSurface> =>
  buildPodcastsSurface({ tenantId: TENANT } as Parameters<typeof buildPodcastsSurface>[0]);

const runMix = (episodeId: string, clips: unknown[]): ReturnType<typeof mix> =>
  mix({ inputs: { episodeId, clips }, features: { podcasts: surface() } });

async function seedEpisodeWithClips(title: string): Promise<string> {
  const ep = await createEpisode(TENANT, ORG, { notebookId: 'nb-1', episodeProfileId: 'epp-1', title });
  await recordEpisodeResult(TENANT, ep.id, { clips: CLIPS, audioMediaRef: '/media/episode-v1' });
  const seeded = await getEpisode(TENANT, ep.id);
  // Non-vacuity floor: the fixture MUST actually be in the state the regression
  // destroys. Every assertion below is about losing THESE two clips — if the seed
  // silently produced none, the "still 2 clips" assertions would be unfalsifiable.
  expect(seeded?.clips.map((c) => c.url)).toEqual(['/media/clip-one', '/media/clip-two']);
  expect(seeded?.audioMediaRef).toBe('/media/episode-v1');
  return ep.id;
}

describe('PODC-1 — recordEpisodeResult merges, and an EMPTY clips list never clears', () => {
  it('an empty `clips` patch is a NO-OP (the docblock claim, now true) — and SAYS SO', async () => {
    const episodeId = await seedEpisodeWithClips('empty patch');
    const res = await recordEpisodeResult(TENANT, episodeId, { clips: [] });
    // `M2` (R1): this used to return `{ recorded: true }` for a write it had just
    // decided to drop — the §1 fix closing a destructive write by opening a
    // success-with-empty one layer up. The report now matches the guard.
    expect(res.found, 'the episode exists — distinct from "the patch was dropped"').toBe(true);
    expect(res.recorded).toBe(false);
    expect(res.applied).toEqual([]);
    expect(res.dropped).toEqual(['clips']);
    expect(res.clipsRecorded).toBeUndefined();
    const after = await getEpisode(TENANT, episodeId);
    expect(after!.clips).toHaveLength(2);
    expect(after!.clips.map((c) => c.url)).toEqual(['/media/clip-one', '/media/clip-two']);
  });

  it('a NON-empty `clips` patch still replaces the list (the guard is not a freeze)', async () => {
    const episodeId = await seedEpisodeWithClips('non-empty patch');
    const replacement: EpisodeClip[] = [{ speaker: 'Host', voiceId: 'v-host', url: '/media/clip-three', mimeType: 'audio/mpeg' }];
    const res = await recordEpisodeResult(TENANT, episodeId, { clips: replacement });
    // The positive control for the report above: without it, every `M2` assertion
    // would be satisfied by a service that never records anything at all.
    expect(res.recorded).toBe(true);
    expect(res.applied).toEqual(['clips']);
    expect(res.dropped).toEqual([]);
    expect(res.clipsRecorded, 'the length STORED, never the length requested').toBe(1);
    const after = await getEpisode(TENANT, episodeId);
    expect(after!.clips.map((c) => c.url)).toEqual(['/media/clip-three']);
  });

  it('`M2` — a fully-dropped patch does not even bump `updatedAt`', async () => {
    const episodeId = await seedEpisodeWithClips('no-op timestamp');
    const before = (await getEpisode(TENANT, episodeId))!.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await recordEpisodeResult(TENANT, episodeId, { clips: [], error: '' });
    expect((await getEpisode(TENANT, episodeId))!.updatedAt, 'the episode did not change').toBe(before);
  });
});

describe('PODC-1 — the `mix` NODE, driven through the real ctx.features.podcasts surface', () => {
  it('a run that synthesized NO clips leaves the recorded clips AND the audio intact', async () => {
    const episodeId = await seedEpisodeWithClips('retry that produced nothing');
    // PODC-2: a mix with nothing to mix is a TYPED FAILURE (it used to return
    // `status:'success'` with `clipCount: 0`, so the run reported `done`).
    const out = await runMix(episodeId, []);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('podcast_mix_no_clips');

    const after = await getEpisode(TENANT, episodeId);
    // THE PODC-1 REGRESSION: before ADR 0603 this was `[]` — the episode's audio
    // still pointed at v1 while the Studio showed an empty episode.
    expect(after!.clips).toHaveLength(2);
    expect(after!.clips.map((c) => c.url)).toEqual(['/media/clip-one', '/media/clip-two']);
    expect(after!.audioMediaRef).toBe('/media/episode-v1');
  });

  it('the NODE-side early return is independently load-bearing', async () => {
    // Node-only reachable: with `clips: []` the node returns BEFORE the write, so the
    // erasing call is never attempted. Reverting only the node's early return still
    // reddens here (the returned status flips) while the service guard silently
    // absorbs the write — which is exactly the hiding this assertion exists to stop.
    const episodeId = await seedEpisodeWithClips('early return');
    const out = await runMix(episodeId, []);
    expect(out.status).toBe('failed');
    expect(out.outputs).toBeUndefined();
  });

  it('malformed clips (dropped by the surface\'s per-clip validation) never clear — and never report success', async () => {
    const episodeId = await seedEpisodeWithClips('all clips malformed');
    // SERVICE-only reachable: every entry fails the surface's
    // `typeof url === 'string' && typeof voiceId === 'string'` filter, so the flatMap
    // yields `[]` even though the node's input array is NON-empty — the node's length
    // gate cannot see this one, and only the service-side guard prevents the erasure.
    const out = await runMix(episodeId, [{ speaker: 'Host' }, { voiceId: 42 }]);
    // `M2` (R1) — this test USED TO ASSERT `status:'success'` here, pinning the
    // defect: the service dropped the write, said `{ recorded: true }`, and the node
    // carried on to mux and republish audio for clips that were never stored.
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('podcast_mix_clips_rejected');
    expect(out.error?.message).toContain('accepted 0 of 2');
    const after = await getEpisode(TENANT, episodeId);
    expect(after!.clips.map((c) => c.url)).toEqual(['/media/clip-one', '/media/clip-two']);
    // The half that made it an inconsistency rather than merely a lie: no NEW audio
    // was published over the old clip list.
    expect(after!.audioMediaRef).toBe('/media/episode-v1');
    expect((await getEpisode(TENANT, episodeId))!.error).toContain('accepted 0 of 2');
  });

  it('`M2` — a PARTIALLY accepted list is refused too (a mux must match what is stored)', async () => {
    const episodeId = await seedEpisodeWithClips('partially malformed');
    const out = await runMix(episodeId, [
      { speaker: 'Host', voiceId: 'v-host', url: '/media/ok', mimeType: 'audio/mpeg' },
      { speaker: 'Guest' }, // no url/voiceId — dropped by the surface
    ]);
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('accepted 1 of 2');
    // The store took the one valid clip; what must NOT happen is publishing audio
    // muxed from a two-clip list over a one-clip recording.
    const after = await getEpisode(TENANT, episodeId);
    expect(after!.clips.map((c) => c.url)).toEqual(['/media/ok']);
    expect(after!.audioMediaRef).toBe('/media/episode-v1');
  });

  it('a run that DID synthesize clips records them (the node still writes)', async () => {
    const episodeId = await seedEpisodeWithClips('successful mix');
    const out = await runMix(episodeId, [{ speaker: 'Host', voiceId: 'v-host', url: '/media/clip-new', mimeType: 'audio/mpeg' }]);
    expect(out.outputs?.clipCount).toBe(1);
    const after = await getEpisode(TENANT, episodeId);
    expect(after!.clips.map((c) => c.url)).toEqual(['/media/clip-new']);
  });
});

// ── PODC-2 / PODC-3 (ADR 0603 §3) ────────────────────────────────────────────
//
// Six sites returned `status:'success'` with an empty payload, so a wholly broken
// generation finished as `done`: `projectStatus(run.completed) === 'done'`, no
// transcript Document, no audio, and NO explanation. And the episode `error` field —
// declared, accepted, stored, typed on the wire client, and RENDERED by the Studio at
// `PodcastStudioPage.tsx:491` — was written by nothing at all.

async function seedBareEpisode(title: string): Promise<string> {
  const ep = await createEpisode(TENANT, ORG, { notebookId: 'nb-1', episodeProfileId: 'epp-1', title });
  expect((await getEpisode(TENANT, ep.id))!.error).toBeUndefined(); // floor: starts clean
  return ep.id;
}

/** A ctx whose `callAI` replies with the queued strings, one per call. */
function aiCtx(episodeId: string, replies: string[]): Record<string, unknown> {
  let n = 0;
  return {
    inputs: { episodeId, context: 'ctx', outline: '1. intro' },
    runId: 'run-podc2',
    features: { podcasts: surface() },
    callAI: async () => ({ content: replies[Math.min(n++, replies.length - 1)] ?? '' }),
  };
}

describe('PODC-2 — invalid model output is a TYPED FAILURE, never success-with-empty', () => {
  it('a missing episode fails typed instead of succeeding with an empty payload', async () => {
    for (const [name, node] of [['selectContent', selectContent], ['outline', outline], ['transcript', transcript], ['synthesize', synthesize]] as const) {
      const out = await node({
        inputs: { episodeId: 'ep-does-not-exist' },
        features: { podcasts: surface() },
        callAI: async () => ({ content: '[]' }),
        callSpeechSynthesizer: async () => ({ audio: { url: '/media/x', mimeType: 'audio/mpeg' } }),
      });
      expect(out.status, name).toBe('failed');
      expect(out.error?.code, name).toBe('podcast_episode_not_found');
    }
  });

  it('an outline model that returns nothing gets ONE repair, then fails typed + REPORTS', async () => {
    const episodeId = await seedBareEpisode('empty outline');
    let calls = 0;
    const out = await outline({
      inputs: { episodeId, context: 'ctx' },
      runId: 'run-o',
      features: { podcasts: surface() },
      callAI: async () => { calls++; return { content: '   ' }; },
    });
    expect(calls, 'exactly ONE bounded repair — not zero, not a loop').toBe(2);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('podcast_outline_empty');
    // PODC-3: the failure reached the durable field the Studio renders.
    expect((await getEpisode(TENANT, episodeId))!.error).toContain('returned no text');
  });

  it('an outline recovered by the repair still succeeds (the repair is not decorative)', async () => {
    const episodeId = await seedBareEpisode('recovered outline');
    const out = await outline(aiCtx(episodeId, ['', '1. intro\n2. body']));
    expect(out.status).toBe('success');
    expect(out.outputs?.outline).toContain('intro');
    expect((await getEpisode(TENANT, episodeId))!.error).toBeUndefined();
  });

  it('an unparseable transcript fails typed and NAMES the reason', async () => {
    const episodeId = await seedBareEpisode('unparseable transcript');
    const out = await transcript(aiCtx(episodeId, ['I am afraid I cannot do that.']));
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('podcast_transcript_unusable');
    expect(out.error?.message).toContain('no JSON array');
    expect((await getEpisode(TENANT, episodeId))!.error).toContain('no JSON array');
  });

  it('a cast-name mismatch is REPORTED, naming both sides — never silently dropped', async () => {
    const episodeId = await seedBareEpisode('cast mismatch');
    const wrong = JSON.stringify([{ speaker: 'Narrator', text: 'hello' }]);
    const out = await transcript({ ...aiCtx(episodeId, [wrong]), inputs: { episodeId, outline: 'o' } });
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('Narrator');   // what the model said
    expect(out.error?.message).toContain('Host');       // what the cast is
  });
});

describe('PODC-2 — the speaker match is NORMALIZED, not fuzzy', () => {
  const speakerCtx = (episodeId: string, body: string): Record<string, unknown> => ({
    inputs: { episodeId, outline: 'o' },
    runId: 'run-s',
    features: { podcasts: surface() },
    callAI: async () => ({ content: body }),
  });

  it('"Host:" / " host " / "HOST" all match the cast member `Host`', async () => {
    for (const label of ['Host:', ' host ', 'HOST', 'Host']) {
      const episodeId = await seedBareEpisode(`label ${label}`);
      const out = await transcript(speakerCtx(episodeId, JSON.stringify([{ speaker: label, text: 'hi' }])));
      expect(out.status, label).toBe('success');
      // stored under the CANONICAL cast spelling, never the model's variant
      expect(out.outputs?.turns, label).toEqual([{ speaker: 'Host', text: 'hi' }]);
    }
  });

  it('a genuinely different name is NOT matched (normalizing is not fuzzy matching)', async () => {
    const episodeId = await seedBareEpisode('near miss');
    // `Hosta` differs by a real character, not by formatting — voicing it as `Host`
    // would be a WORSE defect than dropping it, so it must fail loudly instead.
    const out = await transcript(speakerCtx(episodeId, JSON.stringify([{ speaker: 'Hosta', text: 'hi' }])));
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('Hosta');
  });
});

describe('PODC-2 — synthesize distinguishes WHY no audio was produced', () => {
  const synthCtx = (episodeId: string, turns: unknown[], audioUrl: string | null): Record<string, unknown> => ({
    inputs: { episodeId, turns },
    features: { podcasts: surface() },
    callSpeechSynthesizer: async () => (audioUrl ? { audio: { url: audioUrl, mimeType: 'audio/mpeg' } } : {}),
  });

  it('no resolvable cast voice → `podcast_no_cast_voice` (the deleted-profile path)', async () => {
    const episodeId = await seedBareEpisode('no cast voice');
    // No speakerProfile exists for this episode, so `speakers` is `[]` and every turn
    // used to be skipped at `if (!voiceId) continue` — producing `clips: []` under
    // `status:'success'`, which is precisely what then ERASED the clips in `mix`.
    const out = await synthesize(synthCtx(episodeId, [{ speaker: 'Host', text: 'hi' }], '/media/a'));
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('podcast_no_cast_voice');
    expect((await getEpisode(TENANT, episodeId))!.error).toContain('speaker (cast) profile');
  });

  it('zero turns to voice is NOT a synthesize failure (the upstream node already failed)', async () => {
    // Non-vacuity guard on the rule above: `synthesize` must not invent a failure for
    // a case it cannot diagnose — with no turns there is nothing skipped and nothing
    // silent, and `transcript` has already failed typed.
    const episodeId = await seedBareEpisode('zero turns');
    const out = await synthesize(synthCtx(episodeId, [], '/media/a'));
    expect(out.status).toBe('success');
    expect(out.outputs?.clips).toEqual([]);
  });
});

describe('PODC-3 — the episode `error` channel is written, and CLEARED on re-run', () => {
  it('a failed mix writes the reason onto the episode', async () => {
    const episodeId = await seedBareEpisode('mix reports');
    await runMix(episodeId, []);
    expect((await getEpisode(TENANT, episodeId))!.error).toContain('no audio to assemble');
  });

  it('`clearEpisodeError` removes it — and `recordEpisodeResult` still cannot', async () => {
    const episodeId = await seedBareEpisode('clear');
    await recordEpisodeResult(TENANT, episodeId, { error: 'boom' });
    expect((await getEpisode(TENANT, episodeId))!.error).toBe('boom');
    // The merge-never-clear rule holds for strings too: `''` is "nothing to say".
    await recordEpisodeResult(TENANT, episodeId, { error: '' });
    expect((await getEpisode(TENANT, episodeId))!.error).toBe('boom');
    // Clearing is something a caller ASKS for by name (the enqueue path does).
    expect(await clearEpisodeError(TENANT, episodeId)).toEqual({ cleared: true });
    expect((await getEpisode(TENANT, episodeId))!.error).toBeUndefined();
  });
});

// ─────────────────────────── ADR 0603 R1 ────────────────────────────
//
// `H2` and `M1` are both cases where the pack's stated behaviour and its actual
// behaviour differed on a path the MOCKED `ctx` could not reach: a message shape
// only a real provider rejects, and an error only the real toggle gate raises.

describe('H2 — the bounded repair never sends an EMPTY assistant turn', () => {
  /** Captures every `messages` array the pack hands to `callAI`. */
  function capturingCtx(episodeId: string, replies: string[]): { ctx: Record<string, unknown>; sent: Array<Array<{ role: string; content: unknown }>> } {
    const sent: Array<Array<{ role: string; content: unknown }>> = [];
    let n = 0;
    return {
      sent,
      ctx: {
        inputs: { episodeId, context: 'ctx', outline: '1. intro' },
        runId: 'run-h2',
        features: { podcasts: surface() },
        callAI: async (req: { messages: Array<{ role: string; content: unknown }> }) => {
          sent.push(req.messages);
          return { content: replies[Math.min(n++, replies.length - 1)] ?? '' };
        },
      },
    };
  }

  const noEmptyAssistant = (msgs: Array<{ role: string; content: unknown }>): void => {
    for (const m of msgs) {
      if (m.role !== 'assistant') continue;
      expect(
        typeof m.content === 'string' ? m.content.trim().length : 1,
        'a non-final assistant message with empty content is rejected by the default provider (anthropic), which would replace the TYPED failure with an unattributable 400',
      ).toBeGreaterThan(0);
    }
  };

  it('the OUTLINE repair — the one case where the echoed content could only ever be empty', async () => {
    const episodeId = await seedBareEpisode('h2 outline');
    const { ctx, sent } = capturingCtx(episodeId, ['   ']);
    const out = await outline(ctx);
    // Floors: the repair really fired, and the advertised typed failure is what the
    // operator gets. Without these the message assertion could pass on zero calls.
    expect(sent.length, 'exactly ONE bounded repair').toBe(2);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('podcast_outline_empty');
    for (const msgs of sent) noEmptyAssistant(msgs);
    // ...and the corrective USER message still carries the whole signal.
    expect(JSON.stringify(sent[1])).toContain('previous reply was empty');
  });

  it('the TRANSCRIPT repair — same shape, and it still names the specific reason', async () => {
    const episodeId = await seedBareEpisode('h2 transcript');
    const { ctx, sent } = capturingCtx(episodeId, ['I am afraid I cannot do that.']);
    const out = await transcript(ctx);
    expect(sent.length).toBe(2);
    expect(out.error?.code).toBe('podcast_transcript_unusable');
    for (const msgs of sent) noEmptyAssistant(msgs);
    expect(JSON.stringify(sent[1])).toContain('no JSON array');
  });
});

describe('M1 — a DISABLED `documents` toggle degrades; it does not kill the run untyped', () => {
  /** What `host/featureSurfaces.ts` actually does with the toggle OFF: the method is
   *  still a function (the surface is built, then WRAPPED), and it REJECTS. The
   *  absence check in `writeDocument` cannot see this — which is exactly why the
   *  ratchet's justification ("already returns ''") was false. */
  const disabledDocuments = (): Record<string, unknown> => {
    const denied = async (): Promise<never> => {
      throw Object.assign(new Error("feature 'documents' is not enabled for this tenant"), { code: 'host_capability_disabled' });
    };
    return { createDocument: denied, addVersion: denied };
  };

  it('the transcript node still SUCCEEDS, records no ref, and does not throw', async () => {
    const episodeId = await seedBareEpisode('m1 transcript');
    const out = await transcript({
      inputs: { episodeId, outline: 'o' },
      runId: 'run-m1',
      features: { podcasts: surface(), documents: disabledDocuments() },
      callAI: async () => ({ content: JSON.stringify([{ speaker: 'Host', text: 'hi' }]) }),
    });
    expect(out.status, 'the throw used to escape the node entirely — untyped, and `failEpisode` never ran').toBe('success');
    expect(out.outputs?.turns).toEqual([{ speaker: 'Host', text: 'hi' }]);
    const ep = await getEpisode(TENANT, episodeId);
    expect(ep!.transcriptDocRef, 'no ref recorded — the public page states the absence').toBeUndefined();
    expect(ep!.error, 'a disabled optional dependency is not an episode failure').toBeUndefined();
  });

  it('a NON-toggle documents failure still propagates (the catch is not a blanket swallow)', async () => {
    // The discriminating half. Swallowing every error here would turn a storage
    // outage into a silent "this episode has no transcript" — the success-with-empty
    // family one layer down.
    const episodeId = await seedBareEpisode('m1 storage');
    await expect(transcript({
      inputs: { episodeId, outline: 'o' },
      runId: 'run-m1b',
      features: {
        podcasts: surface(),
        documents: { createDocument: async () => { throw new Error('storage backend down'); }, addVersion: async () => undefined },
      },
      callAI: async () => ({ content: JSON.stringify([{ speaker: 'Host', text: 'hi' }]) }),
    })).rejects.toThrow('storage backend down');
  });
});
