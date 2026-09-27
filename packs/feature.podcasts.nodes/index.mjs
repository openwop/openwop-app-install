/**
 * feature.podcasts.nodes — the multi-speaker podcast generation pipeline (ADR 0086),
 * run on the executor. Five action nodes compose existing seams:
 *   select-content  ctx.features.notebooks.ask   → grounded context from the notebook
 *   outline         ctx.callAI + ctx.features.documents → the outline Document
 *   transcript      ctx.callAI + ctx.features.documents → the multi-speaker dialogue
 *   synthesize      ctx.callSpeechSynthesizer (RFC 0105) → per-turn audio clips
 *   mix             ctx.features.podcasts.recordEpisodeResult → assemble the clip list
 *
 * The ONLY run input is `episodeId`; each node resolves the rest authoritatively from
 * ctx.features.podcasts (episode → episodeProfile → speakerProfile) and writes its own
 * result back via recordEpisodeResult.
 *
 * REPLAY CLASSIFICATION (ADR 0679 — this header used to get it backwards). It said every node
 * being `role:"action"` means "outputs are recorded and a replay/fork reads the recorded
 * result". **That inference is FALSE.** Nothing under `src/executor/` compares `role` to
 * "action"; what binds is `gen-side-effect-floor.mjs:139` — `role === 'side-effect'` OR the
 * `side-effectful` capability — and the floor is then filtered again: a node whose reach is
 * `invocation-log` is HELD OUT of `MANIFEST_FAST_PATH_SERVED` (`:126`), which is the ONLY set
 * `isSideEffectingNode` consults (`sideEffects.ts:266`).
 *
 * What is true, per node:
 *   - `mix`, `synthesize` — declare `capabilities:["side-effectful"]`; reach `no-ai-reach`, so
 *     they ARE served and a replay reads the recorded result.
 *   - `outline`, `transcript` — reach `ctx.callAI`, so they would be HELD OUT of the served set
 *     even if declared. **Declaring them would be a NO-OP** and is deliberately NOT done
 *     (ADR 0679 D2 / `PODWF-9`); their model call is discharged by the ADR 0326 invocation log,
 *     and their Document write is made safe by the content-derived mint in `writeDocument`
 *     instead — which is stronger, because it also converges a `mode:'branch'` fork and a retry.
 *   - `select-content` — a read.
 *
 * Pure-JS + node:crypto, Node-20 stdlib.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import { createHash } from 'node:crypto';


/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function ensurePodcasts(ctx) {
  const pod = ctx.features && ctx.features.podcasts;
  if (!pod) {
    throw Object.assign(
      new Error('host does not expose ctx.features.podcasts — the podcasts feature must be composed and enabled (ADR 0086)'),
      { code: 'host_capability_missing', capability: 'host.sample.podcasts' },
    );
  }
  return pod;
}

function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.callAI'), { code: 'host_capability_missing', capability: 'aiProviders' });
  }
}

function ensureSpeech(ctx) {
  if (typeof ctx.callSpeechSynthesizer !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callSpeechSynthesizer — speech synthesis (RFC 0105) is required for the synthesize node'),
      { code: 'host_capability_missing', capability: 'aiProviders.speechSynthesis' },
    );
  }
}

function strInput(ctx, key) {
  const i = ctx.inputs ?? {};
  return typeof i[key] === 'string' ? i[key] : '';
}

/** Bound anything that lands on the durable `episode.error` field. */
const ERROR_MAX = 400;
const clipError = (s) => (typeof s === 'string' ? s : String(s)).slice(0, ERROR_MAX);

