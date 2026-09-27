/**
 * feature.notebooks.nodes — Research Notebooks feature nodes over the
 * `ctx.features.notebooks` surface (ADR 0084). Read nodes: `ask` (grounded
 * retrieve → augmentedPrompt + citations, generation deferred downstream — the
 * `feature.kb.nodes` `rag` precedent) and `search` (raw hits). Transformations T1
 * nodes for the `notebooks.summarize` built-in workflow: `read-source` (reads a
 * source's full text → a chatCompletion `messages` payload) and `store-summary`
 * (persists the LLM summary via the one justified surface write).
 *
 * REPLAY CLASSIFICATION (ADR 0678 D1 — this docblock used to get it backwards, pack-wide).
 * It asserted that every node being `role:"action"` means the engine records its outputs and
 * replay/fork read the recorded result. That inference is FALSE and it is what hid the defect
 * ADR 0678 fixes: nothing under `src/executor/` compares `role` to the string 'action'
 * (`sideEffects.ts:193-197`). What binds is `gen-side-effect-floor.mjs:139` —
 * `role === 'side-effect' OR capabilities includes 'side-effectful'`, a disjunction. So the
 * FIVE durable writers below declare `capabilities:["side-effectful"]` explicitly
 * (`store-summary`, `write-transformation`, `ingest-source`, `mcp-add-source`,
 * `mcp-create-note`) and the other nine declare `capabilities: []` — an empty array rather
 * than a missing key, so a read's non-classification is a reviewed decision a diff can show.
 * `transcribe-source` and `fetch-youtube-source` are deliberately NOT classified: they write
 * no durable app state, and declaring them would land them in the generator's invocation-log
 * arm, where the ratchet would report a discharge that does not hold for the egress half.


/** DEBT-3 — audio-transcription default in ONE greppable constant. Mirrors the
 *  host's own audio default (aiProvidersHost.ts transcribeManaged →
 *  gemini-2.5-flash), NOT the google `recommended` text model: audio capability
 *  isn't modeled in providers.json, so the text default can't be assumed
 *  audio-capable. The /refresh-model-catalog sweep updates it. */

import { createHash } from 'node:crypto';

const DEFAULT_TRANSCRIBE_MODEL = 'gemini-2.5-flash';

/** Resolve the notebooks feature surface, or fail with the canonical capability
 *  error (workflow-register should refuse a workflow needing it on a host that
 *  doesn't expose it — ADR 0014 gating; this is the runtime backstop). The
 *  summarize-workflow nodes need `getSourceText`/`setSourceSummary` too, so check
 *  the methods each node actually uses at its own call site. */
function ensureNotebooks(ctx) {
  const nb = ctx.features && ctx.features.notebooks;
  if (!nb) {
    throw Object.assign(
      new Error('host does not expose ctx.features.notebooks — the notebooks feature must be composed (ADR 0084)'),
      { code: 'host_capability_missing', capability: 'host.sample.notebooks' },
    );
  }
  return nb;
}

/** Resolve the Documents feature surface, or fail with the canonical capability
 *  error — mirrors ensureNotebooks. The transformation OUTPUT lands in Documents
 *  (the single owner of stored artifacts, ADR 0053), so write-transformation needs
 *  both createDocument + addVersion. The strategy create-board-memo precedent writes
 *  to Documents the same way (ADR 0080). */
function ensureDocuments(ctx) {
  const docs = ctx.features && ctx.features.documents;
  if (!docs || typeof docs.createDocument !== 'function' || typeof docs.addVersion !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.documents — the documents feature must be composed and enabled (ADR 0084 Transformations T2)'),
      { code: 'host_capability_missing', capability: 'host.sample.documents' },
    );
  }
  return docs;
}

/** Read a string input ('' when absent). The summarize-workflow nodes get
 *  notebookId/sourceId via `{type:'variable'}` declarations the executor merges
 *  into ctx.inputs (the anniversary-draft `resource` precedent); `summary` arrives
 *  on the store-summary node via an edge port from the chatCompletion `content`. */
function strInput(ctx, key) {
  const i = ctx.inputs ?? {};
  return typeof i[key] === 'string' ? i[key] : '';
}

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  return {
    notebookId: typeof i.notebookId === 'string' ? i.notebookId : '',
    query: typeof i.query === 'string' ? i.query : '',
    queries: Array.isArray(i.queries) ? i.queries.filter((q) => typeof q === 'string' && q.length > 0) : [],
    topK: typeof i.topK === 'number' ? i.topK : undefined,
  };
}

