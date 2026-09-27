/**
 * feature.app-builder.nodes — the producer for ADR 0153 Phase 2 app-builder canvases.
 * The `render` node normalizes a requested app design into the `canvas.app-builder`
 * shape ({ name, screens[], connectors[] }) and emits the typed `{ artifact }` output
 * envelope (ADR 0055/0083): the host run-output producer persists it as a renderable
 * artifact, and the chat workbench's app-builder renderer shows it inline.
 *
 * Components reference the host app-builder catalog by `type`; the model is told the
 * closed component set in the agent prompt, and the host validates the tree against
 * the catalog on the editor save path (closed-world). This node does structural
 * normalization + fail-fast so a malformed design never persists as an empty render.
 *
 * Pure-JS, Node-20 stdlib only. No host capability.
 */

function fail(message) {
  return Object.assign(new Error(message), { code: 'validation_error' });
}

/** XCH-APPB-3 (LLM-EXCHANGE-AUDIT Wave 2): closed-world gate via the host
 *  surface (`ctx.features['app-builder'].validate` → validateAppDoc — the
 *  workflow-author `validateDraft` precedent). Returns the verdict, or null
 *  when the host doesn't expose the surface (foreign host running the
 *  vendored pack — normalize-only behavior, honestly marked unvalidated). */
async function surfaceValidate(ctx, payload) {
  const ab = ctx.features && ctx.features['app-builder'];
  if (!ab || typeof ab.validate !== 'function') return null;
  return await ab.validate({ app: payload });
}

function safeParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function str(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return max && t.length > max ? t.slice(0, max) : t;
}

/** Normalize one component node (recursive). Keeps only { type, props?, children? }
 *  — the closed canvas.app-builder shape; unknown keys are dropped. */
function normalizeComponent(raw, depth) {
  if (depth > 20) throw fail('component tree too deep (max 20)');
  if (!raw || typeof raw !== 'object') throw fail('component is not an object');
  const type = str(raw.type, 80);
  if (!type) throw fail('every component needs a string `type`');
  const out = { type };
  if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) out.props = raw.props;
  if (Array.isArray(raw.children) && raw.children.length) {
    out.children = raw.children.slice(0, 200).map((c) => normalizeComponent(c, depth + 1));
  }
  return out;
}

// Grade data-F6: normalize ids to the editor's slug rule (ID_RE in
// validateAppDoc) — an AI id like "Home Screen" is schema-valid but would seed
// a canvas whose EVERY save 422s. Slugified + deduped here so chat renders and
// editor seeds always produce an editable doc; connector/navigateTo refs are
// remapped by the caller via the returned mapping.
function slugId(raw, fallback) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  const slug = v.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return /[a-z0-9]/.test(slug) ? slug : fallback;
}

// Grade data-F1: pass the ADR 0323 layout through — the plan node EMITS x/y
// (Phase 4); dropping them here silently discarded every AI layout.
const POS_BOUND = 100000;
function finiteNum(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.max(-POS_BOUND, Math.min(POS_BOUND, Math.round(v))) : undefined; }

