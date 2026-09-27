/**
 * feature.kicktodo.nodes — KickTodo participant-loop nodes (ADR 0414 P4).
 * All role:"action": the engine records outputs; replay/fork read the recorded
 * result rather than re-running (no duplicate enrollments/cards/verdicts on
 * replay — the PRD §8.7 rule, inherited from the seam). Pure-JS, Node-20
 * stdlib only. Every node composes ctx.features['kicktodo-core'] (ADR 0014);
 * authorization/validation/CAS stay in the host services.
 */

function ensureKicktodo(ctx) {
  const k = ctx.features && ctx.features['kicktodo-core'];
  if (!k || typeof k.enroll !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-core'] — the KickTodo feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-core' },
    );
  }
  return k;
}

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export async function enroll(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.enroll({
    ownerSubject: str(i.ownerSubject),
    challengeId: str(i.challengeId),
    challengeVersion: num(i.challengeVersion, 1),
    ...(str(i.timezone) ? { timezone: str(i.timezone) } : {}),
  });
  // KTFULL-B4 — publish the id downstream nodes read. Node outputs do NOT
  // implicitly become variables; a step must write what the next step reads.
  if (ctx.variables && out.enrollment && typeof out.enrollment.id === 'string') {
    ctx.variables.set('enrollmentId', out.enrollment.id);
  }
  return { status: 'success', outputs: { enrollment: out.enrollment, enrollmentId: out.enrollment?.id } };
}

export async function materializeToday(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.materializeToday({ enrollmentId: str(i.enrollmentId) });
  const occurrences = Array.isArray(out.occurrences) ? out.occurrences : [];
  return { status: 'success', outputs: { occurrences, count: occurrences.length } };
}

export async function checkIn(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.checkIn({
    ownerSubject: str(i.ownerSubject),
    cardId: str(i.cardId),
    ...(str(i.note) ? { note: str(i.note) } : {}),
  });
  return { status: 'success', outputs: { checkIn: out.checkIn } };
}

export async function freezeEvidence(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.freezeEvidence({ enrollmentId: str(i.enrollmentId) });
  const s = out.snapshot ?? null;
  if (!s) return { status: 'error', error: { code: 'not_found', message: 'No judgeable state for this enrollment.' } };
  return { status: 'success', outputs: { snapshotId: s.id, snapshotHash: s.snapshotHash } };
}

export async function evaluateProgress(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.evaluate({ enrollmentId: str(i.enrollmentId), ownerSubject: str(i.ownerSubject) });
  if (!out.enrollment) return { status: 'error', error: { code: 'not_found', message: 'Enrollment not found.' } };
  return {
    status: 'success',
    outputs: { satisfied: out.satisfied === true, replayed: out.replayed === true, enrollmentState: out.enrollment.state },
  };
}

export const nodes = {
  'feature.kicktodo.nodes.enroll': enroll,
  'feature.kicktodo.nodes.materialize-today': materializeToday,
  'feature.kicktodo.nodes.check-in': checkIn,
  'feature.kicktodo.nodes.freeze-evidence': freezeEvidence,
  'feature.kicktodo.nodes.evaluate-progress': evaluateProgress,
};

export default nodes;

// ── Challenge Factory research spine (ADR 0415 P1, pack v1.1.0) ──

function ensureCreator(ctx) {
  const k = ctx.features && ctx.features['kicktodo-creator'];
  if (!k || typeof k.frameResearch !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-creator'] — the KickTodo Creator feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-creator' },
    );
  }
  return k;
}

export async function researchFrame(ctx) {
  const k = ensureCreator(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.frameResearch({ topic: str(i.topic), audience: str(i.audience) });
  return { status: 'success', outputs: { questions: out.questions } };
}

export async function sourceNormalize(ctx) {
  const k = ensureCreator(ctx);
  const i = ctx.inputs ?? {};
  const results = Array.isArray(i.results) ? i.results : [];
  const engine = str(i.engine) || 'unknown';
  const sources = [];
  for (const r of results) {
    const out = await k.normalizeSource({ url: str(r.url), title: str(r.title), engine, rank: typeof r.rank === 'number' ? r.rank : undefined });
    sources.push(out.source);
  }
  return { status: 'success', outputs: { sources } };
}

/** ADR 0458 P1 — a SHORT honest evidence summary for plan-generate to ground on.
 * Derived ONLY from what the recorded dossier actually contains (source count +
 * the source-SUPPORTED claim texts verbatim + the unsupported count); nothing is
 * invented. An empty/absent dossier yields the explicit marker 'no recorded
 * evidence' rather than an omission — plan-generate must SEE that evidence is
 * thin, never mistake silence for a rich dossier. */
function summarizeDossier(dossier) {
  if (!dossier) return 'no recorded evidence';
  const sources = Array.isArray(dossier.sources) ? dossier.sources : [];
  const claims = Array.isArray(dossier.claims) ? dossier.claims : [];
  if (sources.length === 0 && claims.length === 0) return 'no recorded evidence';
  const unsupported = new Set(Array.isArray(dossier.unsupportedClaimIds) ? dossier.unsupportedClaimIds : []);
  const supportedTexts = claims.filter((c) => c && !unsupported.has(c.claimId)).map((c) => str(c.text)).filter(Boolean);
  // ADR 0494 P2c — "N sources recorded" overstated the evidence: a source nobody
  // could fetch backs nothing. Report found vs READ so the plan author (and the
  // human approver) sees the real base.
  const read = sources.filter((sc) => sc && sc.retrieved === true).length;
  const anyMarked = sources.some((sc) => sc && sc.retrieved !== undefined);
  const parts = [anyMarked
    ? `${sources.length} source${sources.length === 1 ? '' : 's'} found, ${read} readable`
    : `${sources.length} source${sources.length === 1 ? '' : 's'} recorded`];
  parts.push(supportedTexts.length > 0
    ? `source-supported claims: ${supportedTexts.slice(0, 3).join('; ')}`
    : 'no source-supported claims recorded');
  if (unsupported.size > 0) parts.push(`${unsupported.size} unsupported claim${unsupported.size === 1 ? '' : 's'} recorded`);
  return `${parts.join('. ')}.`;
}

/** ADR 0458 §2.2 (correction, 2026-09-15) — the EVIDENCE section every
 *  text-producing call receives: one line per recorded claim (`[claimId] text
 *  — source titles/urls`, unsupported ones marked), from the structured
 *  `evidenceClaims` bag variable the creator surface derives (never re-derived
 *  here). Empty ⇒ an explicit marker, so a model is told there is nothing to
 *  cite rather than left to guess. */
function renderEvidenceClaims(claims) {
  const list = Array.isArray(claims) ? claims.filter((c) => c && typeof c.claimId === 'string') : [];
  if (list.length === 0) return 'EVIDENCE: none recorded — make no factual claims beyond the day\'s own instruction; claimRefs must be [].';
  const lines = list.map((c) => {
    const srcs = (Array.isArray(c.sources) ? c.sources : []).map((sc) => `${str(sc.title) || str(sc.domain)} <${str(sc.url)}>`).join('; ');
    return `[${c.claimId}]${c.supported === false ? ' (UNSUPPORTED — do not rely on it)' : ''} ${str(c.text)}${srcs ? ` — ${srcs}` : ''}`;
  });
  return `EVIDENCE (cite by claimId; only these ids are valid):\n${lines.join('\n')}`;
}

/** The ids a lesson may cite: SUPPORTED claims only (re-grade KTF-EV-1) — an
 *  unsupported claim is listed in the prompt as a warning, never as citable. */
function knownClaimIds(claims) {
  return new Set((Array.isArray(claims) ? claims : []).filter((c) => c && typeof c.claimId === 'string' && c.supported !== false).map((c) => c.claimId));
}

export async function evidenceGraph(ctx) {
  const k = ensureCreator(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.recordResearch({
    candidateId: str(i.candidateId),
    questions: Array.isArray(i.questions) ? i.questions : [],
    sources: Array.isArray(i.sources) ? i.sources : [],
    claims: Array.isArray(i.claims) ? i.claims : [],
    // ADR 0494 P2c — absent ⇒ the recorder leaves `retrieved` undefined rather
    // than guessing, keeping "unknown" distinct from "found but not read".
    ...(Array.isArray(i.readSourceHashes) ? { readSourceHashes: i.readSourceHashes } : {}),
  });
  if (!out.candidate) return { status: 'error', error: { code: 'not_found', message: 'Candidate not found.' } };
  // KTFULL-B4 — populate the variable plan-generate reads (it consumes
  // `evidenceSummary` but nothing wrote it). Node outputs do NOT implicitly
  // become variables; a step must write what a later step reads. Mirrors
  // plan-generate's own `ctx.variables.set('plan', plan)`.
  if (ctx.variables) ctx.variables.set('evidenceSummary', summarizeDossier(out.candidate.dossier));
  // ADR 0458 §2.2 (correction) — the STRUCTURED evidence (claim ids + sources)
  // the plan, the lessons and the skeptic are grounded on. Derived by the
  // creator surface from the recorded dossier (the SSoT), never by this node.
  let evidenceClaims = [];
  if (typeof k.evidenceClaims === 'function') {
    const ec = await k.evidenceClaims({ candidateId: str(i.candidateId) });
    evidenceClaims = ec && Array.isArray(ec.claims) ? ec.claims : [];
  }
  if (ctx.variables) ctx.variables.set('evidenceClaims', evidenceClaims);
  return { status: 'success', outputs: { candidate: out.candidate, unsupportedClaimIds: out.candidate.dossier?.unsupportedClaimIds ?? [], evidenceClaims } };
}

/**
 * ADR 0494 P2 — extract CITED CLAIMS from fetched source content.
 *
 * The missing middle of the research spine. Before this, the chain was
 * `search → normalize → evidence-graph`: it recorded source URLs and titles and
 * nothing else, so the dossier carried ZERO claims, `unsupportedClaimIds` was
 * always empty, and `plan-generate` was instructed to "ground every claim ONLY in
 * the provided evidence" while its evidence summary read, literally, "no
 * source-supported claims recorded". The plan was ungrounded while claiming to be
 * grounded.
 *
 * Follows `plan-generate` exactly: the response schema comes LIVE from the creator
 * surface (never a hand-copy), the call is temperature-0, and one bounded
 * error-fed repair runs before failing typed. Replay safety is inherited —
 * `ctx.callAI` rides the invocation log, so the extraction is RECORDED and
 * replayed, never recomputed.
 *
 * The model cites by source HASH. It is not trusted on that basis: `recordResearch`
 * re-derives every hash from `(url, title)` and re-points citations, so a claim
 * citing an invented hash lands in `unsupportedClaimIds` rather than passing.
 */
export async function claimExtract(ctx) {
  const k = ensureCreator(ctx);
  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const i = ctx.inputs ?? {};
  const sources = Array.isArray(i.sources) ? i.sources : [];
  const pages = Array.isArray(i.pages) ? i.pages : [];
  const questions = Array.isArray(i.questions) ? i.questions : [];

  // Join fetched CONTENT to recorded SOURCES by url — the model may only cite a
  // source we actually recorded, and may only read content we actually fetched.
  const byUrl = new Map();
  for (const pg of pages) {
    const u = str(pg && pg.url);
    const text = str(pg && (pg.extractedText || pg.title));
    if (u && text) byUrl.set(u, text);
  }
  const readable = sources
    .map((sc) => ({ hash: str(sc && sc.hash), title: str(sc && sc.title), url: str(sc && sc.url) }))
    .filter((sc) => sc.hash && byUrl.has(sc.url))
    .map((sc) => ({ ...sc, text: byUrl.get(sc.url).slice(0, 6000) }));

  if (readable.length === 0) {
    // FAIL CLOSED. Zero readable sources means any "claims" would be the model's
    // parametric memory wearing a citation — precisely the fabrication the whole
    // evidence gate exists to stop. Same posture as StubSourceError.
    return {
      status: 'failed',
      error: {
        code: 'no_readable_sources',
        message: 'No fetched source content to extract claims from — evidence cannot be grounded. Check the fetch step and the search adapter.',
      },
    };
  }

  let claimSchema = null;
  if (typeof k.claimSchema === 'function') {
    const out = await k.claimSchema({});
    if (out && typeof out.schema === 'object' && out.schema !== null) claimSchema = out.schema;
  }

  const systemPrompt =
    'You extract FACTUAL CLAIMS from supplied source content. '
    + 'Reply with ONE JSON object conforming EXACTLY to the given schema. '
    + 'HARD RULES: every claim MUST be stated by at least one supplied source; cite it by that source\'s HASH. '
    + 'Use ONLY the hashes provided — never invent one. Do NOT add claims from your own knowledge: '
    + 'if the sources do not say it, omit it. Prefer fewer, well-supported claims over many weak ones. '
    + 'If the sources support nothing relevant, return an empty claims array.';

  const userParts = [];
  if (questions.length > 0) userParts.push(`RESEARCH QUESTIONS:\n${questions.map((q) => `- ${str(q)}`).join('\n')}`);
  userParts.push(readable.map((sc) => `SOURCE hash=${sc.hash}\nTITLE: ${sc.title}\nCONTENT:\n${sc.text}`).join('\n\n---\n\n'));

  const known = new Set(readable.map((sc) => sc.hash));
  const call = async (messages) => {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || 'claude-sonnet-4-6',
      ...(str(i.credentialRef) ? { credentialRef: str(i.credentialRef) } : {}),
      systemPrompt,
      messages,
      temperature: 0,
      ...(claimSchema ? { responseSchema: claimSchema } : {}),
    });
    return ai && typeof ai === 'object' ? ai.data : undefined;
  };

  /** Structural defects the recorder would punish — checked HERE so the repair
   *  can name them, rather than silently producing unsupported claims. */
  const defectsOf = (data) => {
    const out = [];
    const claims = data && Array.isArray(data.claims) ? data.claims : null;
    if (!claims) return ['response has no `claims` array'];
    for (const c of claims) {
      const id = str(c && c.claimId);
      if (!id) { out.push('a claim is missing `claimId`'); continue; }
      if (!str(c && c.text)) out.push(`claim ${id} is missing \`text\``);
      const hashes = Array.isArray(c && c.sourceHashes) ? c.sourceHashes : [];
      if (hashes.length === 0) out.push(`claim ${id} cites no source`);
      for (const h of hashes) if (!known.has(str(h))) out.push(`claim ${id} cites unknown source hash "${str(h)}"`);
    }
    return out;
  };

  const baseMessages = [{ role: 'user', content: userParts.join('\n\n') }];
  let data = await call(baseMessages);
  let defects = defectsOf(data);
  if (defects.length > 0) {
    // ONE bounded error-fed repair, naming the ACTUAL defects (plan-generate pattern).
    data = await call([
      ...baseMessages,
      { role: 'assistant', content: JSON.stringify(data ?? null) },
      {
        role: 'user',
        content: `Your previous extraction was INVALID:\n- ${defects.join('\n- ')}\nReturn the corrected FULL JSON object only. Cite ONLY these hashes: ${[...known].join(', ')}.`,
      },
    ]);
    defects = defectsOf(data);
  }
  if (defects.length > 0) {
    return {
      status: 'failed',
      error: { code: 'claims_invalid', message: `Claim extraction failed validation after one repair: ${defects.length} defect(s).`, defects },
    };
  }

  const claims = data.claims;
  if (claims.length === 0) {
    // Also fail closed: readable sources that support nothing is a real outcome,
    // but it is NOT a basis for authoring a plan that claims to be evidence-led.
    return {
      status: 'failed',
      error: {
        code: 'no_supported_claims',
        message: 'The fetched sources supported no extractable claims — there is no evidence to author against.',
      },
    };
  }
  return {
    status: 'success',
    outputs: {
      claims, claimCount: claims.length, sourcesRead: readable.length,
      // ADR 0494 P2c — WHICH sources were readable, so the dossier can mark the
      // rest as found-but-unread instead of recording them as if they backed
      // something. Many authoritative publishers refuse a server-side fetch.
      readSourceHashes: readable.map((sc) => sc.hash),
    },
  };
}