export async function ask(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.ask !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.ask is unavailable'), { code: 'host_capability_missing' });
  }
  const { notebookId, query, queries, topK } = inputs(ctx);
  // Multi-query: fan-out one surface ask per query, else a single query. Each call
  // is a recorded action read; merging happens in the pack (concat prompt blocks,
  // dedupe citations by documentId, concat contexts).
  const qs = queries.length > 0 ? queries : [query];
  const promptBlocks = [];
  const contexts = [];
  const citations = [];
  const seen = new Set();
  for (const q of qs) {
    const out = await notebooks.ask({ notebookId, query: q, topK });
    if (out.augmentedPrompt) promptBlocks.push(out.augmentedPrompt);
    for (const c of out.contexts ?? []) contexts.push(c);
    for (const cite of out.citations ?? []) {
      if (cite && typeof cite.documentId === 'string' && !seen.has(cite.documentId)) {
        seen.add(cite.documentId);
        citations.push(cite);
      }
    }
  }
  return {
    status: 'success',
    outputs: {
      augmentedPrompt: promptBlocks.join('\n\n'),
      citations,
      contexts,
    },
  };
}

export async function search(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.searchNotebook !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.searchNotebook is unavailable'), { code: 'host_capability_missing' });
  }
  const { notebookId, query, topK } = inputs(ctx);
  const out = await notebooks.searchNotebook({ notebookId, query, topK });
  return { status: 'success', outputs: { hits: out.hits ?? [] } };
}

/**
 * read-source (ADR 0084 Transformations T1) — the FIRST node of `notebooks.summarize`.
 * Reads a source's full text via the host surface and emits a chatCompletion-ready
 * `messages` payload for the downstream `core.ai.chatCompletion` node. An EMPTY
 * source (missing / private / blank) emits `empty:true` + no messages so the run
 * short-circuits to a clean no-op instead of asking the LLM to summarize nothing.
 *
 * notebookId/sourceId come via `{type:'variable'}` inputs (merged into ctx.inputs).
 * Read-only. A READ: re-executing it on a replay is harmless, which is why it is
 * deliberately NOT in the side-effect floor (ADR 0678 D1) — "recorded" was never the reason.
 */

export async function readSource(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.getSourceText !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.getSourceText is unavailable'), { code: 'host_capability_missing' });
  }
  const notebookId = strInput(ctx, 'notebookId');
  const sourceId = strInput(ctx, 'sourceId');
  // Optional system prompt: when present (the transform workflow supplies the
  // template's systemPrompt as a small variable), it is prepended so the FULL source
  // text is fetched IN-RUN rather than inlined into run.inputs by the route — keeping
  // the run record small for large sources, and consistent with the summarize path.
  const systemPrompt = strInput(ctx, 'systemPrompt').trim();
  const out = await notebooks.getSourceText({ notebookId, sourceId });
  const text = typeof out?.text === 'string' ? out.text : '';
  if (text.trim().length === 0) {
    return { status: 'success', outputs: { empty: true, messages: [] } };
  }
  const messages = systemPrompt.length > 0
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }]
    : [{ role: 'user', content: text }];
  return {
    status: 'success',
    outputs: {
      empty: false,
      // The chatCompletion node reads ctx.inputs.messages; wire this `messages`
      // output to its `messages` input port.
      messages,
    },
  };
}

/**
 * store-summary (ADR 0084 Transformations T1) — the LAST node of `notebooks.summarize`.
 * Persists the LLM summary (the chatCompletion `content`, wired in via an edge port
 * to the `summary` input) through the one justified surface write `setSourceSummary`,
 * which un-gates the source's `summary` context level + recomputes the binding
 * projection. notebookId/sourceId come via `{type:'variable'}` inputs. An empty
 * summary is a no-op (`stored:false`). Replay-SERVED because the manifest declares `capabilities:["side-effectful"]` (ADR 0678 D1);
 * `role:"action"` confers nothing.
 */