function normalizeScreen(raw, index, usedIds) {
  if (!raw || typeof raw !== 'object') throw fail(`screen ${index} is not an object`);
  let id = slugId(raw.id, `screen-${index + 1}`);
  while (usedIds.has(id)) id = `${id.slice(0, 70)}-${index + 1}`;
  usedIds.add(id);
  const name = str(raw.name, 120) ?? id;
  const out = { id, name };
  const route = str(raw.route, 200); if (route) out.route = route;
  if (raw.isInitial === true) out.isInitial = true;
  const x = finiteNum(raw.x); if (x !== undefined) out.x = x;
  const y = finiteNum(raw.y); if (y !== undefined) out.y = y;
  if (Array.isArray(raw.components)) out.components = raw.components.slice(0, 200).map((c) => normalizeComponent(c, 0));
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const appIn = (i.app && typeof i.app === 'object') ? i.app : safeParse(i.source) ?? i;

  const name = str(appIn.name, 200);
  if (!name) throw fail('`name` is required (the app name)');
  const screensIn = Array.isArray(appIn.screens) ? appIn.screens : null;
  if (!screensIn || screensIn.length === 0) throw fail('`screens` is required — a non-empty array');
  if (screensIn.length > 60) throw fail('an app may have at most 60 screens');

  const usedIds = new Set();
  const idMap = new Map(); // original id -> normalized id (for connector/nav remap)
  const payload = { name, screens: screensIn.map((raw, idx) => {
    const before = typeof raw?.id === 'string' ? raw.id.trim() : '';
    const scr = normalizeScreen(raw, idx, usedIds);
    if (before) idMap.set(before, scr.id);
    return scr;
  }) };
  // Remap navigateTo props that referenced pre-normalization ids.
  const remapNav = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.navigateTo === 'string' && idMap.has(node.props.navigateTo)) {
      node.props.navigateTo = idMap.get(node.props.navigateTo);
    }
    if (Array.isArray(node.children)) node.children.forEach(remapNav);
  };
  for (const scr of payload.screens) (scr.components ?? []).forEach(remapNav);
  const description = str(appIn.description, 2000); if (description) payload.description = description;
  if (typeof appIn.theme === 'string' && ['default', 'light', 'dark'].includes(appIn.theme)) payload.theme = appIn.theme;
  // Grade F3 — themeColors + dataSources are REAL schema fields the node was
  // silently stripping (the dead-on-the-wire class): the audit's theme check
  // and the plan's grounded colors need them to survive this seam.
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const tc = appIn.themeColors && typeof appIn.themeColors === 'object' ? appIn.themeColors : null;
  if (tc) {
    const out = {};
    if (typeof tc.primary === 'string' && HEX6.test(tc.primary)) out.primary = tc.primary;
    if (typeof tc.secondary === 'string' && HEX6.test(tc.secondary)) out.secondary = tc.secondary;
    if (Object.keys(out).length) payload.themeColors = out;
  }
  if (Array.isArray(appIn.dataSources)) {
    const sources = [];
    for (const d of appIn.dataSources.slice(0, 20)) {
      const id = slugId(d?.id, '');
      if (!id) continue;
      const src = { id };
      const dn = str(d?.name, 120); if (dn) src.name = dn;
      if (Array.isArray(d?.fields)) src.fields = d.fields.filter((f) => typeof f === 'string' && f).slice(0, 20).map((f) => f.slice(0, 60));
      if (Array.isArray(d?.rows)) src.rows = d.rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 10);
      sources.push(src);
    }
    if (sources.length) payload.dataSources = sources;
  }

  if (Array.isArray(appIn.connectors)) {
    const screenIds = new Set(payload.screens.map((s) => s.id));
    const connectors = [];
    const seenPair = new Set();
    const EDGE_SIDES = ['top', 'right', 'bottom', 'left'];
    const TRANSITIONS = ['push', 'replace', 'modal', 'fade', 'slide', 'none'];
    const ROUTING = ['bezier', 'orthogonal', 'straight', 'step'];
    for (const c of appIn.connectors.slice(0, 200)) {
      const from = idMap.get(str(c?.from, 80)) ?? str(c?.from, 80);
      const to = idMap.get(str(c?.to, 80)) ?? str(c?.to, 80);
      // Drop connectors that don't reference real screens (no dangling edges),
      // and collapse duplicate (from,to) pairs — the editor's dedupe rule
      // (grade data-F8: the two producers previously disagreed).
      if (!from || !to || !screenIds.has(from) || !screenIds.has(to)) continue;
      if (seenPair.has(`${from}\u0000${to}`)) continue;
      seenPair.add(`${from}\u0000${to}`);
      const conn = { from, to };
      if (typeof c.trigger === 'string' && ['click', 'submit', 'load'].includes(c.trigger)) conn.trigger = c.trigger;
      const label = str(c.label, 120); if (label) conn.label = label;
      // Grade data-F1: the ADR 0323 presentation fields now survive the node.
      if (typeof c.transition === 'string' && TRANSITIONS.includes(c.transition)) conn.transition = c.transition;
      if (typeof c.sourceEdge === 'string' && EDGE_SIDES.includes(c.sourceEdge)) conn.sourceEdge = c.sourceEdge;
      if (typeof c.targetEdge === 'string' && EDGE_SIDES.includes(c.targetEdge)) conn.targetEdge = c.targetEdge;
      if (typeof c.routingStyle === 'string' && ROUTING.includes(c.routingStyle)) conn.routingStyle = c.routingStyle;
      if (c.animated === true) conn.animated = true;
      connectors.push(conn);
    }
    if (connectors.length) payload.connectors = connectors;
  }

  // XCH-APPB-3: an out-of-catalog component FAILS here instead of persisting
  // via the artifact path and 422ing on the user's first editor save.
  const verdict = await surfaceValidate(ctx, payload);
  if (verdict && !verdict.ok) {
    const first = (verdict.errors ?? [])[0];
    throw Object.assign(
      new Error(`rendered app failed closed-world validation${first ? `: ${first.path}: ${first.message}` : ''}`),
      { code: 'app_doc_invalid', details: { errors: (verdict.errors ?? []).slice(0, 10) } },
    );
  }

  return {
    status: 'success',
    outputs: {
      screenCount: payload.screens.length,
      validation: verdict ? { ok: true, warnings: (verdict.warnings ?? []).length } : { unvalidated: true },
      artifact: {
        artifactTypeId: 'canvas.app-builder',
        payload,
        title: name,
      },
    },
  };
}

/**
 * export (ADR 0173) — generate framework-native source from an app design via the
 * host surface. role:action → the recorded output (the Media-asset token) is read
 * verbatim on replay/fork.
 */