nodes['feature.kicktodo.nodes.claim-extract'] = claimExtract;

/**
 * ADR 0494 P2b — VERIFY that each cited source actually SUPPORTS its claim.
 *
 * The structural check proves a source was recorded. It cannot prove the source
 * says what the claim says — and that gap is the field's dangerous case: the
 * damaging citation errors are not fabrications but REAL SOURCES APPLIED
 * INCORRECTLY (Stanford 2026: 17–34% of legal-AI queries mis-sourced; accuracy
 * under 66% while users trust more and verify less).
 *
 * COST SHAPE — this is why it is affordable. Only pairs a claim actually CITES are
 * judged, never the claim × source cross product: citations are typically 1–2 per
 * claim, so the work is linear in citations rather than quadratic in the dossier.
 * The second, independent opinion is then TARGETED — requested only where the
 * first judgement said `supports`, because a false `supports` is what carries a
 * bad claim through a gate, while a false `unrelated` merely loses one. That is a
 * 2× on a subset, not on everything, and it runs on the tenant's own key.
 *
 * DISAGREEMENT IS RECORDED, NOT RESOLVED. Where the two judgements differ the pair
 * stops counting as support (so it cannot silently pass `claimsGate`) and surfaces
 * on the informational `disputed` gate row for the human approver. Collapsing it to
 * a single verdict would throw away the most useful product of judging twice.
 */
export async function claimVerify(ctx) {
  const k = ensureCreator(ctx);
  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const i = ctx.inputs ?? {};
  const cfg = ctx.config ?? {};
  const claims = Array.isArray(i.claims) ? i.claims : [];
  const sources = Array.isArray(i.sources) ? i.sources : [];
  const pages = Array.isArray(i.pages) ? i.pages : [];
  if (claims.length === 0) {
    return { status: 'failed', error: { code: 'no_claims', message: 'Nothing to verify — the extraction step produced no claims.' } };
  }

  const textByHash = new Map();
  const urlByHash = new Map();
  for (const sc of sources) {
    const h = str(sc && sc.hash);
    if (h) urlByHash.set(h, str(sc && sc.url));
  }
  for (const pg of pages) {
    const u = str(pg && pg.url);
    const t = str(pg && pg.extractedText);
    if (!u || !t) continue;
    for (const [h, su] of urlByHash) if (su === u) textByHash.set(h, t);
  }

  let verdictSchema = null;
  if (typeof k.verdictSchema === 'function') {
    const out = await k.verdictSchema({});
    if (out && typeof out.schema === 'object' && out.schema !== null) verdictSchema = out.schema;
  }

  // A HARD ceiling so a large dossier cannot run away with the tenant's budget.
  // Exceeding it is reported, never silently truncated (a silent cap would make
  // "verified" mean different things on different runs).
  const maxPairs = typeof cfg.maxVerifications === 'number' && cfg.maxVerifications > 0
    ? Math.min(200, Math.floor(cfg.maxVerifications))
    : 60;

  const judge = async (claimText, sourceText, adversarial) => {
    const systemPrompt = adversarial
      ? 'You are a SKEPTICAL reviewer. Another reviewer judged that the SOURCE supports the CLAIM. '
        + 'Your job is to look for reasons that is WRONG: an overstatement, a different population, a different '
        + 'timeframe, a correlation reported as causation, or a passage that is merely adjacent. '
        + 'Answer `supports` ONLY if the source really does state or directly entail the claim. Quote the deciding passage.'
      : 'You judge whether a SOURCE supports a CLAIM. Answer with the given schema only. '
        + 'Answer `supports` ONLY if the source states or directly entails the claim, and quote the exact deciding passage. '
        + 'If the source is about something else answer `unrelated`; if it says the opposite answer `contradicts`; '
        + 'if it is too vague or truncated to tell answer `unverifiable`. Do NOT use knowledge outside the source.';
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || 'claude-sonnet-4-6',
      ...(str(i.credentialRef) ? { credentialRef: str(i.credentialRef) } : {}),
      systemPrompt,
      messages: [{ role: 'user', content: `CLAIM:\n${claimText}\n\nSOURCE:\n${sourceText}` }],
      temperature: 0,
      ...(verdictSchema ? { responseSchema: verdictSchema } : {}),
    });
    const data = ai && typeof ai === 'object' ? ai.data : undefined;
    const verdict = str(data && data.verdict);
    const allowed = ['supports', 'contradicts', 'unrelated', 'unverifiable'];
    // An unparseable judgement is `unverifiable`, never `supports`: failing OPEN
    // here would let a broken response carry a claim through the gate.
    if (!allowed.includes(verdict)) return { verdict: 'unverifiable' };
    const span = str(data && data.span);
    // `supports` without a quoted passage is not auditable — downgrade rather than
    // record an unfalsifiable pass.
    if (verdict === 'supports' && !span) return { verdict: 'unverifiable' };
    return { verdict, ...(span ? { span } : {}) };
  };

  let pairs = 0, skipped = 0, secondOpinions = 0;
  const out = [];
  for (const cl of claims) {
    const support = [];
    for (const h of (Array.isArray(cl.sourceHashes) ? cl.sourceHashes : [])) {
      const hash = str(h);
      const text = textByHash.get(hash);
      if (!text) { skipped++; continue; }          // nothing read ⇒ nothing to judge
      if (pairs >= maxPairs) { skipped++; continue; }
      pairs++;
      const first = await judge(str(cl.text), text.slice(0, 6000), false);
      const entry = { sourceHash: hash, ...first };
      if (first.verdict === 'supports') {
        secondOpinions++;
        const second = await judge(str(cl.text), text.slice(0, 6000), true);
        entry.secondOpinion = second.verdict;
      }
      support.push(entry);
    }
    out.push({ ...cl, support });
  }

  const supported = out.filter((cl) => (cl.support ?? []).some(
    (sp) => sp.verdict === 'supports' && (sp.secondOpinion === undefined || sp.secondOpinion === 'supports')));
  const disputed = out.flatMap((cl) => (cl.support ?? [])
    .filter((sp) => sp.secondOpinion !== undefined && sp.secondOpinion !== sp.verdict)
    .map((sp) => cl.claimId));

  if (supported.length === 0) {
    // FAIL CLOSED, consistent with extraction: claims that survive structure but
    // that no source actually supports are not evidence, and authoring against
    // them is the ungrounded-plan failure this ADR family removes.
    return {
      status: 'failed',
      error: {
        code: 'no_entailed_claims',
        message: `No claim survived entailment checking (${pairs} pair(s) judged). The sources do not support what was extracted from them.`,
      },
    };
  }
  return {
    status: 'success',
    outputs: { claims: out, verifiedPairs: pairs, secondOpinions, disputedClaimIds: [...new Set(disputed)], skippedPairs: skipped },
  };
}

