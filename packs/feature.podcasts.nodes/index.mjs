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
 * result back via recordEpisodeResult. Every node is `role:"action"` (reads/writes the
 * tenant store, or calls a provider — a side-effect), so outputs are recorded and a
 * replay/fork reads the recorded result. Pure-JS, Node-20 stdlib.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

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
  if (!episode) return { status: 'success', outputs: { context: '' } };
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
  if (!episode) return { status: 'success', outputs: { outline: '' } };
  const context = strInput(ctx, 'context');
  const model = episodeProfile?.outlineModel || 'claude-sonnet-4-6';
  const segmentCount = episodeProfile?.segmentCount || 5;
  const briefing = episodeProfile?.defaultBriefing || episode.briefing || '';
  const systemPrompt =
    `You are a podcast producer outlining an audio episode titled "${episode.title}". ` +
    `Produce a tight ${segmentCount}-segment outline (one short bullet per segment) covering the source material. ` +
    'Plain text, no preamble.';
  const userParts = [];
  if (briefing) userParts.push(`Briefing: ${briefing}`);
  if (context) userParts.push(`Source material:\n${context}`);
  const result = await ctx.callAI({
    provider: providerForModel(model),
    model,
    systemPrompt,
    messages: [{ role: 'user', content: userParts.join('\n\n') || `Outline an episode titled "${episode.title}".` }],
  });
  const text = typeof result?.content === 'string' ? result.content.trim() : '';
  await writeDocument(ctx, episode, `${episode.title} — outline`, 'podcast-outline', text, `podcast-outline:${ctx.runId}:${episodeId}`)
    .then((docId) => docId && pod.recordEpisodeResult({ episodeId, outlineDocRef: docId }));
  return { status: 'success', outputs: { outline: text } };
}

export async function transcript(ctx) {
  ensureCallAI(ctx);
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const { episode, episodeProfile, speakerProfile } = await resolveConfig(ctx, pod, episodeId);
  if (!episode) return { status: 'success', outputs: { turns: [] } };
  const outlineText = strInput(ctx, 'outline');
  const speakers = speakerProfile?.speakers ?? [{ name: 'Host', voiceId: '' }];
  const segmentCount = episodeProfile?.segmentCount || 5;
  const model = episodeProfile?.transcriptModel || 'claude-sonnet-4-6';
  const cast = speakers
    .map((s) => `- ${s.name}${s.personality ? ` (${s.personality})` : ''}${s.backstory ? ` — ${s.backstory}` : ''}`)
    .join('\n');
  const names = speakers.map((s) => s.name);
  const systemPrompt =
    'You are scripting a natural multi-speaker podcast dialogue. Respond with ONLY a JSON array of turns, ' +
    'each `{"speaker": <one of the cast names>, "text": <what they say>}`. No prose outside the JSON. ' +
    `Use these speakers exactly: ${names.join(', ')}. Aim for roughly ${segmentCount * 2} turns covering the outline.`;
  const result = await ctx.callAI({
    provider: providerForModel(model),
    model,
    systemPrompt,
    messages: [{ role: 'user', content: `Cast:\n${cast}\n\nOutline:\n${outlineText}` }],
  });
  const turns = parseTurns(typeof result?.content === 'string' ? result.content : '', names);
  // A readable transcript Document (ADR 0053) — owned by the notebook subject.
  const rendered = turns.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
  await writeDocument(ctx, episode, `${episode.title} — transcript`, 'podcast-transcript', rendered, `podcast-transcript:${ctx.runId}:${episodeId}`)
    .then((docId) => docId && pod.recordEpisodeResult({ episodeId, transcriptDocRef: docId }));
  return { status: 'success', outputs: { turns } };
}

export async function synthesize(ctx) {
  ensureSpeech(ctx);
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const { episode, episodeProfile, speakerProfile } = await resolveConfig(ctx, pod, episodeId);
  if (!episode) return { status: 'success', outputs: { clips: [] } };
  const i = ctx.inputs ?? {};
  const turns = Array.isArray(i.turns) ? i.turns : parseTurns(typeof i.turns === 'string' ? i.turns : '', []);
  const speakers = speakerProfile?.speakers ?? [];
  const voiceByName = new Map(speakers.map((s) => [s.name, s.voiceId]));
  const fallbackVoice = speakers[0]?.voiceId || '';
  const provider = speakerProfile?.provider || 'minimax';
  const model = speakerProfile?.model;
  const languageCode = episodeProfile?.languageCode;
  const clips = [];
  for (const turn of turns) {
    const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
    if (text.length === 0) continue;
    const voiceId = voiceByName.get(turn.speaker) || fallbackVoice;
    if (!voiceId) continue; // no cast voice resolved — skip rather than fail the whole run
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
    }
  }
  return { status: 'success', outputs: { clips } };
}

export async function mix(ctx) {
  const pod = ensurePodcasts(ctx);
  const episodeId = strInput(ctx, 'episodeId');
  const i = ctx.inputs ?? {};
  const clips = Array.isArray(i.clips) ? i.clips : [];
  // Assemble the ordered clip list on the episode (the Studio player plays them
  // sequentially — always available). THEN attempt a single-file mux: concatenate
  // the clips into one playable asset where the codec allows (MP3 byte-concat / WAV
  // rewrap, ADR 0086 §mix). Mux failure (mixed codecs) degrades to the playlist.
  await pod.recordEpisodeResult({ episodeId, clips });
  let audioMediaRef = '';
  if (clips.length > 0 && typeof pod.mixClips === 'function') {
    const mixed = await pod.mixClips({ clips });
    if (mixed && typeof mixed.url === 'string' && mixed.url.length > 0) {
      audioMediaRef = mixed.url;
      await pod.recordEpisodeResult({ episodeId, audioMediaRef });
    }
  }
  return { status: 'success', outputs: { clipCount: clips.length, audioMediaRef } };
}

/** Create a Document owned by the notebook subject + append its first version
 *  (idempotency-keyed so a fork reuses it). Returns the documentId or '' when the
 *  documents feature isn't composed / the content is empty. */
async function writeDocument(ctx, episode, title, kind, content, idempotencyKey) {
  const docs = ctx.features && ctx.features.documents;
  if (!docs || typeof docs.createDocument !== 'function' || typeof docs.addVersion !== 'function') return '';
  if (!content || content.trim().length === 0) return '';
  const { document } = await docs.createDocument({
    orgId: episode.orgId,
    title,
    kind,
    format: 'markdown',
    ownerSubject: { kind: 'project', id: episode.notebookId },
  });
  await docs.addVersion({ orgId: episode.orgId, documentId: document.documentId, content, idempotencyKey });
  return document.documentId;
}

/** Defensively parse the transcript LLM output into `[{speaker,text}]`. Extracts the
 *  first JSON array; filters to the known cast names when provided. */
function parseTurns(raw, allowedNames) {
  if (typeof raw !== 'string') return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const allowed = Array.isArray(allowedNames) && allowedNames.length > 0 ? new Set(allowedNames) : null;
  return parsed
    .map((t) => ({ speaker: typeof t?.speaker === 'string' ? t.speaker : '', text: typeof t?.text === 'string' ? t.text : '' }))
    .filter((t) => t.text.length > 0 && (!allowed || allowed.has(t.speaker)));
}

export const nodes = {
  'feature.podcasts.nodes.select-content': selectContent,
  'feature.podcasts.nodes.outline': outline,
  'feature.podcasts.nodes.transcript': transcript,
  'feature.podcasts.nodes.synthesize': synthesize,
  'feature.podcasts.nodes.mix': mix,
};

export default nodes;