export async function exportSource(ctx) {
  const ab = ctx.features && ctx.features['app-builder'];
  if (!ab || typeof ab.export !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['app-builder'].export — App Builder + Code Export must be composed (ADR 0173)"),
      { code: 'host_capability_missing', capability: 'host.sample.app-builder' },
    );
  }
  const i = ctx.inputs ?? {};
  const target = typeof i.target === 'string' ? i.target : '';
  const args = { target };
  if (i.app && typeof i.app === 'object') args.app = i.app;
  else if (typeof i.canvasId === 'string' && i.canvasId) args.canvasId = i.canvasId;
  const out = await ab.export(args);
  return { status: 'success', outputs: out };
}

/**
 * Translate an existing App Builder canvas into the generic Kanban proposal
 * envelope. This is intentionally a producer adapter, not an alternate board
 * implementation: the core Kanban pack owns materialization, lifecycle and
 * execution. Forward-only connector dependencies preserve the designer's
 * screen-flow intent without turning ordinary back-navigation into a task DAG
 * cycle; skipped back-edges are explicit in the output for review.
 */
export async function proposeKanbanWork(ctx) {
  const ab = ctx.features && ctx.features['app-builder'];
  if (!ab || typeof ab.getDesign !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['app-builder'].getDesign"),
      { code: 'host_capability_missing' },
    );
  }
  const canvasId = str(ctx.inputs?.canvasId, 120);
  if (!canvasId) throw fail('`canvasId` is required');
  const columnId = str(ctx.inputs?.columnId, 160) ?? 'todo';
  const workflowId = str(ctx.inputs?.workflowId, 512);
  const { app, version } = await ab.getDesign({ canvasId });
  if (!app || typeof app !== 'object' || Array.isArray(app)) throw fail('stored app design is invalid');
  const screens = Array.isArray(app.screens) ? app.screens : [];
  if (screens.length === 0) throw fail('the stored app design has no screens to plan');

  const screenIndex = new Map();
  const screenIds = [];
  for (let index = 0; index < screens.length; index += 1) {
    const id = str(screens[index]?.id, 80);
    if (!id) throw fail(`screen ${index + 1} has no stable id`);
    if (screenIndex.has(id)) throw fail(`screen ${index + 1} duplicates stable id '${id}'`);
    screenIndex.set(id, index);
    screenIds.push(id);
  }
  const dependencies = new Map(screenIds.map((id) => [id, new Set()]));
  let skippedBackReferences = 0;
  for (const connector of Array.isArray(app.connectors) ? app.connectors : []) {
    const from = str(connector?.from, 80);
    const to = str(connector?.to, 80);
    if (!from || !to || !screenIndex.has(from) || !screenIndex.has(to)) continue;
    if (screenIndex.get(from) < screenIndex.get(to)) dependencies.get(to)?.add(`screen.${from}`);
    else skippedBackReferences += 1;
  }

  const revision = (typeof version === 'string' || typeof version === 'number') ? String(version) : undefined;
  if (!revision) throw fail('the stored app design has no stable version');
  const appName = str(app.name, 200) ?? 'this app';
  const items = screens.map((screen, index) => {
    const id = screenIds[index];
    if (!id) throw fail(`screen ${index + 1} has no stable id`);
    const name = str(screen.name, 120) ?? `Screen ${index + 1}`;
    const route = str(screen.route, 200);
    return {
      key: `screen.${id}`,
      title: `Build ${name}`,
      description: `Implement the ${name} screen for ${appName}${route ? ` (${route})` : ''}.`,
      columnId,
      ...(workflowId ? { workflowId } : {}),
      ...(dependencies.get(id)?.size ? { dependsOnKeys: [...dependencies.get(id)] } : {}),
    };
  });
  return {
    status: 'success',
    outputs: {
      proposal: {
        scope: { kind: 'canvas.app-builder', externalRef: canvasId },
        source: { kind: 'app-builder.design', id: canvasId, revision },
        items,
      },
      ...(skippedBackReferences > 0 ? { skippedBackReferences } : {}),
    },
  };
}

export const nodes = {
  'feature.app-builder.nodes.render': render,
  'feature.app-builder.nodes.export': exportSource,
  'feature.app-builder.nodes.research': research,
  'feature.app-builder.nodes.deepen': deepen,
  'feature.app-builder.nodes.audit': audit,
  'feature.app-builder.nodes.capture': capture,
  'feature.app-builder.nodes.repair': repair,
  'feature.app-builder.nodes.apply-repair': applyDesignRepair,
  'feature.app-builder.nodes.propose-kanban-work': proposeKanbanWork,
};

/* ── ADR 0325 — AI node depth: research / deepen / audit ──────────────── */