export async function storeSummary(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.setSourceSummary !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.setSourceSummary is unavailable'), { code: 'host_capability_missing' });
  }
  const notebookId = strInput(ctx, 'notebookId');
  const sourceId = strInput(ctx, 'sourceId');
  const summary = strInput(ctx, 'summary').trim();
  if (summary.length === 0) {
    return { status: 'success', outputs: { stored: false } };
  }
  const res = await notebooks.setSourceSummary({ notebookId, sourceId, summary });
  return { status: 'success', outputs: { stored: res?.stored === true } };
}

/**
 * write-transformation (ADR 0084 Transformations T2) — the LAST node of the
 * `notebooks.transform` built-in workflow. Persists an applied transformation's
 * result (the chatCompletion `content`, wired in via an edge port to the `content`
 * input) as a **Document** owned by the notebook subject — the notebooks surface
 * stays READ-ONLY; the write lands in Documents (the single owner of stored
 * artifacts, ADR 0053; the strategy create-board-memo precedent, ADR 0080).
 *
 * Inputs (orgId/title/kind/ownerSubject via `{type:'variable'}`; content via the
 * edge port): mints the Document at a CONTENT-DERIVED deterministic id, then appends its
 * first version. CORRECTED (ADR 0678 D1b): this used to say the version write "is
 * idempotency-keyed off the run id + the source so a replay/fork reuses the same version".
 * It was INERT — the key embedded a fresh `runId` AND the just-minted `documentId`, so it
 * could only collide with itself. The dedupe now happens at the MINT, which is the only
 * place it can. An empty result is a no-op (`written:false`).
 * Recorded → replay-safe BECAUSE the manifest declares `capabilities:["side-effectful"]`
 * (ADR 0678 D1) — NOT because the role is "action", which confers nothing.
 */
export async function writeTransformation(ctx) {
  const docs = ensureDocuments(ctx);
  const orgId = strInput(ctx, 'orgId');
  const title = strInput(ctx, 'title') || 'Transformation';
  const kind = strInput(ctx, 'kind') || 'notebook-transformation';
  const content = strInput(ctx, 'content').trim();
  const i = ctx.inputs ?? {};
  // ownerSubject arrives as an object {kind, id} via a {type:'variable'} declaration.
  // HARDENING (ADR 0084 review): a notebook transformation is ALWAYS owned by a
  // `project` subject (the notebook). Constrain the kind so a chat-driven caller
  // (the Research Analyst supplies this arg) can never mint a Document owned by an
  // arbitrary `user`/`agent` subject — the createDocument org-guard already blocks
  // cross-org; this closes the cross-subject-KIND surface. A non-project owner is
  // dropped (the Document is created un-owned rather than mis-attributed).
  const rawOwner =
    i.ownerSubject && typeof i.ownerSubject === 'object' && !Array.isArray(i.ownerSubject)
      ? i.ownerSubject
      : undefined;
  const ownerSubject =
    rawOwner && rawOwner.kind === 'project' && typeof rawOwner.id === 'string' && rawOwner.id.length > 0
      ? rawOwner
      : undefined;
  if (!orgId || content.length === 0) {
    return { status: 'success', outputs: { written: false } };
  }
  // ADR 0678 D1b — the dedupe has to happen at the document MINT, and the id has to be
  // CONTENT-derived.
  //
  // The previous key was `notebook-transformation:${runId}:${nodeId}:${sourceId}:${documentId}`
  // and was INERT: it embedded a `runId` that is fresh on every fork AND a `documentId` minted
  // by the `createDocument` on the line above, so it could only ever collide with itself — on a
  // fork or a plain retry. `addVersion`'s lookup is scoped to
  // `listVersions(tenant, org, documentId)` (`documentsService.ts:483-486`), so against a
  // freshly-minted document it searches an EMPTY list and no key can match. Its comment cited
  // "the strategy create-board-memo precedent" — the very pattern ADR 0676 D1 corrected as a
  // no-op one iteration earlier, so the defect propagated by citation.
  //
  // NOT routed through `ctx.features.documents.createDraftDocument` (the ADR 0166 owner, and
  // what ADR 0676 D1 used for strategy) for a measured reason: that surface does NOT accept
  // `ownerSubject` (`features/documents/surface.ts:69-92`), so routing through it would
  // silently drop the ADR 0084 cross-subject hardening enforced twenty lines above — closing an
  // idempotency gap by opening an attribution one. `createDocument` short-circuits on an
  // explicit id (`documentsService.ts:326-329`), which is the same dedupe with the owner intact,
  // and is what `features/strategy/agentTools.ts:266-272` already does correctly.
  //
  // Scope: this converges a `mode:'branch'` fork too, where classification does NOT apply —
  // `sourceOutcomes` is populated only for `mode:'replay'` (`routes/runs.ts:1725`).
  const sourceId = strInput(ctx, 'sourceId');
  const idemBase = createHash('sha256')
    .update(`${orgId}\u0000${kind}\u0000${sourceId}\u0000${title}\u0000${content}`)
    .digest('hex')
    .slice(0, 32);
  const documentId = `doc:notebook-transformation:${idemBase}`;
  const { document } = await docs.createDocument({
    orgId,
    documentId,
    title,
    kind,
    format: 'markdown',
    ...(ownerSubject ? { ownerSubject } : {}),
  });
  await docs.addVersion({
    orgId,
    documentId: document.documentId,
    content,
    idempotencyKey: `notebook-transformation:${idemBase}`,
  });
  return { status: 'success', outputs: { written: true, documentId: document.documentId, title } };
}