/**
 * PODC-2 + PODC-3 (ADR 0603 §3) — the ONE way this pipeline reports a failure.
 *
 * Before this, six sites returned `status:'success'` with an empty payload and the
 * run completed: `projectStatus` said `'done'`, the transcript Document was never
 * written, and the Studio showed a finished episode with no audio and no explanation.
 * That violates the CLAUDE.md non-negotiable ("invalid model output is a TYPED
 * FAILURE, never success-with-empty").
 *
 * Separately (PODC-3) the episode `error` field was declared, accepted by the
 * surface, stored by the service and typed on the wire client — and written by
 * NOTHING. The Studio has always rendered it (`PodcastStudioPage.tsx:491`,
 * `{e.error || t('episodeFailed')}`), so the whole reporting path was dead only at
 * the WRITE end. This is that write.
 *
 * The `error` write is best-effort and NEVER masks the failure: the typed failure is
 * returned whether or not the record could be updated (a deleted episode is exactly
 * the case where there is nothing to write to).
 */
async function failEpisode(pod, episodeId, code, message) {
  const text = clipError(message);
  if (pod && typeof pod.recordEpisodeResult === 'function' && episodeId) {
    try { await pod.recordEpisodeResult({ episodeId, error: text }); } catch { /* reporting must not mask the failure */ }
  }
  return { status: 'failed', error: { code, message: text } };
}

/** The episode row is the pipeline's only input; without it no node can proceed. */
const EPISODE_MISSING = 'podcast_episode_not_found';
const episodeMissing = (episodeId) => ({
  status: 'failed',
  error: {
    code: EPISODE_MISSING,
    message: `podcast episode '${clipError(episodeId)}' does not exist (deleted mid-run, or a run created with no episodeId) — there is nothing to generate`,
  },
});

/** Derive the LLM provider from a model id (the EpisodeProfile stores model ids;
 *  the host routes provider internally — RFC 0091 Unresolved Q2). Defaults anthropic. */
function providerForModel(model) {
  const m = (model ?? '').toLowerCase();
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  return 'anthropic';
}

/** Resolve { episode, episodeProfile, speakerProfile } for a run, or nulls. */
async function resolveConfig(ctx, pod, episodeId) {
  const { episode } = await pod.getEpisode({ episodeId });
  if (!episode) return { episode: null, episodeProfile: null, speakerProfile: null };
  const { profile: episodeProfile } = await pod.getEpisodeProfile({ id: episode.episodeProfileId });
  let speakerProfile = null;
  if (episodeProfile && typeof pod.getSpeakerProfile === 'function') {
    speakerProfile = (await pod.getSpeakerProfile({ id: episodeProfile.speakerProfileId })).profile ?? null;
  }
  return { episode, episodeProfile, speakerProfile };
}

export async function selectContent(ctx) {
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const { episode } = await pod.getEpisode({ episodeId });
  if (!episode) return episodeMissing(episodeId);
  const nb = ctx.features && ctx.features.notebooks;
  if (!nb || typeof nb.ask !== 'function') {
    // Notebook grounding is optional — degrade to the briefing alone rather than fail.
    return { status: 'success', outputs: { context: episode.briefing ?? '' } };
  }
  const query = episode.briefing && episode.briefing.length > 0
    ? episode.briefing
    : 'Summarize the most important points, findings, and takeaways from this notebook.';
  const out = await nb.ask({ notebookId: episode.notebookId, query });
  return { status: 'success', outputs: { context: out.augmentedPrompt ?? '' } };
}