// The closed component vocabulary — PORTABILITY FALLBACK ONLY (ADR 0358
// Phase C): nodes prefer the live list from ctx.features['app-builder']
// .getCatalog().promptTypeList (derived from the host SSoT, zero drift); this
// mirror serves hosts without that surface op. The deepen tripwire test pins
// it against APP_BUILDER_COMPONENTS so even the fallback cannot drift silently.
export const CATALOG_TYPES = 'stack, grid, card, accordion, tabs, dialog, drawer, spacer, heading, text, badge, chip, divider, alert, avatar, icon, progress, rating, calendar, snackbar, stepper, image, video, carousel, button, fab, textInput, textarea, dateInput, fileUpload, search, checkbox, toggle, select, radioGroup, slider, form, link, navBar, sideNav, breadcrumb, pagination, list, table, statCard';

/** The closed type list for an LLM prompt: the host's live SSoT-derived list
 *  when the surface offers it, else the pinned fallback. Soft on every
 *  failure — a catalog read must never change a node's failure semantics. */
async function liveTypeList(ctx) {
  try {
    const ab = ctx.features && ctx.features['app-builder'];
    if (ab && typeof ab.getCatalog === 'function') {
      const cat = await ab.getCatalog({});
      if (cat && typeof cat.promptTypeList === 'string' && cat.promptTypeList) return cat.promptTypeList;
    }
  } catch { /* fall through to the pinned fallback */ }
  return CATALOG_TYPES;
}

function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    // The code the core AI pack uses for a missing host capability —
    // 'validation_error' would misclassify the failure in run data.
    const e = new Error('this host does not provide ctx.callAI (host.aiProviders)');
    e.code = 'host_capability_missing';
    throw e;
  }
}

/** RFC 0020 posture (mirrors core.openwop.ai): on an untrusted boundary,
 *  user-derived prompt content is wrapped in <UNTRUSTED> markers. */
function markUntrusted(ctx, text) {
  if (ctx.trustBoundary !== 'untrusted') return text;
  return text.includes('<UNTRUSTED>') ? text : `<UNTRUSTED>${text}</UNTRUSTED>`;
}

/** One BYOK call returning parsed JSON, or an { error } on any failure
 *  (soft-fail — ADR 0325: enhancers never kill the run; callers surface a
 *  loud warning; the `repair` node hard-fails on its own).
 *
 *  XCH-APPB-4: `opts.responseSchema` rides `ctx.callAI` — on hosts with the
 *  provider reliability loop (RFC 0030/0032) that buys lenient parsing,
 *  schema-hint retries, NL-to-format coercion, and a typed failure; the
 *  `.data`-first read below picks up its structured result. The
 *  `safeParse(content)` fallback stays for hosts (and test mocks) that
 *  ignore responseSchema. `opts.validate(parsed) => string[]` covers what
 *  the host loop can't (it checks top-level required keys only, not types):
 *  contract errors drive ONE bounded error-fed repair — assistant echo of
 *  the bad-but-parsed output + a corrective turn at temperature 0 (the
 *  campaign-brief pattern). The repair NEVER fires on parse failure (the
 *  host loop owns that class); it only refines data we actually hold, so
 *  the echo is always honest. */