/** Resolve `ctx.callAI`, or fail with the canonical capability error (the
 *  transcribe-source node needs the provider primitive; workflow-register should
 *  refuse a workflow needing it on a host without it — this is the runtime backstop,
 *  mirroring the core.openwop.ai pack). */
function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — the transcribe-source node needs the provider primitive (RFC 0091)'),
      { code: 'host_capability_missing', capability: 'aiProviders' },
    );
  }
}

/**
 * transcribe-source (ADR 0085 Phase 3) — the FIRST node of the
 * `notebooks.ingest-audio` built-in workflow. Feeds an uploaded audio/video
 * source's bytes to a multimodal model via `ctx.callAI` with an `{type:'audio'}`
 * ContentPart (RFC 0091 §A — audio input, advertised in lockstep by ADR 0085
 * Phase 1) and returns the verbatim transcript. NO new wire surface: transcription
 * here is `callAI` + an audio part, not a distinct capability (the ADR "Node
 * identity" rationale).
 *
 * Inputs: `audioBase64` + `mimeType` (the source bytes, supplied in run inputs by
 * the upload route) + optional `language`. provider/model come from ctx.config
 * (google / gemini default — an audio-capable provider; the host BYOK key resolves
 * via ADR 0024). An empty/blank `audioBase64` is a clean no-op (`empty:true`) so a
 * mis-enqueued run short-circuits rather than calling the model with no audio.
 *
 * Side-effectful (a provider call) → recorded in the host's invocation log; a
 * replay/fork reuses the cached transcript rather than re-calling the model.
 */
/** Hard cap on the audio bytes fed to a single transcription call (ADR 0085 OQ-3
 *  hardening) — a very long recording exceeds the model context AND is costly, so
 *  reject it up front with a clear error rather than firing an expensive doomed
 *  provider call. ~32 MiB decoded ≈ a long podcast at a sane bitrate. */
const MAX_TRANSCRIBE_DECODED_BYTES = 32 * 1024 * 1024;

export async function transcribeSource(ctx) {
  ensureCallAI(ctx);
  const audioBase64 = strInput(ctx, 'audioBase64');
  const mimeType = strInput(ctx, 'mimeType') || 'audio/mpeg';
  const language = strInput(ctx, 'language').trim();
  if (audioBase64.trim().length === 0) {
    return { status: 'success', outputs: { empty: true, transcript: '' } };
  }
  // ~3/4 of the base64 length is the decoded byte count — cheap pre-check.
  if (Math.floor((audioBase64.length * 3) / 4) > MAX_TRANSCRIBE_DECODED_BYTES) {
    throw Object.assign(
      new Error(`Audio exceeds the ${Math.round(MAX_TRANSCRIBE_DECODED_BYTES / (1024 * 1024))} MiB transcription cap — split it into shorter segments.`),
      { code: 'audio_too_large' },
    );
  }
  const cfg = ctx.config ?? {};
  const provider = typeof cfg.provider === 'string' && cfg.provider.length > 0 ? cfg.provider : 'google';
  const model = typeof cfg.model === 'string' && cfg.model.length > 0 ? cfg.model : DEFAULT_TRANSCRIBE_MODEL;
  const instruction =
    'Transcribe this recording verbatim into plain text. Output ONLY the transcript — no preamble, ' +
    'commentary, or timestamps.' + (language ? ` The spoken language is ${language}.` : '');
  const result = await ctx.callAI({
    provider,
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'audio', mimeType, dataBase64: audioBase64 },
        ],
      },
    ],
  });
  const transcript = typeof result?.content === 'string' ? result.content.trim() : '';
  return { status: 'success', outputs: { empty: transcript.length === 0, transcript } };
}