nodes['feature.kicktodo.nodes.claim-verify'] = claimVerify;

nodes['feature.kicktodo.nodes.research-frame'] = researchFrame;
nodes['feature.kicktodo.nodes.source-normalize'] = sourceNormalize;
nodes['feature.kicktodo.nodes.evidence-graph'] = evidenceGraph;

// ── Challenge Plan gates + decomposition (ADR 0415 P2, pack v1.2.0) ──

export async function planValidate(ctx) {
  const k = ensureCreator(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.validatePlan({ plan: i.plan ?? {} });
  const defects = Array.isArray(out.defects) ? out.defects : [];
  return { status: 'success', outputs: { defects, valid: defects.length === 0 } };
}

export async function decompose(ctx) {
  const k = ensureCreator(ctx);
  const i = ctx.inputs ?? {};
  // ADR 0441 (TD1 binding) — forward candidateId so the surface can bind the draft
  // to its candidate (the id the publication submit needs). Optional: a bare
  // decompose with no candidateId still drafts, just unbound.
  const out = await k.draftFromPlan({ plan: i.plan ?? {}, authorSubject: str(i.authorSubject), candidateId: str(i.candidateId) });
  return { status: 'success', outputs: { challenge: out.challenge } };
}

nodes['feature.kicktodo.nodes.plan-validate'] = planValidate;
nodes['feature.kicktodo.nodes.decompose'] = decompose;

// ── Accountability summary (ADR 0419 P4, pack v1.3.0) ──

function ensureAccountability(ctx) {
  const k = ctx.features && ctx.features['kicktodo-accountability'];
  if (!k || typeof k.feed !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-accountability'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-accountability' },
    );
  }
  return k;
}

export async function accountabilitySummary(ctx) {
  const k = ensureAccountability(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.feed({ circleId: str(i.circleId), callerSubject: str(i.callerSubject) });
  return { status: 'success', outputs: { feed: out.feed } };
}

nodes['feature.kicktodo.nodes.accountability-summary'] = accountabilitySummary;

// ── Entitlement check (ADR 0420 P5, pack v1.4.0) ──

function ensureCommerceAdapter(ctx) {
  const k = ctx.features && ctx.features['kicktodo-commerce'];
  if (!k || typeof k.isPaid !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-commerce'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-commerce' },
    );
  }
  return k;
}

export async function entitlementCheck(ctx) {
  const k = ensureCommerceAdapter(ctx);
  const i = ctx.inputs ?? {};
  const paid = await k.isPaid({ challengeId: str(i.challengeId), challengeVersion: num(i.challengeVersion, 1) });
  let entitlementState = null;
  if (str(i.buyerSubject)) {
    const out = await k.entitlement({ buyerSubject: str(i.buyerSubject), challengeId: str(i.challengeId), challengeVersion: num(i.challengeVersion, 1) });
    entitlementState = out.entitlement ? out.entitlement.state : null;
  }
  return { status: 'success', outputs: { paid: paid.paid === true, entitlementState } };
}

nodes['feature.kicktodo.nodes.entitlement-check'] = entitlementCheck;

// ADR 0451 P4 — resolve (or lazily mint) the referrer's affiliate code for a
// PAID challenge, so a workflow can build the `?ref=` invite link. Idempotent;
// `code: null` for a free challenge. role:action (records the resolved code).
export async function referralCode(ctx) {
  const k = ensureCommerceAdapter(ctx);
  if (typeof k.referralCode !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-commerce'].referralCode (ADR 0451 P4)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-commerce' },
    );
  }
  const i = ctx.inputs ?? {};
  const out = await k.referralCode({
    ownerSubject: str(i.ownerSubject),
    challengeId: str(i.challengeId),
    challengeVersion: num(i.challengeVersion, 1),
  });
  return { status: 'success', outputs: { code: out.code ?? null } };
}

nodes['feature.kicktodo.nodes.referral-code'] = referralCode;

// ADR 0456 P4 — a lightweight lifecycle read for automation authors: is the
// participant enrolled in a challenge + how far along (no freeze/judge). role:read.
export async function lifecycleStatus(ctx) {
  const k = ensureKicktodo(ctx);
  if (typeof k.lifecycleStatus !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-core'].lifecycleStatus (ADR 0456 P4)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-core' },
    );
  }
  const i = ctx.inputs ?? {};
  const out = await k.lifecycleStatus({
    ownerSubject: str(i.ownerSubject),
    challengeId: str(i.challengeId),
    challengeVersion: num(i.challengeVersion, undefined),
  });
  return { status: 'success', outputs: { lifecycle: out.status } };
}

nodes['feature.kicktodo.nodes.lifecycle-status'] = lifecycleStatus;

// ── Calendar sync (ADR 0421 P5, pack v1.5.0) ──

function ensureIntegrations(ctx) {
  const k = ctx.features && ctx.features['kicktodo-integrations'];
  if (!k || typeof k.calendarSync !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-integrations'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-integrations' },
    );
  }
  return k;
}

export async function calendarSync(ctx) {
  const k = ensureIntegrations(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.calendarSync({ ownerSubject: str(i.ownerSubject), enrollmentId: str(i.enrollmentId) });
  return { status: 'success', outputs: { upserted: out.result.upserted, removed: out.result.removed } };
}

nodes['feature.kicktodo.nodes.calendar-sync'] = calendarSync;

// ── Engagement summary (ADR 0425 P5, pack v1.6.0) ──

function ensureEngagement(ctx) {
  const k = ctx.features && ctx.features['kicktodo-engagement'];
  if (!k || typeof k.leaderboard !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-engagement'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-engagement' },
    );
  }
  return k;
}

export async function engagementSummary(ctx) {
  const k = ensureEngagement(ctx);
  const i = ctx.inputs ?? {};
  const [board, awards] = await Promise.all([
    k.leaderboard({ ownerSubject: str(i.ownerSubject) }),
    k.awards({ ownerSubject: str(i.ownerSubject) }),
  ]);
  return {
    status: 'success',
    outputs: { belowFloor: board.view.belowFloor, entries: board.view.entries, awards: awards.awards },
  };
}

nodes['feature.kicktodo.nodes.engagement-summary'] = engagementSummary;

// ── Challenge reviews (ADR 0426 P5, pack v1.7.0) ──

function ensureCommunity(ctx) {
  const k = ctx.features && ctx.features['kicktodo-community'];
  if (!k || typeof k.reviews !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-community'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-community' },
    );
  }
  return k;
}