async function tryAiJson(ctx, systemPrompt, userText, opts = {}) {
  const { provider, model, temperature, maxTokens } = ctx.config ?? {};
  const base = {
    provider,
    model,
    systemPrompt,
    maxTokens: maxTokens ?? 4000,
    ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
  };
  const userTurn = { role: 'user', content: markUntrusted(ctx, userText) };
  const readParsed = (result) => {
    if (result && result.data && typeof result.data === 'object') return result.data;
    const parsed = safeParse(String(result?.content ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  };
  try {
    const result = await ctx.callAI({
      ...base,
      messages: [userTurn],
      ...(temperature !== undefined ? { temperature } : {}),
    });
    const parsed = readParsed(result);
    if (!parsed) return { error: 'malformed JSON from the model' };
    const contractErrors = typeof opts.validate === 'function' ? (opts.validate(parsed) ?? []) : [];
    if (!contractErrors.length) return { data: parsed };
    // ONE bounded contract repair: feed the exact errors back, deterministic.
    const retry = await ctx.callAI({
      ...base,
      temperature: 0,
      messages: [
        userTurn,
        { role: 'assistant', content: JSON.stringify(parsed) },
        { role: 'user', content: `Your previous reply did not meet the required contract: ${contractErrors.join('; ')}. Return ONLY the corrected raw JSON in the same shape, fixing exactly these problems.` },
      ],
    });
    const repaired = readParsed(retry);
    const repairedErrors = repaired && typeof opts.validate === 'function' ? (opts.validate(repaired) ?? []) : (repaired ? [] : ['unparseable repair']);
    return repaired && !repairedErrors.length
      ? { data: repaired }
      : { error: `model output failed the contract after one repair (${contractErrors.join('; ')})` };
  } catch (err) {
    // NEVER swallow the engine's suspension signal; soft-fail everything else
    // with the error code so warnings are diagnosable (byok vs provider vs 429).
    if (err && err.name === 'SuspendSignal') throw err;
    return { error: `${err?.code ?? 'ai_error'}: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

/** XCH-APPB-4 — hoisted response schemas, shared by the first call and the
 *  repair (replay-stable, the campaign-brief KERNEL_RESPONSE_SCHEMA shape).
 *  `required` drives the host reliability loop's key check; nested types are
 *  enforced by each node's `validate` contract / downstream gates. */
export const RESEARCH_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['personas', 'brand', 'visualDirection'],
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, role: { type: 'string' },
          goals: { type: 'array', items: { type: 'string' } },
          frustrations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    brand: {
      type: 'object',
      properties: { tone: { type: 'string' }, voice: { type: 'string' }, personality: { type: 'array', items: { type: 'string' } } },
    },
    visualDirection: {
      type: 'object',
      properties: { style: { type: 'string' }, themePrimary: { type: 'string' }, themeSecondary: { type: 'string' }, imagery: { type: 'string' } },
    },
  },
};

export const DEEPEN_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['components'],
  properties: { components: { type: 'array', items: { type: 'object' } } },
};

export const REPAIR_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['name', 'screens'],
  properties: {
    name: { type: 'string' }, description: { type: 'string' }, theme: { type: 'string' },
    themeColors: { type: 'object' }, screens: { type: 'array' }, connectors: { type: 'array' },
  },
};

/**
 * research (ADR 0325 P1) — ONE call producing personas + brand voice + visual
 * direction from the idea + PRD; grounds the plan stage. Soft-fails to empty.
 */
export async function research(ctx) {
  ensureCallAI(ctx);
  const idea = str(ctx.inputs?.idea, 2000) ?? '';
  const prd = str(ctx.inputs?.prd, 12000) ?? '';
  const attempt = await tryAiJson(
    ctx,
    'You are a product researcher. Output ONLY a JSON object (raw JSON, no prose, no code fences): { "personas": [{ "name", "role", "goals": [..], "frustrations": [..] }] (2-3 entries), "brand": { "tone", "voice", "personality": [..] }, "visualDirection": { "style", "themePrimary": "#rrggbb", "themeSecondary": "#rrggbb", "imagery" } }. Be specific to the product — real motivations, a distinct voice, hex colors that suit the domain.',
    `IDEA:\n${idea}\n\nPRD:\n${prd}`,
    {
      responseSchema: RESEARCH_RESPONSE_SCHEMA,
      // The host loop checks top-level keys only — the array-ness of personas
      // is the contract the plan stage actually consumes (XCH-APPB-4). Same
      // check the node's soft-fail gate has always applied.
      validate: (parsed) => (Array.isArray(parsed.personas) ? [] : ['"personas" must be a JSON array of persona objects']),
    },
  );
  const parsed = attempt.data;
  if (!parsed || !Array.isArray(parsed.personas)) {
    // planContext degrades to the PRD alone — the plan stage still fires with
    // full context, just ungrounded (soft-fail, loud).
    return { status: 'success', outputs: { content: '', planContext: prd, warning: `research unavailable (${attempt.error ?? 'unexpected shape'}) — the design proceeds ungrounded` } };
  }
  const json = JSON.stringify(parsed);
  // planContext is the plan node's SOLE input: chatCompletion's toMessages()
  // reads one priority port, so PRD + research must arrive combined (a second
  // port is silently dropped — verified in core.openwop.ai; grade G3-2).
  // ADR 0346 4c — the research is ALSO a typed secondary deliverable: the
  // `.artifact` envelope (detectTypedArtifact contract) + the node's
  // outputRole:'secondary' make the executor persist a durable `app.research`
  // artifact (schema-validated; a malformed payload falls through untyped).
  return { status: 'success', outputs: {
    content: json,
    research: parsed,
    planContext: `PRD:\n${prd}\n\nRESEARCH (personas, brand voice, visual direction):\n${json}`,
    artifact: { artifactTypeId: 'app.research', payload: parsed, title: 'Product research' },
  } };
}

const countNodes = (list, depth = 0) => (depth > 25 || !Array.isArray(list) ? 0 : list.reduce((n, c) => n + 1 + countNodes(c?.children, depth + 1), 0));

/**
 * deepen (ADR 0325 P2) — the MyndHyve perScreenExecutor shape, server-side:
 * enrich the ≤maxScreens THINNEST screens (component count < minComponents),
 * one BYOK call each, re-normalized through the SAME normalizeComponent gate
 * the render node uses (enriched output must survive the same normalization —
 * the grade-pass seam lesson). Emits the chain's final artifact. Per-screen
 * failure keeps the original screen; a wholly-skipped pass says so loudly.
 */
export async function deepen(ctx) {
  ensureCallAI(ctx);
  const artifactIn = ctx.inputs?.artifact;
  const payloadIn = artifactIn && typeof artifactIn === 'object' && artifactIn.payload && typeof artifactIn.payload === 'object'
    ? artifactIn.payload
    : null;
  if (!payloadIn || !Array.isArray(payloadIn.screens)) throw fail('deepen requires the render artifact on the `artifact` input');
  // The scheduler delivers upstream outputs BY REFERENCE — mutating the input
  // payload would rewrite render's recorded outputs in the run snapshot.
  // Deep-clone before enriching (grade G3-1).
  const payload = JSON.parse(JSON.stringify(payloadIn));
  const researchJson = str(ctx.inputs?.research, 8000) ?? '';
  // Clamped BOTH ways — a negative "disable" sentinel must never unbound the
  // ≤4-call cost cap (slice(0,-1) would take ALL screens but one). An EXPLICIT
  // 0 disables (live-caught: `Number(0) || 4` silently re-enabled it).
  const rawMax = Number(ctx.config?.maxScreens);
  const maxScreens = Math.max(0, Math.min(Number.isFinite(rawMax) ? rawMax : 4, 4));
  const minComponents = Number(ctx.config?.minComponents) || 5;

  const ranked = payload.screens
    .map((scr, i) => ({ scr, i, count: countNodes(scr.components) }))
    .filter((r) => r.count < minComponents)
    .sort((a, b) => a.count - b.count)
    .slice(0, maxScreens);

  const deepened = [];
  for (const { scr, i } of ranked) {
    // XCH-APPB-4: the requested root is an OBJECT wrap ({ "components": [..] })
    // so provider-native JSON modes (object-root-only) apply; the parse below
    // still accepts a bare array from hosts that ignore responseSchema.
    const attempt = await tryAiJson(
      ctx,
      `You are enriching ONE screen of an app design. Output ONLY a JSON object (raw JSON, no prose) of the shape { "components": [...] } — the screen's full component tree, 6-14 components, realistic specific copy (real names, plausible numbers, never lorem ipsum). Each component: { "type", "props", "children"? }. Use ONLY these types: ${await liveTypeList(ctx)}.`,
      `APP: ${str(payload.name, 200) ?? ''} — ${str(payload.description, 500) ?? ''}\nRESEARCH: ${researchJson}\nSCREEN: ${JSON.stringify({ id: scr.id, name: scr.name, route: scr.route })}\nCURRENT COMPONENTS (thin — replace with a richer tree serving the same purpose): ${JSON.stringify(scr.components ?? [])}`,
      { responseSchema: DEEPEN_RESPONSE_SCHEMA },
    );
    const parsed = attempt.data;
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.components) ? parsed.components : null);
    if (!list || !list.length) continue; // soft-fail: keep the original screen
    try {
      payload.screens[i] = { ...scr, components: list.slice(0, 200).map((c) => normalizeComponent(c, 0)) };
      deepened.push(scr.id);
    } catch { /* normalization rejected the AI output — keep the original */ }
  }

  // XCH-APPB-3: the merged doc must stay inside the closed world. The input
  // arrived validated (render gates), so on a bad merge we REVERT the AI
  // enrichments — deepen's existing keep-the-original soft-fail contract —
  // rather than fail the chain on an enhancement step.
  if (deepened.length) {
    const verdict = await surfaceValidate(ctx, payload);
    if (verdict && !verdict.ok) {
      for (const { scr, i } of ranked) payload.screens[i] = scr;
      deepened.length = 0;
    }
  }

  const outputs = {
    artifact: { artifactTypeId: 'canvas.app-builder', payload, title: str(payload.name, 200) ?? 'App design' },
    deepened,
  };
  if (ranked.length && !deepened.length) outputs.warning = 'deepen made no improvements (AI errors or rejected output) — the design is unchanged';
  return { status: 'success', outputs };
}