/** Resolve the host-mediated SSRF-guarded fetch (RFC 0076 §B), or fail with the
 *  canonical capability error — the YouTube caption fetch MUST go through the host's
 *  egress guard, never a raw fetch (ADR 0085 Phase 4). */
function ensureSafeFetch(ctx) {
  const hf = ctx.http && ctx.http.safeFetch;
  if (typeof hf !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.http.safeFetch — SSRF-guarded egress is required for the YouTube caption fetch (RFC 0076)'),
      { code: 'host_capability_missing', capability: 'host.http.safeFetch' },
    );
  }
  return hf;
}

/** Read a `safeFetch` response body with a hard byte cap (MEDIA-4 / SSRF
 *  response-size bound). In production undici exposes a web stream (`res.body`),
 *  so we abort mid-stream the moment the cap is exceeded — a missing or lying
 *  `content-length` can no longer OOM the host. Test mocks expose only
 *  `.text()`/`.arrayBuffer()`, so there we read fully then length-check (the
 *  mock payloads are tiny). Returns `{ over, bytes }`. */
async function readBodyCapped(res, maxBytes) {
  const reader = res && res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* stream already closing */ }
        return { over: true, bytes: Buffer.alloc(0) };
      }
      chunks.push(Buffer.from(value));
    }
    return { over: false, bytes: Buffer.concat(chunks) };
  }
  const buf = typeof res.arrayBuffer === 'function'
    ? Buffer.from(await res.arrayBuffer())
    : Buffer.from(await res.text(), 'utf8');
  return { over: buf.length > maxBytes, bytes: buf };
}

/** Cap for the HTML watch page + the caption-track XML reads (a watch page is
 *  ~1–3 MiB; 8 MiB is generous headroom that still bounds memory). */
const YT_TEXT_MAX_BYTES = 8 * 1024 * 1024;

/** Decode the small set of XML/HTML entities that appear in YouTube timedtext. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));
}

/** Brace-match a JSON object that follows `marker` in `html` (string-aware), so a
 *  deeply-nested player response is extracted reliably (a non-greedy regex can't).
 *  Returns the parsed object or null. */
function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  let i = html.indexOf('{', at);
  if (i === -1) return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Pull the caption track text from the watch-page HTML (or null when none). */
/** Resolve a caption-track baseUrl from the watch HTML — first the unescaped
 *  `"captionTracks":[…]` literal, then a fallback through the parsed
 *  `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`
 *  (the page sometimes only carries it nested). Returns '' when none. */
function youtubeCaptionBaseUrl(html) {
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (m) {
    try {
      const tracks = JSON.parse(m[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"'));
      if (Array.isArray(tracks) && typeof tracks[0]?.baseUrl === 'string') return tracks[0].baseUrl;
    } catch { /* fall through to the player-response parse */ }
  }
  const player = extractJsonAfter(html, 'ytInitialPlayerResponse');
  const nested = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(nested) && typeof nested[0]?.baseUrl === 'string') return nested[0].baseUrl;
  return '';
}

/** Only fetch caption/stream URLs on Google/YouTube-owned hosts (defense-in-depth
 *  on top of ctx.http.safeFetch's SSRF guard): the URLs are extracted from
 *  attacker-influenceable watch-page HTML, so a youtube.com open-redirect or a
 *  doctored captionTracks[].baseUrl can't turn this into a content-controlled
 *  egress primitive to an arbitrary public host (review fix). */
function isGoogleOwnedHost(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return /(^|\.)(youtube\.com|googlevideo\.com|google\.com|ytimg\.com|gstatic\.com)$/.test(h);
  } catch { return false; }
}

