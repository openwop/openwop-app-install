/**
 * feature.slides.nodes — the producer for ADR 0153 Phase 1 slide-deck canvases.
 * The `render` node normalizes a requested deck into the `canvas.slides` shape
 * ({ title?, theme?, slides[] }) and emits the typed `{ artifact }` output envelope
 * (ADR 0055/0083): the host run-output producer persists it with artifactTypeId
 * `canvas.slides` + the deck as the artifact CONTENT (JSON), and the chat workbench's
 * slides renderer (ADR 0153 Phase 0 registry) renders it inline.
 *
 * The content is CONSTRAINED TYPED JSON (the safe model-emits-against-a-schema
 * pattern), never executable code. The host artifact-type registry (ADR 0055) does
 * the authoritative AJV validation before the artifact.created event; this node does
 * lightweight structural normalization + fail-fast checks so a malformed deck never
 * reaches the registry as a silent empty render.
 *
 * Pure-JS, Node-20 stdlib only. No host capability.
 */

const LAYOUTS = new Set(['title', 'title-bullets', 'section', 'quote', 'image', 'blank']);
const THEMES = new Set(['default', 'light', 'dark', 'editorial', 'vibrant']);

function fail(message) {
  return Object.assign(new Error(message), { code: 'validation_error' });
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

/** Normalize one slide to the closed `canvas.slides` slide shape. Unknown layouts
 *  fall back to a sensible default; unknown fields are dropped (closed schema). */
function normalizeSlide(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`slide ${index} is not an object`);
  const layout = LAYOUTS.has(raw.layout) ? raw.layout : (Array.isArray(raw.bullets) && raw.bullets.length ? 'title-bullets' : 'title');
  const out = { layout };
  const title = str(raw.title, 240); if (title) out.title = title;
  const subtitle = str(raw.subtitle, 400); if (subtitle) out.subtitle = subtitle;
  if (Array.isArray(raw.bullets)) {
    const bullets = raw.bullets.map((b) => str(b, 400)).filter(Boolean).slice(0, 12);
    if (bullets.length) out.bullets = bullets;
  }
  const attribution = str(raw.attribution, 200); if (attribution) out.attribution = attribution;
  const imageUrl = str(raw.imageUrl, 2000); if (imageUrl) out.imageUrl = imageUrl;
  const notes = str(raw.notes, 4000); if (notes) out.notes = notes;
  return out;
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  // Accept the whole deck (`deck`), a JSON `source`, or loose `slides`+`title`+`theme`.
  const deckIn = (i.deck && typeof i.deck === 'object') ? i.deck
    : safeParse(i.source) ?? { slides: i.slides, title: i.title, theme: i.theme };

  const slidesIn = Array.isArray(deckIn.slides) ? deckIn.slides : null;
  if (!slidesIn || slidesIn.length === 0) {
    throw fail('`slides` is required — a non-empty array of { layout, title?, bullets?, ... }');
  }
  if (slidesIn.length > 100) throw fail('a deck may have at most 100 slides');

  const payload = { slides: slidesIn.map(normalizeSlide) };
  const title = str(deckIn.title, 200); if (title) payload.title = title;
  if (typeof deckIn.theme === 'string' && THEMES.has(deckIn.theme)) payload.theme = deckIn.theme;

  // Typed-artifact envelope (ADR 0055/0153) — the host producer reads
  // `artifact.{artifactTypeId,payload,title}` and persists a renderable run artifact.
  return {
    status: 'success',
    outputs: {
      slideCount: payload.slides.length,
      artifact: {
        artifactTypeId: 'canvas.slides',
        payload,
        ...(title ? { title } : {}),
      },
    },
  };
}

export const nodes = {
  'feature.slides.nodes.render': render,
};