/**
 * audit (ADR 0325 P3) — DETERMINISTIC semantic quality checks (zero AI). It
 * does NOT re-validate schema/closed-world validity (validateAppDoc owns that);
 * it checks what validators deliberately don't: reachability, emptiness,
 * dangling navigation, duplicate routes, theme contrast. Passes the artifact
 * THROUGH so the review gate's upstream binding still receives the app.
 */
export function audit(ctx) {
  const artifactIn = ctx.inputs?.artifact;
  const upstreamWarning = typeof ctx.inputs?.upstreamWarning === 'string' ? ctx.inputs.upstreamWarning : '';
  const payload = artifactIn && typeof artifactIn === 'object' && artifactIn.payload && typeof artifactIn.payload === 'object'
    ? artifactIn.payload
    : null;
  if (!payload || !Array.isArray(payload.screens)) throw fail('audit requires the app artifact on the `artifact` input');
  const screens = payload.screens;
  const ids = new Set(screens.map((s) => s.id));
  const findings = [];

  // Reachability: BFS from the initial screen over connectors + navigateTo.
  const edges = new Map();
  const addEdge = (from, to) => { if (!edges.has(from)) edges.set(from, new Set()); edges.get(from).add(to); };
  for (const c of Array.isArray(payload.connectors) ? payload.connectors : []) addEdge(c.from, c.to);
  const walkNav = (screenId, list, depth = 0) => {
    if (depth > 25) return;
    for (const n of Array.isArray(list) ? list : []) {
      const to = n?.props?.navigateTo;
      if (typeof to === 'string' && to) {
        addEdge(screenId, to);
        if (!ids.has(to)) findings.push({ code: 'dangling_nav', severity: 'error', screenId, message: `navigateTo '${to}' targets no screen` });
      }
      walkNav(screenId, n?.children, depth + 1);
    }
  };
  for (const s of screens) walkNav(s.id, s.components);

  const initial = screens.find((s) => s.isInitial === true) ?? screens[0];
  if (!screens.some((s) => s.isInitial === true)) {
    findings.push({ code: 'no_initial', severity: 'warning', message: 'no screen is marked initial — the first screen is assumed' });
  }
  const reachable = new Set();
  const queue = initial ? [initial.id] : [];
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of edges.get(id) ?? []) queue.push(next);
  }
  for (const s of screens) {
    if (!reachable.has(s.id)) findings.push({ code: 'unreachable', severity: 'error', screenId: s.id, message: `screen '${s.name ?? s.id}' cannot be reached from the initial screen` });
    if (countNodes(s.components) === 0) findings.push({ code: 'empty_screen', severity: 'warning', screenId: s.id, message: `screen '${s.name ?? s.id}' has no components` });
  }

  // Duplicate routes.
  const seenRoutes = new Map();
  for (const s of screens) {
    if (typeof s.route === 'string' && s.route) {
      if (seenRoutes.has(s.route)) findings.push({ code: 'duplicate_route', severity: 'warning', screenId: s.id, message: `route '${s.route}' is also used by '${seenRoutes.get(s.route)}'` });
      else seenRoutes.set(s.route, s.id);
    }
  }

  // Theme distinguishability: a primary/secondary pair with ~no luminance
  // contrast between them reads as ONE color (accents vanish). NOTE: a
  // "readable in neither black nor white" check is mathematically impossible
  // at 4.5:1 (the thresholds overlap), so we deliberately don't pretend to it.
  const lumOf = (hex) => {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    const chan = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  };
  const lp = lumOf(payload.themeColors?.primary);
  const ls = lumOf(payload.themeColors?.secondary);
  if (lp !== null && ls !== null) {
    const ratio = (Math.max(lp, ls) + 0.05) / (Math.min(lp, ls) + 0.05);
    if (ratio < 1.15) {
      findings.push({ code: 'indistinct_theme', severity: 'warning', message: `themeColors primary and secondary are nearly identical (contrast ${ratio.toFixed(2)}:1) — accents will not read as distinct` });
    }
  }

  // ADR 0325 "loud soft-fail": a skipped deepen pass becomes a FINDING here.
  if (upstreamWarning) findings.push({ code: 'deepen_skipped', severity: 'warning', message: upstreamWarning });

  const penalty = { unreachable: 20, dangling_nav: 15, empty_screen: 10, duplicate_route: 5, indistinct_theme: 10, no_initial: 10, deepen_skipped: 5 };
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + (penalty[f.code] ?? 5), 0));
  const summary = findings.length
    ? `Quality ${score}/100 — ${findings.length} finding${findings.length === 1 ? '' : 's'}: ${findings.slice(0, 3).map((f) => f.message).join('; ')}${findings.length > 3 ? '; …' : ''}`
    : `Quality ${score}/100 — no findings.`;

  // summary lives INSIDE report: the approval gate folds top-level STRING
  // inputs into picker options, and one option suppresses the ApprovalCard's
  // durable-artifact fetch — a string output here corrupts the review card.
  return { status: 'success', outputs: { artifact: artifactIn, report: { score, findings, summary } } };
}