async function youtubeCaptions(safeFetch, html) {
  const baseUrl = youtubeCaptionBaseUrl(html);
  if (!baseUrl) return null;
  const ttUrl = baseUrl.replace(/\\u0026/g, '&');
  if (!isGoogleOwnedHost(ttUrl)) return null; // refuse off-Google caption hosts
  const ttRes = await safeFetch(ttUrl, {});
  if (!ttRes || ttRes.status >= 400) return null;
  const ttCap = await readBodyCapped(ttRes, YT_TEXT_MAX_BYTES);
  if (ttCap.over) return null; // an absurdly large caption track → treat as no captions
  const xml = ttCap.bytes.toString('utf8');
  const lines = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map((t) => decodeEntities(t[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim())
    .filter((t) => t.length > 0);
  const transcript = lines.join('\n').trim();
  return transcript.length > 0 ? transcript : null;
}

/** Best-effort: extract a directly-fetchable audio stream URL from the page's
 *  `ytInitialPlayerResponse`. Returns { url, mimeType } or null. Streams behind a
 *  `signatureCipher` (no plain `url`) are skipped — deciphering needs a JS-VM
 *  (yt-dlp-class), out of scope; those videos fall through to `no_transcript`. */
function youtubeAudioStream(html) {
  const player = extractJsonAfter(html, 'ytInitialPlayerResponse');
  const formats = player?.streamingData?.adaptiveFormats;
  if (!Array.isArray(formats)) return null;
  const audio = formats
    .filter((f) => typeof f?.mimeType === 'string' && f.mimeType.startsWith('audio/') && typeof f.url === 'string')
    .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0))[0]; // smallest bitrate = cheapest/fastest to transcribe
  if (!audio) return null;
  return { url: audio.url, mimeType: audio.mimeType.split(';')[0].trim() };
}

const YT_AUDIO_MAX_BYTES = 24 * 1024 * 1024; // cap the STT-fallback download

/**
 * fetch-youtube-source (ADR 0085 Phase 4) — the FIRST node of the
 * `notebooks.ingest-youtube` built-in workflow. Two-tier:
 *   1. CAPTIONS (preferred) — fetch the watch page, pull a `captionTracks[].baseUrl`,
 *      fetch the timedtext, strip XML → transcript. Higher-fidelity + far cheaper.
 *   2. STT FALLBACK — when no captions exist, best-effort extract a directly-fetchable
 *      audio stream from `ytInitialPlayerResponse`, download it (≤24 MiB), and run it
 *      through the same multimodal-`ctx.callAI` audio path as transcribe-source
 *      (RFC 0091). Streams behind a `signatureCipher` (no plain url) can't be fetched
 *      without a JS-VM deciphering step, so those throw `no_transcript`.
 *
 * Inputs: `url`. All egress is via `ctx.http.safeFetch` (SSRF-guarded, RFC 0076).
 * Side-effectful (network + maybe a model call) → recorded; replay reuses the result.
 */