export async function outline(ctx) {
  ensureCallAI(ctx);
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const { episode, episodeProfile } = await resolveConfig(ctx, pod, episodeId);
  if (!episode) return episodeMissing(episodeId);
  const context = strInput(ctx, 'context');
  const model = episodeProfile?.outlineModel || DEFAULT_MODEL;
  const segmentCount = episodeProfile?.segmentCount || 5;
  const briefing = episodeProfile?.defaultBriefing || episode.briefing || '';
  const systemPrompt =
    `You are a podcast producer outlining an audio episode titled "${episode.title}". ` +
    `Produce a tight ${segmentCount}-segment outline (one short bullet per segment) covering the source material. ` +
    'Plain text, no preamble.';
  const userParts = [];
  if (briefing) userParts.push(`Briefing: ${briefing}`);
  if (context) userParts.push(`Source material:\n${context}`);
  const userContent = userParts.join('\n\n') || `Outline an episode titled "${episode.title}".`;
  const askOutline = async (extraMessages) => {
    const result = await ctx.callAI({
      provider: providerForModel(model),
      model,
      systemPrompt,
      messages: [{ role: 'user', content: userContent }, ...(extraMessages ?? [])],
    });
    return typeof result?.content === 'string' ? result.content.trim() : '';
  };

  let text = await askOutline();
  if (text.length === 0) {
    // PODC-2 (ADR 0603 §3) — ONE bounded, error-FED repair on the authoring path
    // (the CLAUDE.md non-negotiable). The retry states what was wrong; it is not a
    // blind re-ask, and there is exactly one of them.
    //
    // `H2` (ADR 0603 R1) — the repair used to PREPEND `{ role: 'assistant',
    // content: '' }` to echo the failed turn. On THIS path `''` is the only value
    // that case can ever have (the repair fires precisely because the model
    // returned nothing), and an empty non-final assistant message reaches the wire
    // unfiltered — `providerForModel` defaults to `anthropic`, which rejects it.
    // The result was that the advertised `podcast_outline_empty` typed failure was
    // replaced by a raw provider error: `failEpisode` never ran, nothing reached
    // `episode.error`, and the operator saw a 400 that never named the cause. The
    // corrective USER message already carries the whole signal, so the echo is
    // simply dropped. Every other repair loop in `packs/` echoes real prior output
    // (`JSON.stringify(data ?? null)`, `String(raw ?? '')`); this pack was the only
    // one hard-coding an empty string.
    text = await askOutline([
      { role: 'user', content: 'Your previous reply was empty. Return the plain-text segment outline now — one short bullet per segment, no preamble, no JSON.' },
    ]);
  }
  if (text.length === 0) {
    // NOT `success` with `outline: ''`. A silent empty outline used to flow into the
    // transcript node, produce zero turns, and finish the run as `done`.
    return failEpisode(pod, episodeId, 'podcast_outline_empty',
      `the outline model (${model}) returned no text, twice — the episode has no script to voice`);
  }
  await writeDocument(ctx, episode, `${episode.title} — outline`, 'podcast-outline', text)
    .then((docId) => docId && pod.recordEpisodeResult({ episodeId, outlineDocRef: docId }));
  return { status: 'success', outputs: { outline: text } };
}