/* ── ADR 0346 4d — the governed repair loop + the typed-capture node ────── */

/** Wrap an upstream value into a typed artifact envelope (config-driven).
 *  The persistence seam (detectTypedArtifact) validates against the registered
 *  schema — a malformed payload falls through untyped, never fails the run. */
export function capture(ctx) {
  const artifactTypeId = str(ctx.config?.artifactTypeId, 120);
  if (!artifactTypeId) throw fail('`artifactTypeId` config is required');
  const title = str(ctx.config?.title, 200) ?? artifactTypeId;
  const value = ctx.inputs?.value;
  if (value === undefined || value === null) return { status: 'success', outputs: {} };
  return { status: 'success', outputs: { artifact: { artifactTypeId, payload: value, title } } };
}

/** Governed repair (AI-06): read the CURRENT design through the feature
 *  surface (tenant-scoped; the version is the CAS basis), apply the repair
 *  instructions with ONE AI call, and re-normalize the candidate through the
 *  SAME render gate (the ADR 0325 lesson — enriched output must survive the
 *  gate or it is dead on the wire). HARD-fails on AI failure: the user asked
 *  for a repair; a silent no-op candidate would be dishonest. */
export async function repair(ctx) {
  ensureCallAI(ctx);
  const surface = ctx.features?.['app-builder'];
  if (!surface || typeof surface.getDesign !== 'function') {
    const e = new Error("this host does not provide ctx.features['app-builder'].getDesign");
    e.code = 'host_capability_missing';
    throw e;
  }
  const canvasId = str(ctx.inputs?.canvasId, 120);
  if (!canvasId) throw fail('`canvasId` is required');
  const instructions = str(ctx.inputs?.instructions, 4000);
  if (!instructions) throw fail('`instructions` is required (what to repair — finding codes or a description)');
  const { app, version } = await surface.getDesign({ canvasId });
  const attempt = await tryAiJson(
    ctx,
    `You are an app architect performing a GOVERNED REPAIR of an existing app design. Output ONLY the FULL corrected app JSON (raw JSON, no prose, no code fences) in the SAME shape as the input — { "name", "description", "theme", "themeColors", "screens": [...], "connectors": [...] } — changing ONLY what the repair instructions require and preserving everything else (ids, routes, positions, content). Use ONLY these component types: ${await liveTypeList(ctx)}.`,
    `CURRENT APP:\n${JSON.stringify(app)}\n\nREPAIR INSTRUCTIONS / FINDINGS:\n${instructions}`,
    { responseSchema: REPAIR_RESPONSE_SCHEMA },
  );
  if (!attempt.data) throw fail(`repair failed: ${attempt.error ?? 'unexpected model output'}`);
  // The SAME normalization gate the design chain uses (render safe-parses,
  // slug-normalizes ids, remaps navigation, strips unknown fields).
  const rendered = await render({ inputs: { app: attempt.data } });
  return { status: 'success', outputs: {
    artifact: rendered.outputs.artifact,
    canvasId,
    baseVersion: version,
  } };
}