export async function fetchYoutubeSource(ctx) {
  const safeFetch = ensureSafeFetch(ctx);
  const url = strInput(ctx, 'url').trim();
  if (url.length === 0) {
    throw Object.assign(new Error('url is required'), { code: 'validation_error' });
  }
  const noTranscript = (msg) => Object.assign(new Error(msg), { code: 'no_transcript' });
  const pageRes = await safeFetch(url, { headers: { 'accept-language': 'en' } });
  if (!pageRes || pageRes.status >= 400) {
    throw noTranscript(`Could not fetch the YouTube page (status ${pageRes?.status ?? 'n/a'}).`);
  }
  const pageCap = await readBodyCapped(pageRes, YT_TEXT_MAX_BYTES);
  if (pageCap.over) throw noTranscript('The YouTube page is too large to parse.');
  const html = pageCap.bytes.toString('utf8');

  // Tier 1 — captions.
  const captions = await youtubeCaptions(safeFetch, html);
  if (captions) return { status: 'success', outputs: { empty: false, transcript: captions, source: 'captions' } };

  // Tier 2 — STT fallback over the audio stream (needs ctx.callAI).
  if (typeof ctx.callAI !== 'function') {
    throw noTranscript('No captions are available, and audio transcription is unavailable on this host.');
  }
  const stream = youtubeAudioStream(html);
  if (!stream) {
    throw noTranscript('No captions are available, and the audio stream is not directly fetchable for this video.');
  }
  if (!isGoogleOwnedHost(stream.url)) throw noTranscript('The audio stream host is not a Google/YouTube origin.');
  const audioRes = await safeFetch(stream.url, {});
  if (!audioRes || audioRes.status >= 400) throw noTranscript('Could not fetch the audio stream.');
  // Early-out on a declared oversize, then stream-read with the same hard cap so a
  // missing/lying content-length can't buffer an unbounded body into memory.
  const declared = Number(audioRes.headers?.get?.('content-length') ?? 0);
  if (declared > YT_AUDIO_MAX_BYTES) throw noTranscript('The audio stream is too large to transcribe.');
  const audioCap = await readBodyCapped(audioRes, YT_AUDIO_MAX_BYTES);
  if (audioCap.over) throw noTranscript('The audio stream is too large to transcribe.');
  const bytes = audioCap.bytes;
  if (bytes.length === 0) throw noTranscript('The audio stream was empty.');
  const cfg = ctx.config ?? {};
  const provider = typeof cfg.provider === 'string' && cfg.provider.length > 0 ? cfg.provider : 'google';
  const model = typeof cfg.model === 'string' && cfg.model.length > 0 ? cfg.model : DEFAULT_TRANSCRIBE_MODEL;
  const result = await ctx.callAI({
    provider,
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe this audio verbatim into plain text. Output ONLY the transcript.' },
        { type: 'audio', mimeType: stream.mimeType || 'audio/mp4', dataBase64: bytes.toString('base64') },
      ],
    }],
  });
  const transcript = typeof result?.content === 'string' ? result.content.trim() : '';
  if (transcript.length === 0) throw noTranscript('Transcription produced no text.');
  return { status: 'success', outputs: { empty: false, transcript, source: 'stt' } };
}

/**
 * ingest-source (ADR 0084 deferred / ADR 0085 Phase 5) — the LAST node of the
 * audio + YouTube ingest workflows. Persists a transcript as an ordinary notebook
 * KB source via the ONE narrow surface write `ctx.features.notebooks.ingestSource`
 * (untrusted, like every notebook source). Downstream it IS a KB document — search,
 * citations, and per-source context levels (ADR 0084) all apply unchanged.
 *
 * Inputs: `notebookId` + `title` + optional `sourceType` (audio|video|youtube, woven
 * into the title for provenance) via `{type:'variable'}`; `text` arrives via an edge
 * port from the upstream transcribe/fetch node's `transcript` output. Empty text ⇒
 * no-op (`ingested:false`). Replay-SERVED because the manifest declares `capabilities:["side-effectful"]` (ADR 0678 D1);
 * `role:"action"` confers nothing.
 *
 * SECURITY: this node is wired ONLY into the host-built-in ingest workflows the
 * upload ROUTE enqueues (RBAC workspace:write); it is deliberately NOT in the
 * Research Analyst agent's allowlist, so chat-driven ingest of arbitrary content
 * stays closed (ADR 0084's injection-surface rationale).
 */
export async function ingestSource(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.ingestSource !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.ingestSource is unavailable'), { code: 'host_capability_missing' });
  }
  const notebookId = strInput(ctx, 'notebookId');
  const baseTitle = strInput(ctx, 'title').trim() || 'Transcribed source';
  const sourceType = strInput(ctx, 'sourceType').trim();
  const text = strInput(ctx, 'text').trim();
  if (notebookId.length === 0 || text.length === 0) {
    return { status: 'success', outputs: { ingested: false } };
  }
  const title = sourceType ? `${baseTitle} (${sourceType})` : baseTitle;
  const res = await notebooks.ingestSource({ notebookId, title, text });
  return {
    status: 'success',
    outputs: { ingested: res?.ingested === true, sourceId: res?.sourceId ?? '', title },
  };
}

/**
 * READ nodes that back the notebook MCP tools (ADR 0087) — each wraps one
 * `ctx.features.notebooks` read so a `notebooks.mcp.*` expose-tool workflow has a
 * terminal node whose output becomes the CallToolResult. All org-visibility +
 * tenant scoping is the HOST surface's job (inherited, never reimplemented here).
 * Read-only. A READ: re-executing it on a replay is harmless, which is why it is
 * deliberately NOT in the side-effect floor (ADR 0678 D1) — "recorded" was never the reason.
 */