export async function challengeReviews(ctx) {
  const k = ensureCommunity(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.reviews({ challengeId: str(i.challengeId) });
  return { status: 'success', outputs: { reviews: out.reviews, aggregate: out.aggregate } };
}

nodes['feature.kicktodo.nodes.challenge-reviews'] = challengeReviews;

// ── Org report node DROPPED (pack v1.22.0, chat-first-port G8) ──
// `feature.kicktodo.nodes.org-report` was an uncomposed composable node — no
// agent allowlisted it and no workflow ran it (the port-map G8 finding). The
// org's k-anonymous report stays reachable through the governed REST route +
// the `ctx.features['kicktodo-organizations'].report` surface; only the
// dead node declaration was removed. Re-add (with an igniter or a named
// org-steward agent) if org reporting is ever wanted in chat.

// ── Plan generation (ADR 0415 D5 / KTC-2, pack v1.9.0) ──
//
// The XCH-CB-3 shape: generate with the run-scoped provider, then let the
// AUTHORITATIVE closed-world validator (the kicktodo-creator surface's
// validatePlan — the SSoT; no schema copy here) judge it; ONE bounded
// error-fed repair naming the validator's actual defects; still-invalid ⇒ a
// TYPED failure, never success-with-empty. No ctx.callAI ⇒ fail closed
// (capability_missing) — the stub posture.

// Fallback shape when the host predates the `planSchema` surface op (XCH-KT-1) —
// the live path fetches the authoritative JSON schema from the creator surface
// instead, so the shape the model sees cannot drift from `validatePlan`.
const PLAN_SHAPE_GUIDANCE = {
  type: 'object',
  description: 'A KickTodo challenge plan draft. The host validates authoritatively after generation.',
};

const PLAN_FALLBACK_SHAPE_PROSE =
  '{\n'
  + '  "title": string,\n'
  + '  "promise": string,            // what the participant will be able to do\n'
  + '  "audience": string,\n'
  + '  "durationDays": integer,      // 3..60\n'
  + '  "dailyMinutesBudget": integer,// 5..120\n'
  + '  "outcomes":     [{ "outcomeId": string, "measurableOutcome": string, "method": string }],\n'
  + '  "achievements": [{ "achievementId": string, "observableEvidence": string, "outcomeIds": [string] }],\n'
  + '  "days":         [{ "day": integer, "stableActivityId": kebab-string, "title": string,\n'
  + '                     "actionInstruction": string, "userFacingWhy": string, "estimatedMinutes": integer,\n'
  + '                     "achievementIds": [string],\n'
  + '                     "evidencePolicy": "attestation"|"note"|"photo"|"measurement" }]\n'
  + '}';

export async function planGenerate(ctx) {
  const k = ensureCreator(ctx);
  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const i = ctx.inputs ?? {};
  const topic = str(i.topic);
  const audience = str(i.audience);
  if (!topic) {
    return { status: 'failed', error: { code: 'validation_error', message: 'Input `topic` is required.' } };
  }
  // XCH-KT-1 — fetch the authoritative plan schema from the creator surface at
  // call time (the workflow-author live-catalog pattern). It shares its bounds/
  // enum vocabulary with `validatePlan`, so prompt + responseSchema + validator
  // agree by construction; the prose block above is only the older-host fallback.
  let planSchema = null;
  if (typeof k.planSchema === 'function') {
    const out = await k.planSchema({});
    if (out && typeof out.schema === 'object' && out.schema !== null) planSchema = out.schema;
  }
  const shapeSection = planSchema
    ? 'produce ONE ChallengePlan as strict JSON conforming EXACTLY to this JSON Schema (the host validates authoritatively):\n' + JSON.stringify(planSchema) + '\n'
    : 'produce ONE ChallengePlan as strict JSON with EXACTLY these fields:\n' + PLAN_FALLBACK_SHAPE_PROSE + '\n';
  const systemPrompt =
    'You are a challenge-plan author. From the TOPIC, AUDIENCE and EVIDENCE SUMMARY, '
    + shapeSection
    + 'HARD RULES the deterministic validator enforces: every achievement\'s outcomeIds MUST reference declared outcomes; every day\'s achievementIds MUST reference declared achievements; every outcome needs BOTH a measurable statement AND a method; every day\'s claimRefs MUST name only claimIds listed in the EVIDENCE (an empty array is correct when the day states no fact beyond its own instruction). Ground every factual statement ONLY in the provided evidence and never promise a transformation the evidence does not support. Reply with the JSON object only.';
  const userParts = [`TOPIC:\n${topic}`];
  if (audience) userParts.push(`AUDIENCE:\n${audience}`);
  if (str(i.evidenceSummary)) userParts.push(`EVIDENCE SUMMARY:\n${str(i.evidenceSummary)}`);
  // ADR 0458 §2.2 (correction) — the structured evidence with ids: what
  // `claimRefs` must cite, validated closed-world against the dossier below.
  userParts.push(renderEvidenceClaims(i.evidenceClaims));

  const call = async (messages) => {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || 'claude-sonnet-4-6',
      ...(str(i.credentialRef) ? { credentialRef: str(i.credentialRef) } : {}),
      systemPrompt,
      messages,
      temperature: 0,
      responseSchema: planSchema ?? PLAN_SHAPE_GUIDANCE,
    });
    return ai && typeof ai === 'object' ? ai.data : undefined;
  };

  const baseMessages = [{ role: 'user', content: userParts.join('\n\n') }];
  const candidateId = str(i.candidateId);
  let plan = await call(baseMessages);
  let verdict = await k.validatePlan({ plan: plan ?? {}, ...(candidateId ? { candidateId } : {}) });
  let defects = Array.isArray(verdict.defects) ? verdict.defects : [];
  if (defects.length > 0) {
    // ONE bounded error-fed repair: name the validator's ACTUAL defects.
    plan = await call([
      ...baseMessages,
      { role: 'assistant', content: JSON.stringify(plan ?? null) },
      {
        role: 'user',
        content: `Your previous plan FAILED validation with these defects:\n- ${defects.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('\n- ')}\nReturn the corrected FULL plan JSON object only.`,
      },
    ]);
    verdict = await k.validatePlan({ plan: plan ?? {}, ...(candidateId ? { candidateId } : {}) });
    defects = Array.isArray(verdict.defects) ? verdict.defects : [];
  }
  if (defects.length > 0) {
    return {
      status: 'failed',
      error: { code: 'plan_invalid', message: `Plan failed validation after one repair: ${defects.length} defect(s).`, defects },
    };
  }
  // KTFULL-B4 — hand the VALIDATED plan to the decompose step.
  if (ctx.variables) ctx.variables.set('plan', plan);
  return { status: 'success', outputs: { plan } };
}

nodes['feature.kicktodo.nodes.plan-generate'] = planGenerate;

// ── Plan flexibility (ADR 0429 P5, pack v1.10.0) ──

export async function substitute(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.substitute({
    ownerSubject: str(i.ownerSubject),
    cardId: str(i.cardId),
    alternativeId: str(i.alternativeId),
  });
  return { status: 'success', outputs: { occurrence: out.occurrence } };
}

export async function applyMissedWindow(ctx) {
  const k = ensureKicktodo(ctx);
  const out = await k.applyMissedWindow({ enrollmentId: str((ctx.inputs ?? {}).enrollmentId) });
  return { status: 'success', outputs: out.result };
}

nodes['feature.kicktodo.nodes.substitute'] = substitute;
nodes['feature.kicktodo.nodes.apply-missed-window'] = applyMissedWindow;

// ── Content-locale catalog (ADR 0430 P5, pack v1.11.0) ──

export async function catalogForLocale(ctx) {
  const k = ensureKicktodo(ctx);
  const out = await k.catalogForLocale({ contentLocale: str((ctx.inputs ?? {}).contentLocale) || 'en' });
  return { status: 'success', outputs: { challenges: out.challenges } };
}

nodes['feature.kicktodo.nodes.catalog-for-locale'] = catalogForLocale;

// ── Cohort seat availability (ADR 0431 P5, pack v1.12.0) ──

export async function seatAvailability(ctx) {
  const k = ctx.features && ctx.features['kicktodo-commerce'];
  if (!k || typeof k.seatAvailability !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-commerce'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-commerce' },
    );
  }
  const i = ctx.inputs ?? {};
  const out = await k.seatAvailability({ buyerSubject: str(i.buyerSubject), productId: str(i.productId) });
  return { status: 'success', outputs: { availability: out.availability } };
}

nodes['feature.kicktodo.nodes.seat-availability'] = seatAvailability;

// ── Outcome metrics (ADR 0432 P5, pack v1.13.0) ──

export async function outcomeMetrics(ctx) {
  const k = ctx.features && ctx.features['kicktodo-metrics'];
  if (!k || typeof k.engagement !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-metrics'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-metrics' },
    );
  }
  const [activation, engagement, factory] = await Promise.all([k.activation({}), k.engagement({}), k.factory({})]);
  return {
    status: 'success',
    outputs: { activation: activation.metrics, engagement: engagement.metrics, factory: factory.metrics },
  };
}

nodes['feature.kicktodo.nodes.outcome-metrics'] = outcomeMetrics;

// ── Participant rhythm (ADR 0443 R1) ──
// (reuses the ensureIntegrations helper declared with the ADR 0421 nodes above)

/** ADR 0443 R1 — the reminder-loop's single node: nudge the participant about
 *  today's pending headline at their chosen daypart. Skips honestly (non-active
 *  enrollment / nothing pending / no consent) — never a guilt ping. */