export async function transcript(ctx) {
  ensureCallAI(ctx);
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const { episode, episodeProfile, speakerProfile } = await resolveConfig(ctx, pod, episodeId);
  if (!episode) return episodeMissing(episodeId);
  const outlineText = strInput(ctx, 'outline');
  const speakers = speakerProfile?.speakers ?? [{ name: 'Host', voiceId: '' }];
  const segmentCount = episodeProfile?.segmentCount || 5;
  const model = episodeProfile?.transcriptModel || DEFAULT_MODEL;
  const cast = speakers
    .map((s) => `- ${s.name}${s.personality ? ` (${s.personality})` : ''}${s.backstory ? ` — ${s.backstory}` : ''}`)
    .join('\n');
  const names = speakers.map((s) => s.name);
  const systemPrompt =
    'You are scripting a natural multi-speaker podcast dialogue. Respond with ONLY a JSON array of turns, ' +
    'each `{"speaker": <one of the cast names>, "text": <what they say>}`. No prose outside the JSON. ' +
    `Use these speakers exactly: ${names.join(', ')}. Aim for roughly ${segmentCount * 2} turns covering the outline.`;
  const userContent = `Cast:\n${cast}\n\nOutline:\n${outlineText}`;
  // XCH-POD-1 (LLM-EXCHANGE-AUDIT Wave 5): responseSchema engages provider-
  // native JSON mode; result.data is preferred over defensive text parsing.
  const askTranscript = async (extraMessages) => {
    const result = await ctx.callAI({
      provider: providerForModel(model),
      model,
      systemPrompt,
      messages: [{ role: 'user', content: userContent }, ...(extraMessages ?? [])],
      responseSchema: { type: 'array', items: { type: 'object', required: ['speaker', 'text'], properties: { speaker: { type: 'string' }, text: { type: 'string' } } } },
    });
    return Array.isArray(result?.data) ? JSON.stringify(result.data) : (typeof result?.content === 'string' ? result.content : '');
  };

  let parsed = parseTurns(await askTranscript(), names);
  if (parsed.turns.length === 0) {
    // PODC-2 (ADR 0603 §3) — ONE bounded, error-FED repair. The retry is told the
    // SPECIFIC reason (`parseTurns` now returns one) — an unparseable array, or a
    // cast-name mismatch naming both sides — rather than being blindly re-asked.
    // `H2` (ADR 0603 R1) — the empty assistant echo is dropped here for the same
    // reason as `outline` above: an empty non-final assistant message is rejected by
    // the default provider, which would replace the typed
    // `podcast_transcript_unusable` failure with an unattributable 400. The reason
    // string below already carries the whole signal.
    parsed = parseTurns(await askTranscript([
      { role: 'user', content: `Your previous reply could not be used: ${parsed.reason}. Reply with ONLY a JSON array of ${'{"speaker","text"}'} objects. The "speaker" of every turn MUST be exactly one of: ${names.join(', ')}.` },
    ]), names);
  }
  if (parsed.turns.length === 0) {
    // NOT `success` with `turns: []`. That used to write an EMPTY transcript
    // Document (or none at all), synthesize zero clips, and finish the run `done`.
    return failEpisode(pod, episodeId, 'podcast_transcript_unusable',
      `the transcript model (${model}) produced no usable turns, twice — ${parsed.reason}`);
  }
  // A readable transcript Document (ADR 0053) — owned by the notebook subject.
  const rendered = parsed.turns.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
  await writeDocument(ctx, episode, `${episode.title} — transcript`, 'podcast-transcript', rendered)
    .then((docId) => docId && pod.recordEpisodeResult({ episodeId, transcriptDocRef: docId }));
  return { status: 'success', outputs: { turns: parsed.turns } };
}

export async function synthesize(ctx) {
  ensureSpeech(ctx);
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const { episode, episodeProfile, speakerProfile } = await resolveConfig(ctx, pod, episodeId);
  if (!episode) return episodeMissing(episodeId);
  const i = ctx.inputs ?? {};
  const turns = Array.isArray(i.turns)
    ? i.turns
    : parseTurns(typeof i.turns === 'string' ? i.turns : '', []).turns;
  const speakers = speakerProfile?.speakers ?? [];
  // Same normalization as `parseTurns` — a cast lookup that disagreed with the cast
  // FILTER would silently fall through to the first speaker's voice.
  const voiceByName = new Map(speakers.map((s) => [normalizeSpeaker(s.name), s.voiceId]));
  const fallbackVoice = speakers[0]?.voiceId || '';
  const provider = speakerProfile?.provider || 'minimax';
  const model = speakerProfile?.model;
  const languageCode = episodeProfile?.languageCode;
  const clips = [];
  let voiceless = 0;
  let silent = 0;
  for (const turn of turns) {
    const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
    if (text.length === 0) continue;
    const voiceId = voiceByName.get(normalizeSpeaker(turn.speaker)) || fallbackVoice;
    if (!voiceId) { voiceless++; continue; } // no cast voice resolved for this turn
    const res = await ctx.callSpeechSynthesizer({
      provider,
      ...(model ? { model } : {}),
      text,
      voiceId,
      ...(languageCode ? { languageCode } : {}),
    });
    const url = res?.audio?.url;
    if (typeof url === 'string' && url.length > 0) {
      clips.push({ speaker: turn.speaker ?? '', voiceId, url, mimeType: res.audio.mimeType || 'audio/mpeg' });
    } else {
      silent++;
    }
  }
  // PODC-2 (ADR 0603 §3) — a run with turns to voice and NO audio to show for it is
  // a failure, not a success carrying `clips: []`. The two causes are distinguished
  // because the operator's fix differs: a missing cast profile (the deleted-profile
  // path that also drove PODC-1) versus a synthesizer that returned nothing.
  if (clips.length === 0 && (voiceless > 0 || silent > 0)) {
    return voiceless > 0
      ? failEpisode(pod, episodeId, 'podcast_no_cast_voice',
        `no voice could be resolved for any of the ${voiceless} dialogue turn(s) — the episode's speaker (cast) profile is missing or has no voiceId`)
      : failEpisode(pod, episodeId, 'podcast_synthesis_returned_no_audio',
        `the speech synthesizer (${provider}) returned no audio for any of the ${silent} dialogue turn(s)`);
  }
  return { status: 'success', outputs: { clips } };
}