export async function listNotebooks(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.listNotebooks !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.listNotebooks is unavailable'), { code: 'host_capability_missing' });
  }
  const out = await notebooks.listNotebooks({});
  return { status: 'success', outputs: { notebooks: out.notebooks ?? [] } };
}

export async function getNotebook(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.getNotebook !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.getNotebook is unavailable'), { code: 'host_capability_missing' });
  }
  const out = await notebooks.getNotebook({ notebookId: strInput(ctx, 'notebookId') });
  return { status: 'success', outputs: { notebook: out.notebook ?? null } };
}

export async function listSourcesNode(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.listSources !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.listSources is unavailable'), { code: 'host_capability_missing' });
  }
  const out = await notebooks.listSources({ notebookId: strInput(ctx, 'notebookId') });
  return { status: 'success', outputs: { sources: out.sources ?? [] } };
}

export async function listNotesNode(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.listNotes !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.listNotes is unavailable'), { code: 'host_capability_missing' });
  }
  const out = await notebooks.listNotes({ notebookId: strInput(ctx, 'notebookId') });
  return { status: 'success', outputs: { notes: out.notes ?? [] } };
}

/**
 * WRITE nodes that back the HITL-gated notebook MCP write tools (ADR 0087 OQ-1).
 * Each reads its args from `{type:'variable'}` inputs (the MCP arguments) AND a
 * `decision` from an edge port (the upstream `core.hitl.approval-request` output);
 * it performs the write ONLY when `decision === 'accept'`, else it is a clean no-op
 * (`declined:true`). This makes the human approval load-bearing: an untrusted MCP
 * client cannot mutate the workspace until a workspace member approves. The writes
 * land through the same narrow surface methods the host already exposes (untrusted
 * content fenced downstream). Replay-SERVED because the manifest declares `capabilities:["side-effectful"]` (ADR 0678 D1);
 * `role:"action"` confers nothing.
 */
export async function mcpAddSource(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.ingestSource !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.ingestSource is unavailable'), { code: 'host_capability_missing' });
  }
  if (strInput(ctx, 'decision') !== 'accept') {
    return { status: 'success', outputs: { written: false, declined: true } };
  }
  const notebookId = strInput(ctx, 'notebookId');
  const title = strInput(ctx, 'title').trim() || 'Source';
  const text = strInput(ctx, 'text').trim();
  if (notebookId.length === 0 || text.length === 0) {
    return { status: 'success', outputs: { written: false } };
  }
  const res = await notebooks.ingestSource({ notebookId, title, text });
  return { status: 'success', outputs: { written: res?.ingested === true, sourceId: res?.sourceId ?? '' } };
}

export async function mcpCreateNote(ctx) {
  const notebooks = ensureNotebooks(ctx);
  if (typeof notebooks.addNote !== 'function') {
    throw Object.assign(new Error('ctx.features.notebooks.addNote is unavailable'), { code: 'host_capability_missing' });
  }
  if (strInput(ctx, 'decision') !== 'accept') {
    return { status: 'success', outputs: { created: false, declined: true } };
  }
  const notebookId = strInput(ctx, 'notebookId');
  const content = strInput(ctx, 'content').trim();
  if (notebookId.length === 0 || content.length === 0) {
    return { status: 'success', outputs: { created: false } };
  }
  const res = await notebooks.addNote({ notebookId, content });
  return { status: 'success', outputs: { created: res?.created === true } };
}

export const nodes = {
  'feature.notebooks.nodes.ask': ask,
  'feature.notebooks.nodes.search': search,
  'feature.notebooks.nodes.read-source': readSource,
  'feature.notebooks.nodes.store-summary': storeSummary,
  'feature.notebooks.nodes.write-transformation': writeTransformation,
  'feature.notebooks.nodes.transcribe-source': transcribeSource,
  'feature.notebooks.nodes.fetch-youtube-source': fetchYoutubeSource,
  'feature.notebooks.nodes.ingest-source': ingestSource,
  'feature.notebooks.nodes.list-notebooks': listNotebooks,
  'feature.notebooks.nodes.get-notebook': getNotebook,
  'feature.notebooks.nodes.list-sources': listSourcesNode,
  'feature.notebooks.nodes.list-notes': listNotesNode,
  'feature.notebooks.nodes.mcp-add-source': mcpAddSource,
  'feature.notebooks.nodes.mcp-create-note': mcpCreateNote,
};

export default nodes;