export async function remindToday(ctx) {
  const k = ensureIntegrations(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.remindToday({ enrollmentId: str(i.enrollmentId), ownerSubject: str(i.ownerSubject) });
  return { status: 'success', outputs: { reminded: out.reminded === true, reason: out.reason ?? null } };
}

nodes['feature.kicktodo.nodes.remind-today'] = remindToday;

// ── KickBot speaks first (ADR 0689, pack v1.28.0) ──

/** ADR 0689 — the reminder-loop's SECOND node: after the (consent-gated)
 *  reminder, enqueue ONE proactive turn of the participant's named guide into
 *  their own 1:1 with KickBot (a fire-now job on the coach turn-workflow).
 *  Honest skips (not-active / nothing-pending / muted / not-found) — the same
 *  reasons remind-today skips, so a snoozed participant hears nothing. An
 *  older host without the op skips honestly rather than failing the loop. */
export async function kickbotCoachTurn(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  if (typeof k.kickbotCoachTurn !== 'function') {
    return { status: 'success', outputs: { queued: false, reason: 'host-lacks-op', conversationId: null } };
  }
  const out = await k.kickbotCoachTurn({
    enrollmentId: str(i.enrollmentId),
    ownerSubject: str(i.ownerSubject),
    occasion: str(i.occasion) || 'reminder',
    awardKind: str(i.awardKind) || undefined,
  });
  return { status: 'success', outputs: { queued: out.queued === true, reason: out.reason ?? null, conversationId: out.conversationId ?? null } };
}

nodes['feature.kicktodo.nodes.kickbot-coach-turn'] = kickbotCoachTurn;

// ── Factory terminal: submit for publication (ADR 0458 P1, pack v1.14.0) ──
//
// EXCHANGE LAW (ADR 0458 §2.2 step 7): the ONLY effect of this node is raising
// the existing separation-of-duties `challenge-publish` approval. There is NO
// publication-completion path here — no in-run step can flip a challenge live.
// The approval is decided in the reviews inbox by an identity distinct from the
// submitter (the creator surface's publishService enforces the SoD check). This
// is why a thin submit node exists at all instead of a "publish" node: model/run
// output reaches durable published state only through that human gate.

export async function submitPublication(ctx) {
  const k = ensureCreator(ctx);
  if (typeof k.submitPublication !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-creator'].submitPublication — the KickTodo Creator feature must be enabled (ADR 0458)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-creator' },
    );
  }
  const candidateId = str((ctx.inputs ?? {}).candidateId);
  if (!candidateId) {
    return { status: 'failed', error: { code: 'validation_error', message: 'Input `candidateId` is required.' } };
  }
  let out;
  try {
    out = await k.submitPublication({ candidateId });
  } catch (err) {
    // Typed failure envelope on refusal — the surface throws an OpenwopError
    // (separation-of-duties `forbidden`, `not_found`, `validation_error`) when
    // the submit is not allowed. Surface its code/message rather than crashing
    // the run; anything without an error code is a genuine fault — rethrow it.
    if (err && typeof err.code === 'string') {
      return {
        status: 'failed',
        error: { code: err.code, message: typeof err.message === 'string' ? err.message : 'Publication submit refused.' },
      };
    }
    throw err;
  }
  const o = out ?? {};
  const approvalId = str(o.approvalId) || str(o.approval && o.approval.id) || str(o.publication && o.publication.approvalId);
  const state = str(o.state) || str(o.approval && o.approval.state) || str(o.publication && o.publication.state);
  return { status: 'success', outputs: { ...(approvalId ? { approvalId } : {}), state } };
}

nodes['feature.kicktodo.nodes.submit-publication'] = submitPublication;

// ── Lesson media persist (ADR 0458 P2, pack v1.17.0) ──
//
// The factory's per-lesson media leg: promote a generated image/video (a host
// serve URL) to a durable Media asset, THEN record it on the candidate's lesson
// for `day` through the creator surface. Two governed surfaces, in order:
//   1. ctx.features.media.createAssetFromServeUrl — SSRF-safe (takes a host serve
//      token, never fetches a URL), hash-deduped, capacity-gated. Mirrors the
//      feature.campaign-channels render-concepts reach; the media library owns the
//      durable bytes and returns an assetId, never raw bytes.
//   2. ctx.features['kicktodo-creator'].setLessonMedia — binds { assetId, kind } to
//      (candidateId, day). Peer-added (ADR 0458 P2); probed defensively.
// Missing surface ⇒ typed host_capability_missing (never a silent no-op), so the
// image is never lost between the two writes. orgId is the workspace-root org
// (orgId === tenantId; executor.ts records the workflow-root org this way); an
// explicit `orgId` input overrides it, matching the sibling media consumers.

function ensureMedia(ctx) {
  const m = ctx.features && ctx.features.media;
  if (!m || typeof m.createAssetFromServeUrl !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.media.createAssetFromServeUrl — the Media feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.media' },
    );
  }
  return m;
}

/** The creator surface with the `setLessonMedia` pointer op (ADR 0458 P2). */
function ensureLessonMediaCreator(ctx) {
  const creator = ensureCreator(ctx);
  if (typeof creator.setLessonMedia !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-creator'].setLessonMedia — the KickTodo Creator feature must be enabled (ADR 0458 P2)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-creator' },
    );
  }
  return creator;
}

/** The shared media leg: create the durable asset, then bind the (candidate, day)
 *  pointer. Callers ensure the surfaces first; this is the one place the two
 *  governed writes happen in order, reused by BOTH the standalone
 *  lesson-media-persist node (retry/manual lane) and lesson-batch-build. Returns
 *  a typed-error envelope rather than throwing so a per-day batch can surface a
 *  single day's media failure to the reviewer. */
async function persistLessonMedia(ctx, media, creator, { candidateId, day, url, kind, orgId }) {
  const resolvedOrg = str(orgId) || str(ctx.tenantId);
  if (!resolvedOrg) return { ok: false, error: { code: 'org_required', message: 'Could not resolve orgId for the lesson media asset.' } };
  const asset = await media.createAssetFromServeUrl({
    orgId: resolvedOrg,
    url,
    name: `Lesson day ${day} — ${kind}`,
    tags: ['kicktodo', 'lesson', kind],
    lineage: { generatedBy: 'ai' },
  });
  const assetId = str(asset && asset.assetId);
  if (!assetId) return { ok: false, error: { code: 'media_error', message: 'Media asset creation returned no assetId.' } };
  const out = await creator.setLessonMedia({ candidateId, day, assetId, kind });
  return { ok: true, assetId, ...(out && out.candidate ? { candidate: out.candidate } : {}) };
}

export async function lessonMediaPersist(ctx) {
  const media = ensureMedia(ctx);
  const creator = ensureLessonMediaCreator(ctx);
  const i = ctx.inputs ?? {};
  const candidateId = str(i.candidateId);
  const day = num(i.day, NaN);
  const url = str(i.url);
  const kind = str(i.kind);
  if (!candidateId) return { status: 'failed', error: { code: 'validation_error', message: 'Input `candidateId` is required.' } };
  if (!Number.isInteger(day)) return { status: 'failed', error: { code: 'validation_error', message: 'Input `day` must be an integer.' } };
  if (!url) return { status: 'failed', error: { code: 'validation_error', message: 'Input `url` is required.' } };
  if (kind !== 'image' && kind !== 'video') {
    return { status: 'failed', error: { code: 'validation_error', message: "Input `kind` must be 'image' or 'video'." } };
  }
  const res = await persistLessonMedia(ctx, media, creator, { candidateId, day, url, kind, orgId: i.orgId });
  if (!res.ok) return { status: 'failed', error: res.error };
  return {
    status: 'success',
    outputs: { assetId: res.assetId, day, kind, ...(res.candidate ? { candidate: res.candidate } : {}) },
  };
}

nodes['feature.kicktodo.nodes.lesson-media-persist'] = lessonMediaPersist;

// ── Checkpoint plan (ADR 0458 P2, pack v1.18.0) ──
//
// A thin node over the DETERMINISTIC `kicktodo-creator.checkpointPlan` host policy
// (a model never chooses the checkpoint cadence). It partitions the VALIDATED plan
// into ≤4 contiguous batches and threads them into the factory run:
//   • WRITES bag vars `batch0..batch3` (each the plan's day OBJECTS for that batch,
//     the subWorkflow inputMapping source `days`) + `planBrief` (the sims' task).
//   • OUTPUTS `slot0Live..slot3Live` + `noLiveSlots` — the parent edges condition
//     on these EXACT output names (a false slot's build edge is skipped).
// Node outputs do NOT implicitly become bag vars; a step must write what a later
// step reads (the KTFULL-B4 rule) — hence the explicit `ctx.variables.set`.

const SLOT_COUNT = 4;

/** A short, honest text brief of the plan for the sim personas to walk day-by-day.
 *  Derived ONLY from the validated plan — nothing invented. */
function renderPlanBrief(plan, days) {
  const head = [
    str(plan.title) ? `Challenge: ${str(plan.title)}` : '',
    str(plan.promise) ? `Promise: ${str(plan.promise)}` : '',
    str(plan.audience) ? `Audience: ${str(plan.audience)}` : '',
  ].filter(Boolean);
  const lines = days.map((d) => {
    const n = num(d && d.day, NaN);
    const title = str(d && d.title);
    const instr = str(d && d.actionInstruction);
    return `Day ${Number.isInteger(n) ? n : '?'}: ${[title, instr].filter(Boolean).join(' — ')}`;
  });
  return [...head, '', 'Day-by-day plan:', ...lines].join('\n');
}

export async function checkpointPlan(ctx) {
  const creator = ensureCreator(ctx);
  if (typeof creator.checkpointPlan !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-creator'].checkpointPlan — the KickTodo Creator feature must be enabled (ADR 0458 P2)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-creator' },
    );
  }
  const i = ctx.inputs ?? {};
  const plan = i.plan && typeof i.plan === 'object' ? i.plan : {};
  const checkpointEvery = str(i.checkpointEvery) === 'outline-only' ? 'outline-only' : 'batched';
  const out = await creator.checkpointPlan({ plan, checkpointEvery });
  const cp = (out && out.plan) || {};
  const batches = Array.isArray(cp.batches) ? cp.batches : [];
  const slotLive = Array.isArray(cp.slotLive) ? cp.slotLive : [];

  // Map each batch's day NUMBERS back to the plan's day OBJECTS (the payload the
  // lesson-batch-build node enriches). checkpointPlan carries only day numbers;
  // the full plan is a node input, so the object mapping happens here.
  const planDays = Array.isArray(plan.days) ? plan.days : [];
  const dayById = new Map(planDays.filter((d) => d && Number.isInteger(d.day)).map((d) => [d.day, d]));

  const outputs = {};
  for (let n = 0; n < SLOT_COUNT; n++) {
    const batch = batches.find((b) => b && b.slot === n);
    const payload = batch && Array.isArray(batch.days)
      ? batch.days.map((dn) => dayById.get(dn)).filter(Boolean)
      : [];
    if (ctx.variables) ctx.variables.set(`batch${n}`, payload);
    outputs[`slot${n}Live`] = slotLive[n] === true;
  }
  outputs.noLiveSlots = cp.noLiveSlots === true;
  if (ctx.variables) ctx.variables.set('planBrief', renderPlanBrief(plan, planDays));
  // ADR 0458 §2.2 (correction) — the skeptic's task: the plan brief PLUS the
  // evidence it cites (claim ids, sources) and each day's claimRefs, so "does
  // the plan's own evidence support its promises" is answerable, not theatre.
  if (ctx.variables) ctx.variables.set('planEvidenceBrief', renderPlanEvidenceBrief(plan, planDays, i.evidenceClaims));
  return { status: 'success', outputs };
}