/** Apply an APPROVED repair candidate as a new working-copy version — a CAS
 *  write through the feature surface (expectedVersion = the candidate's basis;
 *  a concurrent edit surfaces as the host's typed 409, never a clobber). Runs
 *  only after the review gate approves (the chain's trigger edge). */
export async function applyDesignRepair(ctx) {
  const surface = ctx.features?.['app-builder'];
  if (!surface || typeof surface.applyRepair !== 'function') {
    const e = new Error("this host does not provide ctx.features['app-builder'].applyRepair");
    e.code = 'host_capability_missing';
    throw e;
  }
  const env = ctx.inputs?.artifact;
  const payload = env && typeof env === 'object' ? env.payload : undefined;
  const canvasId = str(ctx.inputs?.canvasId, 120);
  const baseVersion = Number(ctx.inputs?.baseVersion);
  if (!payload || typeof payload !== 'object') throw fail('`artifact` (the approved candidate envelope) is required');
  if (!canvasId) throw fail('`canvasId` is required');
  if (!Number.isInteger(baseVersion) || baseVersion < 1) throw fail('`baseVersion` (the CAS basis) is required');
  const applied = await surface.applyRepair({ canvasId, expectedVersion: baseVersion, app: payload });
  return { status: 'success', outputs: { applied: { canvasId: applied.canvasId, newVersion: applied.newVersion } } };
}

/* ── ADR 0424 — governed deployment (sub-toggle + provider honest-off) ──── */

function ensureDeploySurface(ctx, method) {
  const ab = ctx.features && ctx.features['app-builder'];
  if (!ab || typeof ab[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features['app-builder'].${method} — App Builder deployment (ADR 0424) must be composed`),
      { code: 'host_capability_missing', capability: 'host.sample.app-builder' },
    );
  }
  return ab;
}

export async function deployApp(ctx) {
  const ab = ensureDeploySurface(ctx, 'deployApp');
  const i = ctx.inputs ?? {};
  const out = await ab.deployApp({
    orgId: typeof i.orgId === 'string' ? i.orgId : '',
    service: typeof i.service === 'string' ? i.service : '',
    image: typeof i.image === 'string' ? i.image : '',
    exportHash: typeof i.exportHash === 'string' ? i.exportHash : '',
    envKeys: Array.isArray(i.envKeys) ? i.envKeys : [],
  });
  return { status: 'success', outputs: out };
}

export async function deploymentStatus(ctx) {
  const ab = ensureDeploySurface(ctx, 'deploymentStatus');
  const i = ctx.inputs ?? {};
  const out = await ab.deploymentStatus({ deployKey: typeof i.deployKey === 'string' ? i.deployKey : '' });
  return { status: 'success', outputs: out };
}

nodes['feature.app-builder.nodes.deploy-app'] = deployApp;
nodes['feature.app-builder.nodes.deployment-status'] = deploymentStatus;