export async function mix(ctx) {
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const i = ctx.inputs ?? {};
  const clips = Array.isArray(i.clips) ? i.clips : [];
  // PODC-1 + PODC-2 (ADR 0603 §1/§3) — this node used to write
  // `recordEpisodeResult({ episodeId, clips })` UNCONDITIONALLY and then return
  // `status:'success'` with `clipCount: 0`. Both halves were wrong, and together they
  // were destructive: on a retry after a degraded transcript, or with a deleted cast
  // profile (every turn skipped in `synthesize`), `clips` is `[]`; the empty array
  // ERASED the episode's recorded clips, while the mux gate below (`clips.length > 0`)
  // left `audioMediaRef` pointing at the PREVIOUS audio — a published show serving old
  // audio under a Studio episode showing nothing, and a run that reported `done`.
  //
  // A mix with nothing to mix is a FAILURE, and this early return is also what keeps
  // the erasing write from ever being attempted. (The service-side length guard in
  // `recordEpisodeResult` is the load-bearing protection — it holds for every caller,
  // including the surface's per-clip validation reducing a NON-empty input to `[]`,
  // which this node cannot see.)
  if (clips.length === 0) {
    return failEpisode(pod, episodeId, 'podcast_mix_no_clips',
      'no synthesized audio clips reached the mix step — the episode has no audio to assemble');
  }
  // Assemble the ordered clip list on the episode (the Studio player plays them
  // sequentially — always available). THEN attempt a single-file mux: concatenate
  // the clips into one playable asset where the codec allows (MP3 byte-concat / WAV
  // rewrap, ADR 0086 §mix). Mux failure (mixed codecs) degrades to the playlist.
  //
  // `M2` (ADR 0603 R1) — and the write's REPORT is now checked, because it used to
  // be a lie. The surface's per-clip validation drops any clip lacking a string
  // `url`/`voiceId`, so a NON-EMPTY list here can arrive at the service as `[]` —
  // which the §1 guard correctly refuses to write, and then reported as success.
  // This node believed it and carried on to write a NEW `audioMediaRef` mixed from
  // its own unvalidated list: old clips beside new audio (the PODC-1 inconsistency
  // in reverse), returned as `status:'success'` with a `clipCount` for clips that
  // were never stored.
  //
  // The predicate covers the partial case too — if only SOME clips survived
  // validation, the list this node is about to mux is not the list the episode
  // holds, and muxing it would republish audio that does not match the recorded
  // clips. Either way the episode is left exactly as it was and the failure says
  // which clips the store refused.
  const written = await pod.recordEpisodeResult({ episodeId, clips });
  const stored = typeof written?.clipsRecorded === 'number' ? written.clipsRecorded : (written?.recorded ? clips.length : 0);
  if (!written?.recorded || stored !== clips.length) {
    return failEpisode(pod, episodeId, 'podcast_mix_clips_rejected',
      `the episode store accepted ${stored} of ${clips.length} synthesized clip(s) — every clip needs a string url and voiceId, and a partial list must not be published as the episode's audio`);
  }
  let audioMediaRef = '';
  if (typeof pod.mixClips === 'function') {
    const mixed = await pod.mixClips({ clips });
    if (mixed && typeof mixed.url === 'string' && mixed.url.length > 0) {
      audioMediaRef = mixed.url;
      await pod.recordEpisodeResult({ episodeId, audioMediaRef });
    }
  }
  // `clipCount` is what the STORE holds, never what this node hoped to write.
  return { status: 'success', outputs: { clipCount: stored, audioMediaRef } };
}