function renderPlanEvidenceBrief(plan, days, evidenceClaims) {
  const refs = days.map((d) => {
    const n = num(d && d.day, NaN);
    const r = Array.isArray(d && d.claimRefs) ? d.claimRefs.filter((x) => typeof x === 'string') : [];
    return `Day ${Number.isInteger(n) ? n : '?'}: ${r.length ? r.map((x) => `[${x}]`).join(' ') : '(no claims cited)'}`;
  });
  return [renderPlanBrief(plan, days), '', renderEvidenceClaims(evidenceClaims), '', 'Claims each day cites:', ...refs].join('\n');
}

nodes['feature.kicktodo.nodes.checkpoint-plan'] = checkpointPlan;

// ── Lesson batch build (ADR 0458 P2, pack v1.18.0) ──
//
// The per-checkpoint child's ONE iterating node (the executor is acyclic with no
// node re-entry, so a variable-length batch cannot be per-day nodes). It walks the
// batch's day payloads and, PER DAY, enriches the plan day into a participant-
// facing lesson with `ctx.callAI` under a closed-world validator + ONE bounded
// error-fed repair — the plan-generate pattern (fails typed, never
// success-with-empty). When `generateMedia`, it generates a visual with
// `ctx.callImageGenerator` and persists it via the SHARED `persistLessonMedia`
// leg (the exact reach the standalone lesson-media-persist node uses). No
// ctx.callAI ⇒ fail closed (capability_missing) — the stub posture.

/** Older-host fallback only: the live shape is the creator surface's `lessonSchema`
 *  (ADR 0458 §2.2 correction), fetched per batch so prompt + validator agree. */
const LESSON_SHAPE_GUIDANCE = {
  type: 'object',
  description: 'A participant-facing lesson for ONE challenge day. The node validates authoritatively after generation.',
};

/** Closed-world validator for one enriched lesson (the node owns this shape — there
 *  is no host lesson SSoT; a lesson is node output shown at the checkpoint gate,
 *  never durable domain state). Lists EVERY defect for the one bounded repair. */
function lessonDefects(lesson, expectedDay, known) {
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) return ['lesson must be a JSON object'];
  const d = [];
  if (!Number.isInteger(lesson.day) || lesson.day !== expectedDay) d.push(`day must be the integer ${expectedDay}`);
  if (typeof lesson.title !== 'string' || lesson.title.trim().length === 0) d.push('title must be a non-empty string');
  if (typeof lesson.body !== 'string' || lesson.body.trim().length < 40) d.push('body must be a string of at least 40 characters');
  if (!Array.isArray(lesson.steps) || lesson.steps.length === 0 || !lesson.steps.every((s) => typeof s === 'string' && s.trim().length > 0)) {
    d.push('steps must be a non-empty array of non-empty strings');
  }
  // ADR 0458 §2.2 (correction) — provenance is closed-world: every cited claim
  // id must be one the EVIDENCE listed. A lesson with no evidence in scope
  // must cite nothing (claimRefs: []).
  if (!Array.isArray(lesson.claimRefs) || !lesson.claimRefs.every((r) => typeof r === 'string' && r.trim().length > 0)) {
    d.push('claimRefs must be an array of claim-id strings (empty when the lesson states no fact beyond the day\'s instruction)');
  } else {
    const unknown = lesson.claimRefs.filter((r) => !known.has(r));
    if (unknown.length) d.push(`claimRefs name claims the EVIDENCE does not list as supported: ${unknown.join(', ')} — cite only supported listed ids, or []`);
  }
  const allowed = new Set(['day', 'title', 'body', 'steps', 'claimRefs']);
  for (const k of Object.keys(lesson)) if (!allowed.has(k)) d.push(`unexpected field \`${k}\``);
  return d;
}

async function enrichLessonDay(ctx, rawDay, dayNum, i, evidence) {
  const shapeSection = evidence.schema
    ? `Return ONE lesson as strict JSON conforming EXACTLY to this JSON Schema (the node validates authoritatively):\n${JSON.stringify(evidence.schema)}\n`
    : 'Return STRICT JSON with EXACTLY these fields and no others:\n'
      + '{\n'
      + `  "day": ${dayNum},                 // echo this integer exactly\n`
      + '  "title": string,\n'
      + '  "body": string,                    // the teaching content (>= 40 chars)\n'
      + '  "steps": [string, ...],            // >= 1 concrete step the participant does today\n'
      + '  "claimRefs": [string, ...]         // claimIds from the EVIDENCE the body relies on; [] when none\n'
      + '}\n';
  const systemPrompt =
    `You expand ONE challenge-plan day (day ${dayNum}) into a participant-facing lesson. `
    + shapeSection
    + 'HARD RULES the validator enforces: `day` echoes the day number; every factual statement in `body` is backed by a claim in the EVIDENCE and that claim\'s id is listed in `claimRefs`; `claimRefs` may contain ONLY ids the EVIDENCE lists (an empty array when the lesson states nothing beyond the day\'s own instruction and rationale). Never invent facts, sources, statistics, or outcomes the EVIDENCE does not support. Reply with the JSON object only.';
  const call = async (messages) => {
    const ai = await ctx.callAI({
      provider: str(i.provider) || 'anthropic',
      model: str(i.model) || 'claude-sonnet-4-6',
      ...(str(i.credentialRef) ? { credentialRef: str(i.credentialRef) } : {}),
      systemPrompt,
      messages,
      temperature: 0,
      responseSchema: evidence.schema ?? LESSON_SHAPE_GUIDANCE,
    });
    return ai && typeof ai === 'object' ? ai.data : undefined;
  };
  const dayRefs = Array.isArray(rawDay && rawDay.claimRefs) ? rawDay.claimRefs.filter((r) => typeof r === 'string') : [];
  const base = [{ role: 'user', content: [
    `DAY PAYLOAD:\n${JSON.stringify(rawDay)}`,
    dayRefs.length ? `This day's plan cites: ${dayRefs.map((r) => `[${r}]`).join(' ')}` : 'This day\'s plan cites no claims.',
    evidence.rendered,
  ].join('\n\n') }];
  let lesson = await call(base);
  let defects = lessonDefects(lesson, dayNum, evidence.known);
  if (defects.length > 0) {
    // ONE bounded error-fed repair naming the validator's ACTUAL defects.
    lesson = await call([
      ...base,
      { role: 'assistant', content: JSON.stringify(lesson ?? null) },
      { role: 'user', content: `Your previous lesson FAILED validation with these defects:\n- ${defects.join('\n- ')}\nReturn the corrected FULL lesson JSON object only.` },
    ]);
    defects = lessonDefects(lesson, dayNum, evidence.known);
  }
  if (defects.length > 0) return { defects };
  return { lesson: { day: lesson.day, title: lesson.title, body: lesson.body, steps: lesson.steps, claimRefs: [...lesson.claimRefs] } };
}

export async function lessonBatchBuild(ctx) {
  if (typeof ctx.callAI !== 'function') {
    return { status: 'failed', error: { code: 'capability_missing', message: 'host does not expose ctx.callAI' } };
  }
  const i = ctx.inputs ?? {};
  const candidateId = str(i.candidateId);
  if (!candidateId) return { status: 'failed', error: { code: 'validation_error', message: 'Input `candidateId` is required.' } };
  const days = Array.isArray(i.days) ? i.days : [];
  // An absent slot (dead checkpoint) maps to an empty batch — a clean no-op success,
  // never a failure (the parent already skips a dead slot's build edge).
  if (days.length === 0) return { status: 'success', outputs: { lessons: [], count: 0, mediaCount: 0 } };
  const generateMedia = i.generateMedia === true || i.generateMedia === 'true';

  // ADR 0458 §2.2 (correction) — the lesson shape from the creator surface (SSoT)
  // and the evidence every lesson in this batch is grounded on + validated against.
  let schema = null;
  const creatorSurface = ctx.features && ctx.features['kicktodo-creator'];
  if (creatorSurface && typeof creatorSurface.lessonSchema === 'function') {
    const out = await creatorSurface.lessonSchema({});
    if (out && typeof out.schema === 'object' && out.schema !== null) schema = out.schema;
  }
  const evidence = { schema, rendered: renderEvidenceClaims(i.evidenceClaims), known: knownClaimIds(i.evidenceClaims) };

  let media = null;
  let creator = null;
  let gen = null;
  if (generateMedia) {
    media = ensureMedia(ctx);
    creator = ensureLessonMediaCreator(ctx);
    gen = typeof ctx.callImageGenerator === 'function'
      ? ctx.callImageGenerator
      : (ctx.aiProviders && typeof ctx.aiProviders.callImageGenerator === 'function' ? ctx.aiProviders.callImageGenerator : null);
    // Media was explicitly requested — fail closed rather than silently ship
    // media-less lessons that look like the visual was built (the honest-off rule).
    if (!gen) {
      throw Object.assign(
        new Error('host does not implement callImageGenerator — image generation is not wired (ADR 0115).'),
        { code: 'host_capability_missing', capability: 'host.aiProviders.imageGeneration' },
      );
    }
  }

  const lessons = [];
  let mediaCount = 0;
  for (const rawDay of days) {
    const dayNum = num(rawDay && rawDay.day, NaN);
    if (!Number.isInteger(dayNum)) {
      return { status: 'failed', error: { code: 'validation_error', message: 'Each day payload must carry an integer `day`.' } };
    }
    const { lesson, defects } = await enrichLessonDay(ctx, rawDay, dayNum, i, evidence);
    if (defects) {
      return { status: 'failed', error: { code: 'lesson_invalid', message: `Lesson for day ${dayNum} failed validation after one repair: ${defects.length} defect(s).`, defects } };
    }
    let mediaAssetId = null;
    if (generateMedia && gen) {
      const prompt = [str(rawDay.title), str(rawDay.actionInstruction), str(rawDay.userFacingWhy)].filter(Boolean).join('\n').slice(0, 2000);
      if (prompt) {
        const r = await gen.call(ctx, {
          prompt,
          n: 1,
          ...(str(i.provider) ? { provider: str(i.provider) } : {}),
          ...(str(i.model) ? { model: str(i.model) } : {}),
        });
        const images = r && Array.isArray(r.images) ? r.images : [];
        const url = images[0] && typeof images[0].url === 'string' ? images[0].url : '';
        if (url) {
          const res = await persistLessonMedia(ctx, media, creator, { candidateId, day: dayNum, url, kind: 'image' });
          if (!res.ok) return { status: 'failed', error: res.error };
          mediaAssetId = res.assetId;
          mediaCount += 1;
        }
      }
    }
    lessons.push({ ...lesson, ...(mediaAssetId ? { mediaAssetId } : {}) });
  }
  return { status: 'success', outputs: { lessons, count: lessons.length, mediaCount } };
}