/**
 * Create a Document owned by the notebook subject + append its first version at a
 * CONTENT-DERIVED deterministic id. Returns the documentId, or `''` when
 * the documents feature isn't composed, its toggle is OFF, or the content is empty.
 *
 * `M1` (ADR 0603 R1) — the toggle case used to be neither handled nor true. The
 * absence check above only catches a surface that is NOT COMPOSED; a DISABLED
 * toggle does not remove the method, it WRAPS it (`host/featureSurfaces.ts` gates
 * per call against the run's tenant), so `createDocument` is still a function and
 * the awaited call REJECTS with `host_capability_disabled`. That throw escaped the
 * node entirely: `failEpisode` never ran, nothing reached `episode.error`, and the
 * run died with an error that never named the toggle. The undeclared-edge ratchet's
 * own justification asserted the opposite — that `writeDocument` "already returns
 * ''" with documents off — so the dependency decision rested on behaviour the code
 * did not have. It has it now.
 *
 * Scoped deliberately to `host_capability_disabled`. Swallowing EVERY error here
 * would turn a genuine storage failure into a silent "this episode has no
 * transcript" — the success-with-empty family this ADR exists to close, one layer
 * down. Anything that is not the toggle still propagates.
 */
async function writeDocument(ctx, episode, title, kind, content) {
  const docs = ctx.features && ctx.features.documents;
  if (!docs || typeof docs.createDocument !== 'function' || typeof docs.addVersion !== 'function') return '';
  if (!content || content.trim().length === 0) return '';
  // ADR 0679 D2b — the dedupe has to happen at the MINT, and the base must be CONTENT-derived.
  //
  // This used to take an `idempotencyKey` argument and apply it to `addVersion` ONLY, while
  // `createDocument` received no `documentId`. Both halves were broken, and the docblock above
  // claimed the opposite ("idempotency-keyed so a fork reuses it"):
  //   1. `createDocument` is idempotent only on a caller-supplied deterministic id
  //      (`documentsService.ts:326-329`); absent one it mints `doc:${randomUUID()}` (`:335`),
  //      so EVERY attempt created a brand-new container.
  //   2. `addVersion`'s key is scoped to that new container's version list
  //      (`documentsService.ts:484`), and the callers' keys embedded `ctx.runId`
  //      (`podcast-outline:${runId}:${episodeId}`), which a fork changes — so the key could not
  //      collide across a fork by construction.
  // Net: a replay, fork or ordinary retry leaked a duplicate outline AND transcript Document and
  // repointed `episode.{outlineDocRef,transcriptDocRef}`, orphaning the prior pair.
  //
  // The base is computed HERE, not passed in, so a call site cannot reintroduce a runId — the
  // third independent instance of that exact mistake (ADR 0676 D1 strategy, ADR 0678 D1b
  // notebooks). Fixing the generator rather than the instance is the point.
  //
  // NOT routed through `ctx.features.documents.createDraftDocument` (the ADR 0166 owner): that
  // surface does not accept `ownerSubject` (`features/documents/surface.ts:69-92`), and dropping
  // it here would orphan the Document from its notebook — the same trap ADR 0678 D1b recorded.
  const idemBase = createHash('sha256')
    .update(`${episode.orgId}\u0000${kind}\u0000${episode.id ?? ''}\u0000${content}`)
    .digest('hex')
    .slice(0, 32);
  try {
    const { document } = await docs.createDocument({
      orgId: episode.orgId,
      documentId: `doc:${kind}:${idemBase}`,
      title,
      kind,
      format: 'markdown',
      ownerSubject: { kind: 'project', id: episode.notebookId },
    });
    await docs.addVersion({ orgId: episode.orgId, documentId: document.documentId, content, idempotencyKey: `${kind}:${idemBase}` });
    return document.documentId;
  } catch (err) {
    if (err && err.code === 'host_capability_disabled') return '';
    throw err;
  }
}

/**
 * Normalize a speaker label for COMPARISON only (the canonical cast spelling is
 * always what gets stored). PODC-2 (ADR 0603 §3): the old comparison was an exact
 * `Set.has(t.speaker)` against the cast names, so a perfectly valid transcript
 * writing `"Host:"` — or `"host"`, or `" Host"` — matched NOTHING and every turn was
 * silently dropped, yielding zero turns and a `done` run with no audio.
 *
 * Deliberately NOT fuzzy. Fuzzy matching is a DIFFERENT defect: it would voice a turn
 * as the wrong cast member and be very hard to see. This strips only what is
 * unambiguously formatting — surrounding whitespace, a trailing colon, and letter
 * case. Anything that still does not match is reported, never quietly dropped.
 */
function normalizeSpeaker(s) {
  return String(s ?? '').trim().replace(/:+$/, '').trim().toLowerCase();
}

/**
 * Parse the transcript LLM output into `{ turns, reason }`. `turns` is `[]` only when
 * the output is genuinely unusable, and `reason` then says WHY in words the repair
 * prompt and the durable `episode.error` can both carry — the old version returned a
 * bare `[]` for four distinct causes, which is what made the failure unreportable.
 */
function parseTurns(raw, allowedNames) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { turns: [], reason: 'the model returned no text' };
  }
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return { turns: [], reason: 'the reply contained no JSON array (no bracketed [...] span)' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { turns: [], reason: `the bracketed span was not valid JSON (${clipError(err && err.message)})` };
  }
  if (!Array.isArray(parsed)) {
    return { turns: [], reason: 'the parsed JSON was not an array of turns' };
  }
  const names = Array.isArray(allowedNames) ? allowedNames.filter((n) => typeof n === 'string' && n.length > 0) : [];
  // normalized label → the CANONICAL cast spelling (what we store).
  const canonical = new Map(names.map((n) => [normalizeSpeaker(n), n]));
  const shaped = parsed.map((t) => ({
    speaker: typeof t?.speaker === 'string' ? t.speaker : '',
    text: typeof t?.text === 'string' ? t.text : '',
  }));
  const withText = shaped.filter((t) => t.text.length > 0);
  if (withText.length === 0) {
    return { turns: [], reason: `the array held ${shaped.length} entr${shaped.length === 1 ? 'y' : 'ies'} but none carried a non-empty "text"` };
  }
  if (canonical.size === 0) return { turns: withText, reason: '' };

  const turns = [];
  const unmatched = new Set();
  for (const t of withText) {
    const hit = canonical.get(normalizeSpeaker(t.speaker));
    if (hit === undefined) { unmatched.add(t.speaker); continue; }
    turns.push({ speaker: hit, text: t.text });
  }
  if (turns.length === 0) {
    return {
      turns: [],
      reason: `no turn named a cast member — the reply used [${[...unmatched].slice(0, 6).join(', ')}] but the cast is [${names.join(', ')}]`,
    };
  }
  // A PARTIAL mismatch is still reported, so a caller that keeps the turns can say so.
  return {
    turns,
    reason: unmatched.size > 0
      ? `dropped ${withText.length - turns.length} turn(s) naming [${[...unmatched].slice(0, 6).join(', ')}], which are not in the cast [${names.join(', ')}]`
      : '',
  };
}

export const nodes = {
  'feature.podcasts.nodes.select-content': selectContent,
  'feature.podcasts.nodes.outline': outline,
  'feature.podcasts.nodes.transcript': transcript,
  'feature.podcasts.nodes.synthesize': synthesize,
  'feature.podcasts.nodes.mix': mix,
};

export default nodes;