nodes['feature.kicktodo.nodes.lesson-batch-build'] = lessonBatchBuild;

// ── Sim collect (ADR 0458 P2, pack v1.18.0) ──
//
// Collects the three read-only sim personas' typed verdicts and records them
// through `kicktodo-creator.recordSimulationVerdicts` (the closed-world normalize
// + persist the publication `simulation` gate reads). Each persona's verdict
// arrives on its own input PORT (the agent-runner's structured `result`, i.e. the
// sim-verdict schema {verdict, findings, personaSummary}); this node forwards those
// fields VERBATIM — it never renames them into a {summary,flags} shape — tagged
// with the persona as `sim` (the routing key the host normalizer keys off, and the
// exact shape the creator surface + its factory test consume). Defensive: if a
// whole agent-runner output map arrives on a port (the `result` un-unwrapped), it
// unwraps `.result`.

const SIM_PORT_TO_PERSONA = { newcomer: 'newcomer', timePoor: 'time-poor', skeptic: 'skeptic' };

/** Pull the verbatim sim-verdict body out of a port value — either the bare
 *  {verdict, findings, personaSummary} or an agent-runner output map carrying it
 *  under `.result`. Returns null when nothing shaped like a verdict is present. */
function extractSimVerdict(portValue) {
  if (!portValue || typeof portValue !== 'object') return null;
  const body = (portValue.result && typeof portValue.result === 'object') ? portValue.result : portValue;
  if (typeof body.verdict !== 'string') return null;
  return {
    verdict: body.verdict,
    findings: Array.isArray(body.findings) ? body.findings : [],
    personaSummary: typeof body.personaSummary === 'string' ? body.personaSummary : '',
  };
}

export async function simCollect(ctx) {
  const creator = ensureCreator(ctx);
  if (typeof creator.recordSimulationVerdicts !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-creator'].recordSimulationVerdicts — the KickTodo Creator feature must be enabled (ADR 0458 P2)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-creator' },
    );
  }
  const i = ctx.inputs ?? {};
  const candidateId = str(i.candidateId);
  if (!candidateId) return { status: 'failed', error: { code: 'validation_error', message: 'Input `candidateId` is required.' } };
  // The persona-tagged array the host normalizer consumes (`{ sim, verdict,
  // findings, personaSummary }`): the sim-verdict fields VERBATIM plus the persona
  // routing tag. A persona that returned nothing readable is omitted — the host
  // gate fails closed on missing coverage, so this node never fabricates a passing
  // verdict for an absent sim.
  const verdicts = [];
  for (const [port, persona] of Object.entries(SIM_PORT_TO_PERSONA)) {
    const body = extractSimVerdict(i[port]);
    if (body) verdicts.push({ sim: persona, ...body });
  }
  const out = await creator.recordSimulationVerdicts({ candidateId, verdicts });
  return {
    status: 'success',
    outputs: {
      recorded: verdicts.map((v) => v.sim),
      ...(out && out.state ? { state: out.state } : {}),
      ...(out && out.verdicts ? { verdicts: out.verdicts } : {}),
    },
  };
}

nodes['feature.kicktodo.nodes.sim-collect'] = simCollect;

// ── Apply revision commands (ADR 0459 P1, pack v1.19.0) ──
//
// The participant-replan APPLIER: a thin adapter over the governed
// `kicktodo-core.applyRevisionCommands` surface op. The revision reaching this
// node has ALREADY been validated closed-world against the challenge version and
// approved by the participant at their own gate (the builtin's job) — this node
// just forwards { enrollmentId, subject, commands } and reports the outcome.
// Authorization, per-lane validation, and the CAS apply stay in the host. A
// refusal is a TYPED failure that carries the surface's failing command index
// (`failedIndex`) so the caller can point the participant at the exact command;
// a missing surface fails typed (host_capability_missing), never a silent no-op.

export async function applyRevisionCommands(ctx) {
  const k = ensureKicktodo(ctx);
  if (typeof k.applyRevisionCommands !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-core'].applyRevisionCommands — the KickTodo feature must be enabled (ADR 0459 P1)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-core' },
    );
  }
  const i = ctx.inputs ?? {};
  const enrollmentId = str(i.enrollmentId);
  const subject = str(i.subject);
  const commands = Array.isArray(i.commands) ? i.commands : null;
  if (!enrollmentId) return { status: 'failed', error: { code: 'validation_error', message: 'Input `enrollmentId` is required.' } };
  if (!subject) return { status: 'failed', error: { code: 'validation_error', message: 'Input `subject` is required.' } };
  if (!commands) return { status: 'failed', error: { code: 'validation_error', message: 'Input `commands` must be an array.' } };
  let out;
  try {
    out = await k.applyRevisionCommands({ enrollmentId, subject, commands });
  } catch (err) {
    // Typed failure envelope on refusal — the surface throws an OpenwopError
    // ({ code, message, failedIndex? }) when a command is invalid or unauthorized.
    // Forward its code/message and the failing command index so the caller can
    // point the participant at the exact command; a codeless error is a genuine
    // fault — rethrow it.
    if (err && typeof err.code === 'string') {
      return {
        status: 'failed',
        error: {
          code: err.code,
          message: typeof err.message === 'string' ? err.message : 'Revision refused.',
          ...(Number.isInteger(err.failedIndex) ? { failedIndex: err.failedIndex } : {}),
        },
      };
    }
    throw err;
  }
  const o = out ?? {};
  return {
    status: 'success',
    outputs: { applied: o.applied === true, ...(Array.isArray(o.results) ? { results: o.results } : {}) },
  };
}

nodes['feature.kicktodo.nodes.apply-revision-commands'] = applyRevisionCommands;

// ── Enrich plan revision (ADR 0459 grade-fix, pack v1.20.0) ──
//
// The compose→approve HUMANIZER. It takes the Replan Composer's raw revision
// ({ commands, rationale }) and returns it wrapped as a TYPED artifact envelope
// ({ artifactTypeId: 'kicktodo.plan-revision', payload }) carrying an additive
// `display` (server-resolved activity/alternative titles — never an opaque id).
// The envelope shape is what the host run-artifact store detects
// (detectTypedArtifact), so the approval card dispatches the plan-revision
// renderer instead of rendering raw JSON. The APPLY path reads the raw revision
// off the SEPARATE compose→apply edge, so `commands` is never touched here.
//
// Best-effort by design: a missing or failing enrich surface degrades to the
// un-humanized payload (still a typed artifact, just without `display`) rather
// than failing the run — the approval card must ALWAYS render.

export async function enrichPlanRevision(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const enrollmentId = str(i.enrollmentId);
  const revision = i.revision && typeof i.revision === 'object' && !Array.isArray(i.revision) ? i.revision : null;
  if (!revision) {
    return { status: 'failed', error: { code: 'validation_error', message: 'Input `revision` (the composed plan revision) is required.' } };
  }
  let payload = revision;
  if (enrollmentId && typeof k.enrichPlanRevision === 'function') {
    try {
      const out = await k.enrichPlanRevision({ enrollmentId, revision });
      if (out && out.revision && typeof out.revision === 'object') payload = out.revision;
    } catch {
      // best-effort — fall back to the un-humanized payload (still typed).
    }
  }
  return {
    status: 'success',
    outputs: { result: { artifactTypeId: 'kicktodo.plan-revision', payload } },
  };
}

nodes['feature.kicktodo.nodes.enrich-plan-revision'] = enrichPlanRevision;

// ── Session reminder delivery (ADR 0459 P3, pack v1.19.0) ──
//
// The cohort-session T-minus reminder DELIVERY node. The one-shot scheduler job
// armed by sessionService fires ~1h before a scheduled session and carries the
// context this node forwards verbatim: { circleId, atIso, conversationId }. It is
// a thin adapter over the accountability session-notify surface op — the delivery
// (into the circle's OWN conversation), the live-grantee membership fan-out, and
// the ADR 0457 mute-respect all stay in the host. A missing surface fails typed
// (host_capability_missing), never a silent drop that would look like the reminder
// fired.
//
// PEER CONTRACT: the backend session-notify op landed as
// `ctx.features['kicktodo-accountability'].sendSessionReminder`
// ({ circleId, atIso, conversationId }) — the ADR-0459-specified name this node
// already targets, so the contract is matched (kicktodo-accountability surface.ts).

export async function sessionReminder(ctx) {
  const k = ensureAccountability(ctx);
  if (typeof k.sendSessionReminder !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-accountability'].sendSessionReminder — the KickTodo Accountability feature must be enabled (ADR 0459 P3)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-accountability' },
    );
  }
  const i = ctx.inputs ?? {};
  const circleId = str(i.circleId);
  const atIso = str(i.atIso);
  if (!circleId) return { status: 'failed', error: { code: 'validation_error', message: 'Input `circleId` is required.' } };
  if (!atIso) return { status: 'failed', error: { code: 'validation_error', message: 'Input `atIso` is required.' } };
  const out = await k.sendSessionReminder({
    circleId,
    atIso,
    ...(str(i.conversationId) ? { conversationId: str(i.conversationId) } : {}),
  });
  const o = out ?? {};
  return {
    status: 'success',
    outputs: { notified: o.notified === true, ...(o.reason != null ? { reason: str(o.reason) || null } : {}) },
  };
}

nodes['feature.kicktodo.nodes.session-reminder'] = sessionReminder;

// ── Replan clarification (ADR 0463, pack v1.21.0) ──
//
// The one-round A2UI clarification leg on the replan builtin (ADR 0459 flow). It
// sits BETWEEN the composer and enrich. The composer's plan-revision may carry an
// OPTIONAL `clarification` (ASK XOR ACT — present ONLY when `commands` is empty)
// when the intent falls in the ADR 0429 lanes but is under-specified ("move my
// rest day" without which day). When a clarification is present AND a real
// executor `ctx.suspend` is available, this node builds a day-1-catalog surface
// from the signalled field (a `select` or a `date`), `ctx.suspend`s a
// `clarification` interrupt — the SAME interrupt→`a2uiInterruptCard` bridge the
// chat already renders (RFC 0102 / ADR 0051) — and folds the collected value into
// the pending command's single unfilled slot (keyed at `field.id`), emitting the
// completed command as the sole revision command. With NO clarification (the
// composer already ACTED) — or in a non-executor context with no `ctx.suspend` —
// it passes the revision through UNCHANGED. Bounded to ONE round (ADR 0463 OQ3):
// it never re-clarifies. Mirrors the enqueue-action a2ui pattern.

export async function replanClarify(ctx) {
  const i = ctx.inputs ?? {};
  const revision = i.revision && typeof i.revision === 'object' && !Array.isArray(i.revision) ? i.revision : null;
  if (!revision) {
    return { status: 'failed', error: { code: 'validation_error', message: 'Input `revision` (the composed plan revision) is required.' } };
  }
  const clarification = revision.clarification && typeof revision.clarification === 'object' && !Array.isArray(revision.clarification)
    ? revision.clarification
    : null;
  const field = clarification && clarification.field && typeof clarification.field === 'object' && !Array.isArray(clarification.field)
    ? clarification.field
    : null;

  // ASK arm — only in a real executor run (ctx.suspend present) with a
  // well-formed clarification field. Anything else degrades to passthrough.
  if (clarification && field && str(field.id) && typeof ctx.suspend === 'function') {
    const surface = {
      title: 'One quick question about your plan',
      components: [
        { component: 'text', text: str(clarification.question) },
        {
          component: field.type === 'date' ? 'field.date' : 'field.select',
          id: str(field.id),
          label: str(field.label) || str(field.id),
          required: true,
          ...(Array.isArray(field.options) ? { options: field.options } : {}),
        },
        { component: 'action.button', id: 'confirm', label: 'Continue', action: { target: 'resume' } },
      ],
    };
    const values = await ctx.suspend({
      reason: 'clarification',
      resumeKey: 'replan-clarify',
      // Free-text fallback for any consumer that doesn't render A2UI surfaces.
      question: str(clarification.question),
      catalogVersion: '0.9.1',
      surface,
    });
    // Fold the participant's answer into the pending command's single unfilled
    // slot; the completed command is the sole entry of the applied revision.
    const pending = clarification.pendingCommand && typeof clarification.pendingCommand === 'object' ? clarification.pendingCommand : {};
    const filled = { ...pending, [str(field.id)]: values ? values[field.id] : undefined };
    return {
      status: 'success',
      outputs: { result: { commands: [filled], rationale: revision.rationale } },
    };
  }

  // ACT / passthrough — the composer already produced commands, or there is no
  // executor suspend to raise the form. Emit the revision unchanged (one-round
  // bound; enrich + apply read this exact output).
  return { status: 'success', outputs: { result: revision } };
}

nodes['feature.kicktodo.nodes.replan-clarify'] = replanClarify;

// ── Surface-parity sweep (NODE-PACK-AUDIT NP-KT-1, pack v1.22.0) ──
//
// Thin wrappers closing the 17 surface methods no node reached (the 2026-06-23
// read-coverage remediation pattern): reads are role:"read", the three writes
// (set-schedule-preference, create-candidate, propose-plan-change) role:"action".
// Authorization/validation stay in the host services; nodes only marshal
// ctx.inputs → surface args and shape { status, outputs }.

export async function listChallenges(ctx) {
  const k = ensureKicktodo(ctx);
  const out = await k.listChallenges({});
  return { status: 'success', outputs: { challenges: out.challenges } };
}

nodes['feature.kicktodo.nodes.list-challenges'] = listChallenges;

export async function getEnrollment(ctx) {
  const k = ensureKicktodo(ctx);
  const out = await k.getEnrollment({ enrollmentId: str((ctx.inputs ?? {}).enrollmentId) });
  return { status: 'success', outputs: { enrollment: out.enrollment ?? null } };
}

nodes['feature.kicktodo.nodes.get-enrollment'] = getEnrollment;

export async function setSchedulePreference(ctx) {
  const k = ensureKicktodo(ctx);
  const i = ctx.inputs ?? {};
  const daypart =
    i.daypart === 'morning' || i.daypart === 'afternoon' || i.daypart === 'evening' ? i.daypart : null;
  const out = await k.setSchedulePreference({
    enrollmentId: str(i.enrollmentId),
    ownerSubject: str(i.ownerSubject),
    daypart,
  });
  return { status: 'success', outputs: { enrollment: out.enrollment ?? null } };
}

nodes['feature.kicktodo.nodes.set-schedule-preference'] = setSchedulePreference;

export async function today(ctx) {
  const k = ensureKicktodo(ctx);
  const out = await k.today({ ownerSubject: str((ctx.inputs ?? {}).ownerSubject) });
  return { status: 'success', outputs: { today: out } };
}

nodes['feature.kicktodo.nodes.today'] = today;

export async function progress(ctx) {
  const k = ensureKicktodo(ctx);
  const out = await k.progress({ enrollmentId: str((ctx.inputs ?? {}).enrollmentId) });
  return { status: 'success', outputs: { progress: out.progress } };
}

nodes['feature.kicktodo.nodes.progress'] = progress;

export async function createCandidate(ctx) {
  const k = ensureCreator(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.createCandidate({
    createdBy: str(i.createdBy),
    topic: str(i.topic),
    audience: str(i.audience),
    transformation: str(i.transformation),
    ...(typeof i.durationDaysTarget === 'number' ? { durationDaysTarget: i.durationDaysTarget } : {}),
    ...(typeof i.dailyMinutesTarget === 'number' ? { dailyMinutesTarget: i.dailyMinutesTarget } : {}),
  });
  return { status: 'success', outputs: { candidate: out.candidate } };
}

nodes['feature.kicktodo.nodes.create-candidate'] = createCandidate;

export async function getCandidate(ctx) {
  const k = ensureCreator(ctx);
  const out = await k.getCandidate({ candidateId: str((ctx.inputs ?? {}).candidateId) });
  return { status: 'success', outputs: { candidate: out.candidate ?? null } };
}

nodes['feature.kicktodo.nodes.get-candidate'] = getCandidate;

export async function lessonMedia(ctx) {
  const k = ensureCreator(ctx);
  const out = await k.lessonMedia({ candidateId: str((ctx.inputs ?? {}).candidateId) });
  return { status: 'success', outputs: { pointers: out.pointers } };
}

nodes['feature.kicktodo.nodes.lesson-media'] = lessonMedia;

export async function getCandidatePlan(ctx) {
  const k = ensureCreator(ctx);
  const out = await k.getCandidatePlan({ candidateId: str((ctx.inputs ?? {}).candidateId) });
  return { status: 'success', outputs: { planRevision: out.planRevision ?? null } };
}

nodes['feature.kicktodo.nodes.get-candidate-plan'] = getCandidatePlan;

export async function listCircles(ctx) {
  const k = ensureAccountability(ctx);
  const out = await k.listCircles({ ownerSubject: str((ctx.inputs ?? {}).ownerSubject) });
  return { status: 'success', outputs: { circles: out.circles } };
}

nodes['feature.kicktodo.nodes.list-circles'] = listCircles;

export async function coachCaseload(ctx) {
  const k = ensureAccountability(ctx);
  const out = await k.caseload({ coachSubject: str((ctx.inputs ?? {}).coachSubject) });
  return { status: 'success', outputs: { caseload: out.caseload } };
}

nodes['feature.kicktodo.nodes.coach-caseload'] = coachCaseload;

export async function proposePlanChange(ctx) {
  const k = ensureAccountability(ctx);
  const i = ctx.inputs ?? {};
  const out = await k.propose({
    circleId: str(i.circleId),
    coachSubject: str(i.coachSubject),
    note: str(i.note),
  });
  return { status: 'success', outputs: { proposal: out.proposal } };
}

nodes['feature.kicktodo.nodes.propose-plan-change'] = proposePlanChange;

export async function creatorProfile(ctx) {
  const k = ensureCommunity(ctx);
  const out = await k.profile({ handle: str((ctx.inputs ?? {}).handle) });
  return { status: 'success', outputs: { profile: out.profile ?? null } };
}

nodes['feature.kicktodo.nodes.creator-profile'] = creatorProfile;

export async function creatorAnalytics(ctx) {
  const k = ensureCommunity(ctx);
  const out = await k.analytics({ creatorSubject: str((ctx.inputs ?? {}).creatorSubject) });
  return { status: 'success', outputs: { challenges: out.challenges } };
}

nodes['feature.kicktodo.nodes.creator-analytics'] = creatorAnalytics;

export async function listConsents(ctx) {
  const k = ensureIntegrations(ctx);
  const out = await k.consents({ ownerSubject: str((ctx.inputs ?? {}).ownerSubject) });
  return { status: 'success', outputs: { consents: out.consents } };
}

nodes['feature.kicktodo.nodes.list-consents'] = listConsents;

export async function verifierQuality(ctx) {
  const k = ctx.features && ctx.features['kicktodo-metrics'];
  if (!k || typeof k.verifierQuality !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-metrics'] — the feature must be enabled (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-metrics' },
    );
  }
  const out = await k.verifierQuality({});
  return { status: 'success', outputs: { quality: out.quality } };
}

nodes['feature.kicktodo.nodes.verifier-quality'] = verifierQuality;

export async function orgCatalog(ctx) {
  const k = ensureOrgPrograms(ctx);
  if (typeof k.catalog !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['kicktodo-organizations'].catalog (ADR 0428)"),
      { code: 'host_capability_missing', capability: 'host.sample.kicktodo-organizations' },
    );
  }
  const out = await k.catalog({ orgId: str((ctx.inputs ?? {}).orgId) });
  return { status: 'success', outputs: { catalog: out.catalog } };
}

nodes['feature.kicktodo.nodes.org-catalog'] = orgCatalog;
