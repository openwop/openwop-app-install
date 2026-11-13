/**
 * CMS pages + sections (ADR 0009). Org-scoped, tenant+org IDOR-guarded. Owns
 * page content (typed sections), versions (Phase 3), and slug redirects
 * (Phase 3). Section assets are media-asset TOKENS (ADR 0007), stored as opaque
 * references. Section `html`/`url` are sanitized on write (no stored XSS via
 * page content — the media-review lesson applied to content).
 *
 * @see docs/adr/0009-cms-page-builder.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { registerTenantIndexAdoption } from '../../host/tenantIndexAdoption.js';
import { OpenwopError } from '../../types.js';
import { isValidUploadDate } from '../../host/videoUploadDate.js';
// Same-feature sibling (cms/). Used only inside `deletePage` (call-time), so the
// pageExperiments→cms import cycle stays runtime-safe — never referenced at module init.
import { listExperiments, deleteExperiment, erasePageExperimentSubject, findRunningExperiment } from './pageExperimentsService.js';
import { cleanContent, cleanOpaqueToken, cleanString, cleanTagList, contentUrl, optionalCleanContent, optionalCleanString } from '../../host/boundedStrings.js';
import { uniqueSlug, slugify } from '../../host/slug.js';
import { LOCALE_RE, negotiateLocale, resolveSection } from '../../host/i18n/index.js';
import { registerFieldKindValidator } from '../../host/customFields/index.js';
// ADR 0408 Phase C — the CMS façade composes the CONTENT KERNEL (the entities
// engine) for page storage. A DECLARED one-directional feature dependency
// (cms → entities): the kernel is the app's single content store and never
// imports cms back (guard-tested in cms-kernel-pages.test.ts).
import { listAllSystemRowsBounded, mintSystemType } from '../entities/entitiesService.js';
import { makeKernelAdapter } from '../entities/kernelAdapter.js';
import { clearUsageForRef, syncUsageRefs } from '../media/mediaService.js';
// ADR 0592 §4 (CMSLWF-1) — CMS lifecycle events ride the ADR 0208 dispatcher
// (`emitHostEvent`), NOT `deliverHostExtEvent` directly: the dispatcher's
// webhook leg rides the same delivery seam (delivery stays single), and its
// binding-match + startWorkflowRun leg is what makes an operator's
// "on host.cms.page.published → start my workflow" binding actually fire.
// CMS was the ONLY feature emitting around the dispatcher (class enumerated
// 2026-08-20: every other emitter already calls emitHostEvent).
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
// ADR 0593 D2 — the pending-review cascade. Direction is feature → core (core
// never imports back), the same edge `contentApproval.ts` already uses.
import { deleteResolvedContentApprovalsForPage, rejectPendingApprovalForPage } from '../../host/approvalService.js';
import { fireCmsPageLifecycle, type CmsContentCollection } from '../../host/cmsPageLifecycle.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import type { SubjectEraseReport } from '../../host/subjectErasure.js';
import { eraseContentLanguageSettingsSubject } from '../../host/contentLocales.js';
import { createLogger } from '../../observability/logger.js';
import { isFragmentHref, isInternalHref } from '../../host/internalHref.js';
import { cleanAllHeroArt, ITEM_BASE_KEYS } from './heroArt.js';
import { alignSimOverlay, assertSimSectionBytes, buildDesignSectionData, cleanHeroQueue, cleanRichTextCard, DESIGN_SECTION_TYPES, SECTION_ITEM_BASE_KEYS, VIDEO_LENGTH_RE, type DesignSectionType } from './designSections.js';
export { VIDEO_LENGTH_RE };

const log = createLogger('feature.cms');

const MAX = {
  title: 160,
  tag: 40,
  tags: 12,
  heading: 200,
  text: 5000,
  markdown: 20_000, // richText body (plain text / markdown, not HTML)
  url: 2048,
  label: 120,
  alt: 200,
  token: 256,
  eyebrow: 80,    // mono overline above a section heading (ADR 0027 front page)
  caption: 240,
  lede: 280,      // one-line orienting blurb under a section heading (ADR 0027)
  slugChars: 64,  // ADR 0748 — `slugify`'s own cap, stated so the protocol 400 can name it
  slug: 40,       // a short opaque token, e.g. a card `icon` slug (ADR 0027)
  sections: 50,
  columns: 16, // ADR 1080 D11 — was 12
  compareCols: 8,   // named products/families a `comparison` matrix may span (ADR 0485)
  compareRows: 24,  // capability rows a `comparison` matrix may hold (ADR 0485)
  faqItems: 20,     // Q/A pairs a `faq` section may hold (UX_UPGRADE-site R2-G10)
  quoteItems: 12,   // testimonials a `quotes` section may hold (R2-G10)
  answer: 2000,     // one FAQ answer (plain text, richText model)
  quote: 600,       // one testimonial quote (plain text)
  cell: 80,         // one comparison cell — a short authored status token, e.g. "✓" / "Leaders only" (ADR 0485)
  fieldKeys: 40,    // named fields a `fields` section may hold (ADR 0748)
  videoDescription: 1000, // a `video` section's screen-reader description + VideoObject description (ADR 0843)
  // ADR 0920 — section styles. Every string is bounded like its neighbours.
  heroNote: 200,    // fine print under the hero CTAs (D3)
  sectionNote: 280, // a footnote under a `columns` grid (D4)
  badge: 40,        // a short card badge (D4)
  itemMeta: 80,     // a `list` row's right-aligned meta, e.g. "12 min" (D4); also a bento inset card's detail line (ADR 1032)
  listItems: 8,     // rows a `list`-layout card may hold (D4)
  toggles: 6,       // ADR 1032 — switches a `rows` section's try-it panel may hold
  diagramNodes: 8,  // ADR 1068 D2 — boxes a `rows` section's workflow diagram may hold
  planText: 80,     // every hero `plan` string except `lines[].text` (D3)
  planLine: 160,    // one hero `plan` line's text (D3)
  planLines: 3,
  planChips: 5,
  activityItems: 6,   // rows an activity card may hold (ADR 1029 D5)
  activityText: 80,   // an activity card's title, a row's actor and meta (ADR 1029 D5)
  activityAction: 160, // one activity row's action text (ADR 1029 D5)
  chatText: 120,    // every `chat` string except a message body (D5)
  chatMessage: 400, // one `chat` message's text (D5)
  chatMessages: 6,
  // ADR 1047 — the `features` card layout and the hero `hub` picture.
  featureTags: 6,       // labelled status pills one feature card may hold
  featureTag: 60,       // one pill's label
  featureMore: 2000,    // a card's "How you use it" disclosure body (markdown)
  hubSpokes: 8,         // places around the hub's centre
  hubText: 40,          // the centre label/eyebrow and each spoke's label
  hubIndex: 8,          // a spoke's short index, e.g. "01"
  flowNodes: 6,         // nodes in a flow (ADR 1038 D8): six fit one row at desktop width
  flowLabel: 40,        // a node's label and status word
  flowText: 120,        // a node's line of text
  flowCaption: 80,      // the hero flow's accessible caption
  perOrgPages: 2000,
  // ADR 1069 D4 — authored `pricing.plans` (named plans, no prices).
  plans: 8,         // plans one pricing section may name
  planName: 80,     // a plan's name, e.g. "Pilot"
  planBlurb: 600,   // a plan's one-paragraph description
} as const;

/** Section layout for `columns` — how the public renderer lays the items out. */
const COLUMN_LAYOUTS = ['cards', 'steps', 'stats', 'showcase', 'rows', 'prompts', 'dives', 'ruled', 'progress', 'list', 'tiles', 'panels', 'timeline', 'bento', 'marquee', 'features', 'flow', 'incidents', 'board', 'gallery'] as const; // ADR 1063 D3 — incidents; P2d — board; P2e — gallery
/** Optional hero art direction. Absent preserves the original workflow motif. */
const HERO_VISUALS = ['workflow', 'journey', 'run', 'film', 'image', 'none', 'plan', 'activity', 'hub', 'flow', 'receipt', 'apps', 'versus', 'fanout', 'phone', 'wall', 'tally', 'log', 'queue'] as const; // ADR 1080 D7 — queue
/** ADR 1047 — a feature card pill's state. Presentation of authored text: the
 *  pill's `label` is the words; the state's legend words render beside it. */
const FEATURE_TAG_STATES = ['now', 'soon'] as const;
/** ADR 1029 D5 — the styling state of an activity row. Presentation only: the
 *  row's `status` is authored text, so it localizes and reaches crawlers. */
const ACTIVITY_STATES = ['done', 'waiting', 'approved', 'flagged'] as const;
/** ADR 1067 D3 — an activity card's look. Absent = the approval list (ADR 1029 D5). */
const ACTIVITY_STYLES = ['checklist'] as const;
/** ADR 1038 D8 — a flow node's styling state. The words are the node's own
 *  `status`; the state only picks the mark's shape and colour. */
const FLOW_STATES = ['idle', 'done', 'waiting'] as const;
/** ADR 0920 D1 — a full-bleed section band, painted from tokens only. */
const SECTION_TONES = ['default', 'muted', 'inverse', 'accent'] as const;
/** ADR 0920 D2 — heading left / lede right on wide screens. */
const SECTION_HEADS = ['stacked', 'split'] as const;
/** ADR 1068 D3 — a section head's size: `sm` is the 44px clamp (absent: the default). */
const SECTION_HEAD_SIZES = ['sm'] as const;
/** ADR 0920 D3 — an icon on the hero's second CTA. */
const HERO_CTA_ICONS = ['play'] as const;
/** ADR 1066 D1 — where a hero's picture sits. Absent = beside the copy (the
 *  grid); `below` = after the copy, the full width of the shell. */
// ADR 1080 D6 — `band`, `card` and `panel` place a photo hero's picture.
const HERO_PLACEMENTS = ['below', 'band', 'card', 'panel'] as const;
/** ADR 1072 D2 — a gallery's arrangement. Absent = the even grid. */
const GALLERY_LAYOUTS = ['lead'] as const;
/** ADR 1073 D2 — where a timeline's head and picture sit. Absent = head on top, picture beside the rail. */
const TIMELINE_SHOT_SIDES = ['start'] as const;
/** ADR 1073 D3 — a timeline's rail markers. Absent = dots. */
const TIMELINE_MARKERS = ['badge'] as const;
/** ADR 1069 D2 — how a columns footnote is drawn. Absent = a quiet line under the grid. */
const COLUMN_NOTE_STYLES = ['callout'] as const;
/** ADR 1063 P2c + ADR 1070 D1 — a column item's own tone: a dark tile or a muted one. */
const COLUMN_ITEM_TONES = ['inverse', 'mist'] as const;
/** ADR 1070 D3 — where a bento tile's picture sits. Absent = at its foot. */
const COLUMN_IMAGE_POSITIONS = ['top'] as const;
/** ADR 1029 D2 — how a section moves as it scrolls into view. Absent keeps the
 *  page-load rise; `none` opts out of all motion. Presentation, not content: kept
 *  on the base layer only, and never on `fields` (the protocol's open body). */
/** ADR 1038 D6 adds `slide-start`, `slide-end` (from the reading start or end) and `zoom`. */
export const SECTION_MOTIONS = ['none', 'reveal', 'stagger', 'rise', 'slide-start', 'slide-end', 'zoom'] as const;
/** ADR 1038 D1 — whether the hero's card plays once on load. Presentation, like
 *  `motion`: base layer only, so an overlay (which replaces `activity` whole,
 *  RFC 0103 §C) can never drop or change it, and it never moves a digest. */
export const HERO_PLAYS = ['still', 'once'] as const;
/** ADR 1038 D2 — how the hero heading's `*emphasized*` words are marked: the
 *  clay accent (absent, today's look), or a line or wash drawn once on load.
 *  Presentation: base layer only, like `motion` and `play`. */
export const HERO_EMPHASES = ['accent', 'strike', 'underline', 'highlight'] as const;

/**
 * Build a section's cleaned field set (see `buildTypedSectionData`), plus the
 * ADR 1029 `motion`, ADR 1038 hero `play`/`emphasis` and stats `count` presentation fields on the base layer. Here rather than in
 * `validateSection` so every lane that builds base data (pages, shared sections)
 * keeps it; a locale overlay never carries it, so the base value stands.
 */
function buildSectionData(type: SectionType, d: Record<string, unknown>, partial: boolean, stored = false): Record<string, unknown> {
  const data = buildTypedSectionData(type, d, partial, stored);
  if (partial || type === 'fields') return data;
  const motion = pickEnum(SECTION_MOTIONS, d.motion);
  // Only the activity card plays today; a leftover `play` on another visual would be
  // invisible in the editor and start playing again on a switch back, so it is dropped.
  const play = type === 'hero' && data.visual === 'activity' ? pickEnum(HERO_PLAYS, d.play) : undefined;
  const emphasis = type === 'hero' ? pickEnum(HERO_EMPHASES, d.emphasis) : undefined;
  // ADR 1038 D3 — a stats band's figures count up as they arrive. Only the stats
  // layout has figures, so a leftover flag on another layout is dropped.
  const count = type === 'columns' && data.layout === 'stats' && d.count === true ? true : undefined;
  return defined({ ...data, motion, play, emphasis, count });
}
/** ADR 0920 D4 — a small drawing in place of a card icon (`panels`). */
const COLUMN_ART = ['full-week', 'feed', 'solo'] as const;
/** ADR 0920 D4 — `steps` numeral style. */
const STEP_NUMBERS = ['circle'] as const;
/** ADR 1032 — an `image` section's frame: a plain figure, or browser chrome (a
 *  window bar with an address label) around a product screenshot. */
const IMAGE_FRAMES = ['browser'] as const;
/** ADR 0920 D5 — a `richText` picture beside the copy. */
const RICH_TEXT_VISUALS = ['chat', 'image', 'card'] as const; // ADR 1080 D8 — card
/** ADR 1080 D5 — which side of the copy a richText picture sits on. */
const RICH_TEXT_SIDES = ['start'] as const;
const CHAT_FROM = ['person', 'guide'] as const;
/** ADR 0920 D6 — `cta` alignment. */
const CTA_ALIGNS = ['center', 'start', 'split'] as const; // ADR 1062 D4 — `split`: copy at the start, button at the end (stacks when narrow)

/** A value from a CLOSED set, or undefined — an unknown value is DROPPED, never
 *  thrown (ADR 0920: presentation options degrade to the stock look). */
function pickEnum<T extends string>(set: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** A 0..1 fraction (progress bars), clamped; non-numbers and non-finite values dropped. */
function unitFraction(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
}

/** A plain object or undefined (arrays and scalars are not a nested field object). */
function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Copy only the defined entries — keeps the "absent ⇒ no key" shape of every builder. */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * ADR 0920 D3 — the hero's example plan card. CLOSED: only the named fields
 * survive; every string is scrubbed and capped (80, `lines[].text` 160);
 * `progress` is a clamped 0..1 fraction; `lines` ≤ 3 and `chips` ≤ 5, empty
 * entries filtered. Undefined when nothing survives (so the key is omitted).
 * A per-locale overlay replaces the object whole (shallow `resolveSection`).
 */
function cleanHeroPlan(v: unknown): Record<string, unknown> | undefined {
  const p = asObject(v);
  if (!p) return undefined;
  const t = (x: unknown): string | undefined => optionalCleanContent(x, MAX.planText, 'plan');
  const lines = (Array.isArray(p.lines) ? p.lines : []).slice(0, MAX.planLines).map((l) => {
    const ll = asObject(l) ?? {};
    return defined({ label: t(ll.label), text: optionalCleanContent(ll.text, MAX.planLine, 'text') });
  }).filter((l) => l.text !== undefined || l.label !== undefined);
  const chips = (Array.isArray(p.chips) ? p.chips : []).slice(0, MAX.planChips)
    .map((c) => (typeof c === 'string' ? cleanContent(c, MAX.planText, 'chips') : ''))
    .filter((c) => c.length > 0);
  const out = defined({
    eyebrow: t(p.eyebrow),
    title: t(p.title),
    meta: t(p.meta),
    progress: unitFraction(p.progress),
    progressNote: t(p.progressNote),
    stepEyebrow: t(p.stepEyebrow),
    stepTitle: t(p.stepTitle),
    lines: lines.length > 0 ? lines : undefined,
    action: t(p.action),
    chips: chips.length > 0 ? chips : undefined,
    note: t(p.note),
    initial: t(p.initial),
    bubble: t(p.bubble),
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR 1029 D5 — the hero's activity (approval) card. CLOSED: `title` ≤ 80; up to
 * six `items`, each an `actor` (≤ 80) and an `action` (≤ 160), with an optional
 * `meta` and `status` (≤ 80, authored text) and a closed styling `state`. A row
 * with no action is dropped. Inert text only: no links. Undefined when no row
 * survives. ADR 1038 D1 adds a `result` line (≤ 80) that lands last when the
 * hero plays its card (the hero-level `play`, base layer only).
 */
function cleanActivity(v: unknown): Record<string, unknown> | undefined {
  const a = asObject(v);
  if (!a) return undefined;
  const t = (x: unknown): string | undefined => optionalCleanContent(x, MAX.activityText, 'activity');
  const items = (Array.isArray(a.items) ? a.items : []).slice(0, MAX.activityItems).map((i) => {
    const ii = asObject(i) ?? {};
    return defined({
      actor: t(ii.actor),
      action: optionalCleanContent(ii.action, MAX.activityAction, 'action'),
      meta: t(ii.meta),
      status: t(ii.status),
      state: pickEnum(ACTIVITY_STATES, ii.state),
      // ADR 1067 D3 — a row's icon slug (the column icon set; unknown slugs draw no glyph).
      icon: optionalCleanString(ii.icon, MAX.slug),
    });
  }).filter((i) => i.action !== undefined);
  if (items.length === 0) return undefined;
  // ADR 1067 D3 — the checklist look, and the words in its browser bar.
  return defined({ title: t(a.title), items, result: t(a.result), style: pickEnum(ACTIVITY_STYLES, a.style), barLabel: t(a.barLabel) });
}

/**
 * ADR 1047 — the hero's hub picture: one centre and the places around it.
 * CLOSED: `center.label` (required, ≤ 40), an optional `center.eyebrow` (≤ 40)
 * and an optional centre picture (`center.imageToken`, an opaque media
 * reference, which always carries its `alt`, like ADR 1037); 2–8 `spokes`, each
 * a `label` (≤ 40), an optional `index` (≤ 8) and an optional `icon` slug (the
 * column icon set; unknown slugs render no glyph). A spoke with no label is
 * dropped. Inert text only. Undefined unless a centre label and at least two
 * spokes survive. Distinct from ADR-1038 D8 `flow` (a directed graph with a
 * gate): a hub is strictly radial, one centre, no edges between places.
 */
function cleanHub(v: unknown): Record<string, unknown> | undefined {
  const h = asObject(v);
  if (!h) return undefined;
  const t = (x: unknown): string | undefined => optionalCleanContent(x, MAX.hubText, 'hub');
  const c = asObject(h.center) ?? {};
  const label = t(c.label);
  const imageToken = cleanOpaqueToken(c.imageToken, MAX.token) || undefined;
  const alt = optionalCleanContent(c.alt, MAX.alt, 'alt');
  if (imageToken && !alt) {
    throw new OpenwopError('validation_error', 'hub.center.alt is required when hub.center.imageToken is set.', 400, {});
  }
  const spokes = (Array.isArray(h.spokes) ? h.spokes : []).slice(0, MAX.hubSpokes).map((sp) => {
    const ss = asObject(sp) ?? {};
    return defined({ label: t(ss.label), index: optionalCleanContent(ss.index, MAX.hubIndex, 'index'), icon: optionalCleanString(ss.icon, MAX.slug) });
  }).filter((sp) => sp.label !== undefined);
  if (!label || spokes.length < 2) return undefined;
  return { center: defined({ eyebrow: t(c.eyebrow), label, ...(imageToken ? { imageToken, alt } : {}) }), spokes };
}

/**
 * ADR 1038 D8 — the hero's flow picture: a short process, in order. CLOSED: an
 * optional `label` (≤ 80, the figure's caption); up to six `nodes`, each a
 * `label` (≤ 40), an optional `text` (≤ 120) and `status` word (≤ 40, the
 * author's own, so the state is never colour alone) and a closed styling
 * `state`. Inert text only. Undefined when there are no nodes; it shows only
 * with two labelled nodes.
 * Content, like the activity card: an overlay replaces it whole (RFC 0103 §C).
 */
function cleanFlow(v: unknown): Record<string, unknown> | undefined {
  const f = asObject(v);
  if (!f) return undefined;
  // A node with no label is KEPT (as an empty label), so a step being written
  // survives the editor's autosave round trip; renderers show only labelled
  // nodes, and only when two are labelled.
  const nodes = (Array.isArray(f.nodes) ? f.nodes : []).slice(0, MAX.flowNodes).map((n) => {
    const nn = asObject(n) ?? {};
    return defined({
      label: optionalCleanContent(nn.label, MAX.flowLabel, 'label') ?? '',
      text: optionalCleanContent(nn.text, MAX.flowText, 'text'),
      status: optionalCleanContent(nn.status, MAX.flowLabel, 'status'),
      state: pickEnum(FLOW_STATES, nn.state),
    });
  });
  if (nodes.length === 0) return undefined;
  // ADR 1064 P3c — a numbered rail, and marks that light in turn (a loop with
  // a pause control). Only `true` is kept.
  return defined({ label: optionalCleanContent(f.label, MAX.flowCaption, 'label'), nodes, numbered: f.numbered === true ? true : undefined, run: f.run === true ? true : undefined });
}

/**
 * ADR 0920 D5 — a `richText` conversation picture. CLOSED: `title`, `subtitle`,
 * `badge`, `placeholder` and every `proposal` string ≤ 120; each
 * `messages[].text` ≤ 400; `messages` ≤ 6, each needs a known `from`
 * (`person` | `guide`) AND text, or it is dropped. Undefined when nothing survives.
 */
function cleanChat(v: unknown): Record<string, unknown> | undefined {
  const c = asObject(v);
  if (!c) return undefined;
  const t = (x: unknown): string | undefined => optionalCleanContent(x, MAX.chatText, 'chat');
  const messages = (Array.isArray(c.messages) ? c.messages : []).slice(0, MAX.chatMessages).map((m) => {
    const mm = asObject(m) ?? {};
    return { from: pickEnum(CHAT_FROM, mm.from), text: typeof mm.text === 'string' ? cleanContent(mm.text, MAX.chatMessage, 'text') : '' };
  }).filter((m): m is { from: typeof CHAT_FROM[number]; text: string } => m.from !== undefined && m.text.length > 0);
  const pr = asObject(c.proposal);
  const proposal = pr
    ? defined({ label: t(pr.label), text: t(pr.text), accept: t(pr.accept), decline: t(pr.decline) })
    : undefined;
  const out = defined({
    title: t(c.title),
    subtitle: t(c.subtitle),
    badge: t(c.badge),
    messages: messages.length > 0 ? messages : undefined,
    proposal: proposal && Object.keys(proposal).length > 0 ? proposal : undefined,
    placeholder: t(c.placeholder),
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export const PAGE_STATUSES: PageStatus[] = ['draft', 'in_review', 'published', 'archived'];

export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns' | 'productGrid' | 'form' | 'pricing' | 'entityList' | 'entityDetail' | 'comparison' | 'faq' | 'quotes' | 'fields' | 'video' | DesignSectionType;
// ADR 1080 — statusTable, dateCalc, conversation and featureIndex (features/cms/designSections.ts).
export const SECTION_TYPES: SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns', 'productGrid', 'form', 'pricing', 'entityList', 'entityDetail', 'comparison', 'faq', 'quotes', 'fields', 'video', ...DESIGN_SECTION_TYPES];

/** ADR 0748 — a `fields` section's key grammar and ceiling (the protocol's open
 *  section body, held as flat named text fields). */
export const FIELDS_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** ADR 0391 (b) — the closed set of plan tiers a `pricing` section may name (a
 *  subset of the billing `PlanTier` catalog; the section carries only WHICH
 *  tiers to show — never prices, which the client reads live from billing). */
const PRICING_TIER_IDS = ['free', 'pro', 'team', 'enterprise'] as const;

export interface Section {
  sectionId: string;
  type: SectionType;
  /** Base/default-locale fields. */
  data: Record<string, unknown>;
  /**
   * Sparse per-locale field overrides (RFC 0103 / ADR 0064). Keys are BCP-47
   * tags (RFC 0206 grammar — `host/i18n/locale.ts` LOCALE_RE), never the base locale; each value is a
   * partial overlay of `data`, sanitized identically to `data`. Optional +
   * backward-compatible: a section without it deserializes unchanged.
   */
  localizations?: Record<string, Record<string, unknown>>;
  /**
   * Shared-section reference (ADR 0204 C4, inherit-only v1): when set, this
   * section renders the SHARED section's content at delivery time; its own
   * `data`/`localizations` are ignored (kept empty). Detach = copy the shared
   * content into `data` and drop the ref (an editor action, not a state).
   */
  ref?: { sharedSectionId: string };
  /**
   * ADR 0592 §3 (CMSL-10/CMSLU-4/CMSLWF-8) — durable AI-authorship provenance:
   * locale → ISO instant the overlay was MACHINE-drafted (the submit-time
   * auto-translate sweep, the editor's translate-from-base, or a run/agent
   * `updateSectionDraft`). Absent key = human-authored (or pre-fix row — NO
   * backfill; absence makes no claim). Cleared when a human edits the overlay.
   * ADVISORY metadata for reviewers/audit, not a security boundary — the
   * mandatory human gate remains the control; a stamp entry is kept only while
   * the overlay it describes exists (validate drops orphaned keys).
   */
  aiDrafted?: Record<string, string>;
  /**
   * ADR 0861 D6 (CMSL2WF-6) — translation status: locale → a 16-hex digest of the
   * BASE values at the keys that locale's overlay overrides, taken when the overlay
   * was last written or confirmed. Base text moved since ⇒ `outdated`. SERVER-OWNED:
   * `stampSourceDigests` recomputes it from the stored row on every write, so a
   * client value is never trusted; validation only cleans the shape (the kernel
   * re-validates every write and would otherwise strip it). Absent key = no claim
   * (`unknown` — legacy overlays are never backfilled). Never on a delivery shape.
   */
  sourceDigest?: Record<string, string>;
}

/** ADR 0950: content pointer and phase move in the same primary-row CAS.
 * The immutable baseline lives in the existing page-version owner. */
export interface PagePromotionReceipt {
  winnerRef: string | null;
  baselineRef: string | null;
  restoreRef: string;
  baselinePublished: boolean;
  ownedVersion: number;
  ownedStatus: PageStatus;
  phase: 'prepared' | 'restored' | 'submitted' | 'finalized' | 'rolling_back' | 'rollback_restored' | 'rollback_submitted' | 'rolled_back' | 'superseded';
  pendingApproval?: boolean;
}
export interface PagePromotionGuard {
  experimentId: string;
  from: PagePromotionReceipt['phase'];
  to: PagePromotionReceipt['phase'];
  pendingApproval?: boolean;
}

export interface Page {
  pageId: string;
  tenantId: string;
  orgId: string;
  promotionReceipts?: Record<string, PagePromotionReceipt>;
  title: string;
  slug: string;
  status: PageStatus;
  sections: Section[];
  /** Editor-facing labels for list filtering (ADR 0206 / gap-analysis B3) —
   *  cleaned via the shared tag cleaner (media-asset precedent), capped. */
  tags?: string[];
  /** ADR 0391 (a) — post-type discriminator. Absent ⇒ an ordinary `page`
   *  (backward compatible, the ADR 0383 additive-KV pattern). `'post'` makes
   *  the page a blog post: it appears in the public blog list + blog feed. */
  kind?: 'page' | 'post';
  /** ADR 0391 (a) — byline principal (a user id resolved to a profile display
   *  name at read time; falls back to `createdBy`). Posts only; never a
   *  freeform author string (profiles stay the one owner of display names).
   *
   *  SOFT REF, deliberately NOT existence-checked at write (P0PUB-1): CMS does
   *  not reach into the identity directory to validate a user id — the same
   *  posture as the never-validated `createdBy`. It is display-only and resolves
   *  best-effort through the TENANT-SCOPED `subjectDisplay` seam, which degrades
   *  an unknown or foreign-tenant principal to a humanized id (a cross-tenant id
   *  cannot resolve to another tenant's name — no leak). The value is still
   *  bounded + sanitized as an opaque token by `cleanPostFacets`. A hard check
   *  would couple cms→user-directory for a cosmetic byline; not worth it. */
  authorId?: string;
  /** ADR 0391 (a) — the single primary section (slugified), powering the
   *  `/blog/category/:cat` archive. Distinct from the many cross-cutting tags. */
  category?: string;
  /** One-shot scheduled publish time (ISO, ADR 0204 C2) — set only while the
   *  page is draft/in_review and the approval gate is OFF; cleared on publish
   *  or cancel. The publish sweep fires it. */
  scheduledPublishAt?: string;
  /** ADR 0836 D3 — the page `version` the scheduled publish was set against. The
   *  sweep publishes only that version; any other content cancels the schedule.
   *  Absent on a schedule set before ADR 0836 (fires unpinned, logged). */
  scheduledPublishVersion?: number;
  /** One-shot scheduled UNPUBLISH time (ISO, ADR 0204 C2b — the embargo-end
   *  half of the Contentful/Sanity publish-at/unpublish-at pair). Set while
   *  published, or alongside a pending publish schedule (then it must be
   *  later). Cleared when the page leaves `published` (manual unpublish /
   *  archive) or on cancel. The sweep's unpublish lane fires it. */
  scheduledUnpublishAt?: string;
  /**
   * Per-locale publish state (ADR 0205 D2). ONLY non-base locales appear; an
   * ABSENT key means published-with-the-page (backward compatible — existing
   * pages behave exactly as before). A `'draft'` locale is withheld from
   * delivery: its overlay is skipped and negotiation falls through the
   * existing RFC 0103 chain (already-normative fallback — no wire change).
   */
  localePublishState?: Record<string, 'draft' | 'published'>;
  /**
   * Content collection discriminator (ADR 0392). Absent = a regular marketing/
   * site page (the default, backward-compatible). `'docs'` marks a reference-docs
   * page: authored + published through the SAME editorial state machine, served
   * publicly, but EXCLUDED from the marketing sitemap/RSS/nav and instead
   * enumerated by the docs feature's own nav tree. An additive blob field — no
   * migration (the DurableCollection<Page> KV store tolerates it).
   */
  collection?: CmsContentCollection;
  /** Ordering key within the docs nav tree (ADR 0392); a slash path allows
   *  grouping later (`getting-started/10`). Only meaningful when collection='docs'. */
  docsNav?: string;
  /** ADR 1049 — where this page sits in the PUBLIC SITE navigation (the public
   *  shell's menu + footer). Absent = today's ADR 0486 placement (curated
   *  Product slugs, every other page under Pages). Base-locale display text,
   *  like `title` in the nav list. Validated by {@link cleanSiteNav}. */
  siteNav?: PageSiteNav;
  version: number;
  publishedVersion?: number;
  /** ADR 0859 D2 — which submission this is: bumped ONLY by `submit` from `draft`,
   *  the one edge the page CAS serialises, so two racing submits agree on it and
   *  the review row's id derived from it is the same for both. Absent until the
   *  first submit after ADR 0859 (a legacy in_review page keeps the scan path). */
  reviewCycle?: number;
  /** ADR 0391 (a) — the timestamp of the LAST publish transition (approve /
   *  publish). Additive-KV: ABSENT on legacy rows + never-published pages, so
   *  public-surface ordering falls back to `updatedAt` (`publishedAt ?? updatedAt`).
   *  Stamped ONLY on the status→published transition, so editing a published
   *  page (an `updatePage` that bumps `updatedAt`) does NOT re-float the post in
   *  the blog list or reset its RSS `<pubDate>`. */
  publishedAt?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADR 0408 Phase C — pages live in the CONTENT KERNEL (the entities engine).
 * `cms.page` is a system-reserved entity type; this adapter is the façade's
 * page store (id-preserving: pageId = entityId, so versions/redirects/
 * experiments keep their keys). Mapping:
 *   - queryable scalars → kernel `values` (orgId/title/slug/workflowStatus/
 *     kind/authorUserId) — the convergence payoff: entityList/query see pages;
 *   - sections → `ext.blocks` (validated by the registered `blocks` kind —
 *     the SAME validateSections sanitizer, second line of defense);
 *   - the remaining Page fields → `ext.page` (façade-owned domain metadata,
 *     stored blind by the kernel; the façade owns page semantics).
 * Kernel entry `status` derives from the workflow status (published ⇒ live),
 * so every kernel consumer sees pages through the same publish gate as any
 * other type. The LEGACY `cms:page` collection remains declared read-dark for
 * one release (the migration's rollback window) — nothing reads it here.
 */
const legacyPages = new DurableCollection<Page>('cms:page', (p) => p.pageId);
export const CMS_PAGE_TYPE = 'cms.page';

// Kernel field keys are seam-normalized (lowercase + underscores) — the
// snake_case here IS the queryable vocabulary (entityList/query over pages).
const PAGE_TYPE_FIELDS = [
  { key: 'org_id', label: 'Org', type: 'string', required: true },
  { key: 'title', label: 'Title', type: 'string', required: true },
  { key: 'slug', label: 'Slug', type: 'string', required: true },
  { key: 'workflow_status', label: 'Workflow status', type: 'enum', required: true, options: ['draft', 'in_review', 'published', 'archived'] },
  { key: 'kind', label: 'Kind', type: 'enum', required: false, options: ['page', 'post'] },
  { key: 'author_user_id', label: 'Author', type: 'string', required: false },
  { key: 'blocks', label: 'Blocks', type: 'blocks', required: false },
];

// ADR 0408 D2 — cms registers the `blocks` extension kind INTO the core
// field-kind registry at MODULE SCOPE (features register into core, never the
// reverse; module scope so the kernel page store has it wherever cmsService
// loads — bare-harness tests and the boot migration included). validate = the
// SAME validateSections sanitizer the routes use (the kernel's second line of
// defense on system-row writes; baseLocale '' keeps this a STRUCTURE check —
// org-aware locale semantics are the façade's first-line validation).
// ADR 0861 D1 (review L1) — no `resolveLocale`: the one it had was never called
// and resolved overlays WITHOUT the page's withheld set, a second delivery
// resolver waiting for a caller. Delivery is `localizePage`, only.
registerFieldKindValidator('blocks', {
  validate: (value) => validateSections(value, ''),
});

async function ensurePageType(tenantId: string): Promise<void> {
  // No process-level memo: storage can reset under a live process (test
  // harnesses); the mint is idempotent and one point-read when present.
  await mintSystemType({
    tenantId,
    name: CMS_PAGE_TYPE,
    displayName: 'Page',
    description: 'CMS pages (system type — managed by the CMS façade; ADR 0408).',
    fields: PAGE_TYPE_FIELDS,
    extensionKinds: ['blocks'],
    actor: 'system:cms',
  });
}

/** Page → kernel row (lossless: everything non-scalar rides ext.page). */
function pageToKernel(page: Page): { values: Record<string, unknown>; ext: Record<string, unknown>; status?: 'draft' } {
  const { sections, ...rest } = page;
  return {
    values: {
      org_id: page.orgId,
      title: page.title,
      slug: page.slug,
      workflow_status: page.status,
      ...(page.kind !== undefined ? { kind: page.kind } : {}),
      ...(page.authorId !== undefined ? { author_user_id: page.authorId } : {}),
    },
    ext: { blocks: sections, page: rest },
    ...(page.status === 'published' ? {} : { status: 'draft' as const }),
  };
}

/** Kernel row → Page (ext.page is the domain truth; blocks reattach). */
function kernelToPage(rec: { ext?: Record<string, unknown> }): Page {
  const base = (rec.ext?.page ?? {}) as Omit<Page, 'sections'>;
  const sections = (rec.ext?.blocks ?? []) as Section[];
  return { ...base, sections } as Page;
}

/** ADR 1104 — every tenant's pages (at most `perTenantCap` each), for the daily
 *  integrity gauge ONLY; never a request path. */
export async function listAllPagesForIntegrityGauge(perTenantCap: number): Promise<{ pages: Page[]; truncatedTenants: number }> {
  const { rows, truncatedTenants } = await listAllSystemRowsBounded(CMS_PAGE_TYPE, perTenantCap);
  return { pages: rows.map((rec) => kernelToPage(rec)), truncatedTenants };
}

/** ADR 1038 D8 — the most steps a flow holds (the validator's cap, for the gauge). */
export const FLOW_MAX_NODES: number = MAX.flowNodes;

/** The kernel-backed page store (KERNEL-5 shared factory). `toKernel` forwards
 *  a concrete `status` ('draft' when the page isn't published, else 'live') —
 *  reproducing the previous `mapped.status ?? 'live'` default. Top-level
 *  `orgId` is stamped so the RI-7 org-delete guard (`jsonOrgId`, which probes
 *  the TOP-LEVEL `orgId`) sees the row — parity with crm.company / crm.deal /
 *  commerce.product. `cas` comes along as a capability (unused by cms today). */
const pages = makeKernelAdapter<Page>({
  typeName: CMS_PAGE_TYPE,
  ensureType: ensurePageType,
  toKernel: (page) => {
    const mapped = pageToKernel(page);
    return { values: mapped.values, ext: mapped.ext, status: mapped.status ?? 'live' };
  },
  fromKernel: (rec) => kernelToPage(rec),
  idOf: (p) => p.pageId,
  tenantOf: (p) => p.tenantId,
  orgOf: (p) => p.orgId,
  actorOf: (p) => p.updatedBy,
  updatedAtOf: (p) => p.updatedAt,
  legacy: legacyPages,
});

/**
 * ADR 0836 D1 — the ONE page write that honours a precondition. `expected` is the
 * row this write was decided on (every authority, gate and version check ran
 * against it); the swap lands only if storage still holds exactly that row. Before
 * this, every lane did read → check → `pages.put`, and `put` retries against
 * whatever it re-reads, so a check ran on one row and the write landed on another.
 * A miss is a typed 409 (or a 404 when the row is gone) — the honest outcome of a
 * race `put` used to hide.
 */
async function casPage(expected: Page, next: Page): Promise<void> {
  if (await pages.cas(expected, next)) return;
  const cur = await pages.get(expected.tenantId, expected.pageId);
  if (!cur || cur.orgId !== expected.orgId) {
    throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: expected.pageId });
  }
  throw new OpenwopError(
    'conflict',
    `The page changed while this change was being saved (now version ${cur.version}) — reload and try again.`,
    409,
    { pageId: expected.pageId, currentVersion: cur.version },
  );
}

/**
 * ADR 0408 D5 — the id-preserving APP_MIGRATION body: every legacy `cms:page`
 * row becomes a `cms.page` kernel row (pageId = entityId; versions/redirects/
 * experiments keys untouched). Idempotent + concurrency-tolerant: an already-
 * migrated page is skipped; the kernel write is CAS-guarded. Legacy rows stay
 * READ-DARK for one release (the rollback window) — nothing reads them; the
 * following release's cleanup migration removes them. Also seeds scheduled
 * MARKERS for pages with a pending scheduled publish.
 */
export async function migratePagesToKernel(): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  for (const page of await legacyPages.list()) {
    // Custom loop (not the factory's migrate) because pages ALSO seed a
    // scheduled-publish marker on the move. pages.get ensures the type + reads
    // the kernel; skip-if-present is id-preserving + idempotent.
    if (await pages.get(page.tenantId, page.pageId)) {
      skipped += 1;
      continue;
    }
    await pages.put(page);
    if (page.scheduledPublishAt && (page.status === 'draft' || page.status === 'in_review')) {
      await scheduledMarkers.put({ pageId: page.pageId, tenantId: page.tenantId, orgId: page.orgId, at: page.scheduledPublishAt });
    }
    migrated += 1;
  }
  if (migrated > 0) log.info('cms_pages_migrated_to_kernel', { migrated, skipped });
  return { migrated, skipped };
}

/** ADR 0408 — scheduled-publish MARKER rows so the minute sweep reads a tiny
 *  dedicated set instead of scanning pages (cheaper than the pre-kernel
 *  cross-tenant page scan; markers self-heal on read). */
interface ScheduledMarker { pageId: string; tenantId: string; orgId: string; at: string }
/** ADR 0836 D4 — page ids are per TENANT (and `/v1/content` lets a caller choose
 *  one), so a marker keyed by `pageId` alone let tenant B overwrite tenant A's
 *  schedule. Both ids may contain `:`, so each is encoded; NO NUL separator —
 *  Postgres `TEXT` rejects it (the pre-code review's Blocker). */
function markerKey(tenantId: string, pageId: string): string {
  return `${encodeURIComponent(tenantId)}/${encodeURIComponent(pageId)}`;
}
const scheduledMarkers = new DurableCollection<ScheduledMarker>('cms:scheduled', (m) => markerKey(m.tenantId, m.pageId));
/** ADR 0204 C2b — a SEPARATE marker lane for scheduled unpublish. The publish
 *  markers are keyed by pageId alone, so the embargo pair (publish 09:00 +
 *  unpublish 17:00 on ONE page) would collide in one collection — two lanes,
 *  same shape, same self-heal discipline. No subject data (pageId/tenant/org/
 *  at only), same DSAR class as `cms:scheduled`. */
const scheduledUnpublishMarkers = new DurableCollection<ScheduledMarker>('cms:scheduled-unpublish', (m) => markerKey(m.tenantId, m.pageId));

/** Remove a page's marker — the tenant-qualified key, and a pre-ADR-0836 row
 *  stored under the bare `pageId`, but ONLY after reading it back and confirming
 *  it is this tenant's (a blind legacy delete would drop another tenant's
 *  schedule for a page that shares the id). Legacy rows drain through here. */
async function dropMarker(coll: DurableCollection<ScheduledMarker>, tenantId: string, orgId: string, pageId: string): Promise<void> {
  await coll.delete(markerKey(tenantId, pageId));
  const legacy = await coll.get(pageId);
  if (legacy && legacy.tenantId === tenantId && legacy.orgId === orgId && legacy.pageId === pageId) await coll.delete(pageId);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Content sanitization ─────────────────────────────────────────────────────

/** ADR 1064 — the form card's person: a name, a short note ("Read by a person,
 *  not a bot") and an optional picture with required alt text. Null when it
 *  has neither a name nor a note. */
function cleanFormPerson(raw: unknown): { name?: string; note?: string; imageToken?: string; alt?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const name = optionalCleanContent(p.name, MAX.label, 'person.name');
  const note = optionalCleanContent(p.note, MAX.label, 'person.note');
  const imageToken = cleanOpaqueToken(p.imageToken, MAX.token);
  const alt = optionalCleanContent(p.alt, MAX.alt, 'person.alt');
  if (imageToken && !alt) throw new OpenwopError('validation_error', 'form.person.alt is required when form.person.imageToken is set.', 400, {});
  if (!name && !note) return undefined;
  return { ...(name ? { name } : {}), ...(note ? { note } : {}), ...(imageToken ? { imageToken, alt } : {}) };
}

const CHIP_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
/** ADR 1064 P3f(d) — the hero picture's annotation chips: up to four, each a
 *  short text (≤ 40) at a closed corner. A chip without text or a corner is
 *  dropped; a fifth is refused. Decoration: the hero copy carries the words. */
function heroImageChips(raw: unknown): { chips?: Array<{ text: string; at: string }> } {
  if (!Array.isArray(raw)) return {};
  if (raw.length > 4) throw new OpenwopError('validation_error', 'hero.chips holds at most 4 chips.', 400, { field: 'chips' });
  const chips = raw.map((c) => {
    const cc = asObject(c) ?? {};
    const text = optionalCleanContent(cc.text, 40, 'chips.text');
    const at = pickEnum(CHIP_CORNERS, cc.at);
    return text && at ? { text, at: at as string } : null;
  }).filter((c): c is { text: string; at: string } => c !== null);
  return chips.length > 0 ? { chips } : {};
}

/** ADR 1064 P3f — a `timeline` section's picture beside the rail: an opaque
 *  media token with required alt text and an optional browser-frame label.
 *  Nothing on any other layout. */
/** ADR 1071 D1 — a columns section's headline number: a whole number 0–9,999,999
 *  and its words (≤ the badge cap). Both or nothing. */
function cleanSectionStat(v: unknown): { value: number; label: string } | undefined {
  const o = asObject(v);
  if (!o) return undefined;
  const value = typeof o.value === 'number' && Number.isInteger(o.value) && o.value >= 0 && o.value <= 9_999_999 ? o.value : undefined;
  const label = optionalCleanContent(o.label, MAX.badge, 'stat');
  return value !== undefined && label ? { value, label } : undefined;
}

/** ADR 1074 D1 — a richText's screenshot: a token, its alt (required with it),
 *  the frame's window-bar label and a caption. */
function richTextShot(d: Record<string, unknown>): Record<string, string> {
  const imageToken = cleanOpaqueToken(d.imageToken, MAX.token);
  if (!imageToken) return {};
  const alt = optionalCleanContent(d.alt, MAX.alt, 'alt');
  if (!alt) throw new OpenwopError('validation_error', 'richText.alt is required when it has an imageToken.', 400, {});
  const frameUrl = optionalCleanContent(d.frameUrl, MAX.label, 'frameUrl');
  const caption = optionalCleanContent(d.caption, MAX.caption, 'caption');
  return { imageToken, alt, ...(frameUrl ? { frameUrl } : {}), ...(caption ? { caption } : {}) };
}

/** ADR 1080 D12 — a photo beside a `card` form. Alt text is required with a token. */
function formPicture(d: Record<string, unknown>): Record<string, string> {
  if (d.layout !== 'card') return {};
  const imageToken = cleanOpaqueToken(d.imageToken, MAX.token);
  if (!imageToken) return {};
  const alt = optionalCleanContent(d.alt, MAX.alt, 'alt');
  if (!alt) throw new OpenwopError('validation_error', 'form.alt is required when it has an imageToken.', 400, {});
  return { imageToken, alt };
}

function timelineShot(layout: string, d: Record<string, unknown>, featureHead = false): Record<string, string> {
  // ADR 1071 D1 — a section with a headline stat may carry the same picture, beside its head.
  if (layout !== 'timeline' && !featureHead) return {};
  const imageToken = cleanOpaqueToken(d.imageToken, MAX.token);
  if (!imageToken) return {};
  const alt = optionalCleanContent(d.alt, MAX.alt, 'alt');
  if (!alt) throw new OpenwopError('validation_error', layout === 'timeline' ? 'columns.alt is required when a timeline has an imageToken.' : 'columns.alt is required when a section with a stat has an imageToken.', 400, {});
  const frameUrl = optionalCleanContent(d.frameUrl, MAX.label, 'frameUrl');
  return { imageToken, alt, ...(frameUrl ? { frameUrl } : {}) };
}

/** A CTA target: a same-page fragment (`#faq`, ADR 0920 D6), an internal app path (`/agents`) — a single leading slash, NOT
 *  `//` or `/\` (both normalize to a protocol-relative EXTERNAL URL in a browser →
 *  open-redirect shape) — OR an EXPLICIT-scheme http(s)/mailto URL. `safeUrl`
 *  alone is too loose: it accepts protocol-relative `//host`, so require an
 *  explicit scheme on the non-internal branch. */
function safeLink(v: unknown, max: number): string {
  // ADR 0920 D6 — a same-page fragment (`#section-id`), returned unchanged. The
  // grammar is closed (letter first, then [A-Za-z0-9_-], ≤ 80 after `#`), so a
  // bare `#`, `#a b`, `#<x>` and `#javascript:…` all fall through and are refused.
  if (typeof v === 'string' && isFragmentHref(v.trim())) return v.trim();
  // A published link is CONTENT: never rewritten (a signed or long-slug URL
  // survives byte for byte), and a credential in it is a typed refusal.
  const s = (optionalCleanContent(v, max, 'link') ?? '').trim();
  if (isInternalHref(s)) return s;
  if (s.startsWith('/')) return ''; // a `/…` that is not a safe internal path is never an external URL either
  const u = contentUrl(v, max, 'link');
  return /^(https?:|mailto:)/i.test(u) ? u : '';
}

/** A `comparison` section's optional `style` (absent = the mark matrix). */
export const COMPARISON_STYLES: ReadonlySet<string> = new Set(['text']);
// `VIDEO_LENGTH_RE` (ADR 0843) now lives in designSections.ts, shared with `films`.
/** ADR 0843 — the hosts a `youtubeUrl` may name (the link reads "Watch on YouTube"). */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

/**
 * ADR 0843 — a media URL a `video` section loads or links: https ONLY (never
 * http, protocol-relative, `data:` or `javascript:`), no credentials, within
 * `MAX.url`. Built on the shared `safeUrl` scheme screen, then parsed.
 *
 * Absent ⇒ undefined (the caller decides whether that is a missing required
 * field). Present but invalid ⇒ a 400 on the base layer; on a partial overlay
 * (a stored localization or an AI translation's output) it is DROPPED instead —
 * the translate path logs a dropped key, and a model echoing a mangled URL must
 * not fail the whole overlay.
 */
function httpsMediaUrl(v: unknown, field: string, partial: boolean, hosts?: ReadonlySet<string>, section = 'video'): string | undefined {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
  const reject = (why: string): undefined => {
    if (partial) return undefined;
    throw new OpenwopError('validation_error', `${section}.${field} ${why}`, 400, { field });
  };
  if (typeof v !== 'string') return reject('must be a URL string.');
  if (v.trim().length > MAX.url) return reject(`must be at most ${MAX.url} characters.`);
  const u = contentUrl(v, MAX.url, `${section}.${field}`);
  let parsed: URL;
  try { parsed = new URL(u); } catch { return reject('must be an absolute https:// URL.'); }
  if (parsed.protocol !== 'https:' || !/^https:\/\//i.test(u)) return reject('must be an absolute https:// URL.');
  if (parsed.username || parsed.password) return reject('must not carry credentials.');
  if (hosts && !hosts.has(parsed.hostname.toLowerCase())) return reject(`must be a ${[...hosts].join(' / ')} URL.`);
  return u;
}

/** ADR 1032 — a `video` section's second film. Absent, or an empty object, is
 *  no second film. On the base every field the first film requires is required
 *  here too (the pair is two real films, never a half-filled card); an overlay
 *  (`partial`) may carry only the translatable text. */
function cleanSecondFilm(raw: unknown, partial: boolean): Record<string, string> | undefined {
  const f = asObject(raw);
  if (!f || Object.keys(f).length === 0) return undefined;
  const src = httpsMediaUrl(f.src, 'film2.src', partial);
  const poster = httpsMediaUrl(f.poster, 'film2.poster', partial);
  const captions = httpsMediaUrl(f.captions, 'film2.captions', partial);
  const youtubeUrl = httpsMediaUrl(f.youtubeUrl, 'film2.youtubeUrl', partial, YOUTUBE_HOSTS);
  const title = optionalCleanContent(f.title, MAX.title, 'film2.title');
  const description = optionalCleanContent(f.description, MAX.videoDescription, 'film2.description');
  // ADR 1068 D1 — the play chip's own words and a visible caption (see the first film).
  const chipLabel = optionalCleanContent(f.chipLabel, MAX.label, 'film2.chipLabel');
  const caption = optionalCleanContent(f.caption, MAX.caption, 'film2.caption');
  const lengthRaw = typeof f.length === 'string' ? f.length.trim() : '';
  const length = VIDEO_LENGTH_RE.test(lengthRaw) ? lengthRaw : undefined;
  // The second film's VideoObject needs its own uploadDate (Google treats it as
  // required), held to the first film's uploadDate rule.
  const uploadRaw = typeof f.uploadDate === 'string' ? f.uploadDate.trim() : '';
  const uploadDate = isValidUploadDate(uploadRaw) ? uploadRaw : undefined;
  if (uploadRaw && !uploadDate) throw new OpenwopError('validation_error', 'video.film2.uploadDate must be YYYY-MM-DD or an ISO 8601 datetime with a timezone.', 400, { field: 'film2.uploadDate' });
  if (!partial) {
    if (!src) throw new OpenwopError('validation_error', 'video.film2.src is required (an https:// URL to the video file).', 400, { field: 'film2.src' });
    if (!poster) throw new OpenwopError('validation_error', 'video.film2.poster is required (an https:// URL to the poster image).', 400, { field: 'film2.poster' });
    if (!title) throw new OpenwopError('validation_error', 'video.film2.title is required.', 400, { field: 'film2.title' });
    if (!description) throw new OpenwopError('validation_error', 'video.film2.description is required.', 400, { field: 'film2.description' });
    if (!length) throw new OpenwopError('validation_error', 'video.film2.length is required as m:ss (e.g. 1:57).', 400, { field: 'film2.length' });
  }
  const out: Record<string, string> = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(chipLabel ? { chipLabel } : {}),
    ...(caption ? { caption } : {}),
    ...(src ? { src } : {}),
    ...(poster ? { poster } : {}),
    ...(captions ? { captions } : {}),
    ...(length ? { length } : {}),
    ...(youtubeUrl ? { youtubeUrl } : {}),
    ...(uploadDate ? { uploadDate } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ADR 1032 — a `rows` section's try-it panel: a title and up to six labelled
 *  switches with a starting position. Presentation only: flipping one changes
 *  nothing anywhere, so it carries text and booleans and nothing else. */
function cleanToggles(raw: unknown): { title?: string; items: { label: string; on?: true }[] } | undefined {
  const t = asObject(raw);
  if (!t) return undefined;
  const items = (Array.isArray(t.items) ? t.items : []).slice(0, MAX.toggles).map((it) => {
    const ii = asObject(it) ?? {};
    const label = typeof ii.label === 'string' ? cleanContent(ii.label, MAX.label, 'label') : '';
    return { label, ...(ii.on === true ? { on: true as const } : {}) };
  }).filter((it) => it.label.length > 0);
  if (items.length === 0) return undefined;
  const title = optionalCleanContent(t.title, MAX.label, 'toggles.title');
  return { ...(title ? { title } : {}), items };
}

/** ADR 1068 D2 — a `rows` section's workflow diagram: up to eight boxes in
 *  order (a mono label, one line of text), at most ONE flagged `waiting` (the
 *  step that waits for a person; a later flag is dropped), and a caption.
 *  Presentation only: text and one boolean. Fewer than two boxes is no diagram. */
function cleanDiagram(raw: unknown): { nodes: { label: string; text?: string; waiting?: true }[]; caption?: string } | undefined {
  const g = asObject(raw);
  if (!g) return undefined;
  let waitingSeen = false;
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).slice(0, MAX.diagramNodes).map((n) => {
    const nn = asObject(n) ?? {};
    const label = typeof nn.label === 'string' ? cleanContent(nn.label, MAX.eyebrow, 'diagram.label') : '';
    const text = optionalCleanContent(nn.text, MAX.label, 'diagram.text');
    const waiting = nn.waiting === true && !waitingSeen;
    if (waiting) waitingSeen = true;
    return { label, ...(text ? { text } : {}), ...(waiting ? { waiting: true as const } : {}) };
  }).filter((n) => n.label.length > 0);
  if (nodes.length < 2) return undefined;
  const caption = optionalCleanContent(g.caption, MAX.caption, 'diagram.caption');
  return { nodes, ...(caption ? { caption } : {}) };
}

/**
 * Build a section's cleaned field set from a raw object. `partial: false` (the
 * base `data`) enforces required fields; `partial: true` (a per-locale overlay,
 * ADR 0064) skips required-field throws and includes only the fields PRESENT —
 * but cleans/bounds/safe-links every field IDENTICALLY, so a localization can
 * never become a stored-XSS or open-redirect vector that the base couldn't.
 */
function buildTypedSectionData(type: SectionType, d: Record<string, unknown>, partial: boolean, stored = false): Record<string, unknown> {
  // Optional `eyebrow`/`heading` shared by the marketing blocks (ADR 0027).
  const opt = (k: 'eyebrow' | 'heading' | 'lede', max: number): Record<string, string> => {
    const v = optionalCleanContent(d[k], max, k);
    return v ? { [k]: v } : {};
  };
  const has = (k: string): boolean => d[k] !== undefined;
  // ADR 0920 D1/D2 — closed presentation enums. Present and known ⇒ kept; absent
  // or unknown ⇒ no key at all (so a page that sets none is byte-identical).
  const tone = (): Record<string, string> => {
    const v = pickEnum(SECTION_TONES, d.tone);
    return v ? { tone: v } : {};
  };
  const headStyle = (): Record<string, string> => {
    const v = pickEnum(SECTION_HEADS, d.head);
    const size = pickEnum(SECTION_HEAD_SIZES, d.headSize);
    return { ...(v ? { head: v } : {}), ...(size ? { headSize: size } : {}) };
  };
  switch (type) {
    case 'hero': {
      const heading = cleanContent(d.heading, MAX.heading, 'heading');
      if (!partial && !heading) throw new OpenwopError('validation_error', 'hero.heading is required.', 400, {});
      const cta1 = optionalCleanContent(d.ctaLabel, MAX.label, 'ctaLabel');
      const cta2 = optionalCleanContent(d.ctaLabel2, MAX.label, 'ctaLabel2');
      const visual = HERO_VISUALS.includes(d.visual as typeof HERO_VISUALS[number])
        ? (d.visual as typeof HERO_VISUALS[number])
        : undefined;
      // ADR 0920 D3 — the example plan card, fine print, and the 2nd-CTA icon.
      const plan = cleanHeroPlan(d.plan);
      // ADR 1029 D5 — the activity (approval) card, the `plan` card's sibling.
      const activity = cleanActivity(d.activity);
      // ADR 1047 — the hub picture (centre + places), content like the activity card.
      const hub = cleanHub(d.hub);
      // ADR 1038 D8 — the flow picture, content like the activity card.
      const flow = cleanFlow(d.flow);
      // ADR 1060 — the illustrated visuals (receipt, …), each closed by its spec.
      const art = cleanAllHeroArt(d);
      const note = optionalCleanContent(d.note, MAX.heroNote, 'note');
      const ctaIcon2 = pickEnum(HERO_CTA_ICONS, d.ctaIcon2);
      // ADR 1066 D1/D2 — the picture's placement, and a second, quieter paragraph.
      const placement = pickEnum(HERO_PLACEMENTS, d.placement);
      const body = optionalCleanContent(d.body, MAX.text, 'body');
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...(heading ? { heading } : {}),
        ...(optionalCleanContent(d.subheading, MAX.text, 'subheading') ? { subheading: optionalCleanContent(d.subheading, MAX.text, 'subheading') } : {}),
        ...(body ? { body } : {}),
        ...(placement ? { placement } : {}),
        // Opaque media REFERENCE — charset-validated, NOT secret-scrubbed
        // (cleanString redacts 40+-char blobs, destroying serve tokens; ADR 0206).
        ...(cleanOpaqueToken(d.imageToken, MAX.token) ? { imageToken: cleanOpaqueToken(d.imageToken, MAX.token) } : {}),
        ...(optionalCleanContent(d.alt, MAX.alt, 'alt') ? { alt: optionalCleanContent(d.alt, MAX.alt, 'alt') } : {}),
        ...(visual ? { visual } : {}),
        // ADR 1064 P3f(d) — up to four short notes pinned to the picture's corners.
        ...heroImageChips(d.chips),
        ...(cta1 ? { ctaLabel: cta1, ctaUrl: safeLink(d.ctaUrl, MAX.url) } : {}),
        ...(cta2 ? { ctaLabel2: cta2, ctaUrl2: safeLink(d.ctaUrl2, MAX.url) } : {}),
        ...(ctaIcon2 ? { ctaIcon2 } : {}),
        ...(note ? { note } : {}),
        ...(plan ? { plan } : {}),
        ...(activity ? { activity } : {}),
        ...(hub ? { hub } : {}),
        ...(flow ? { flow } : {}),
        ...art,
        // ADR 1080 D7 — the queue picture.
        ...(cleanHeroQueue(d.queue) ? { queue: cleanHeroQueue(d.queue) } : {}),
      };
    }
    case 'productGrid': {
      // C7 (ecommerce gap plan) — content-commerce composition: VALIDATED PRODUCT
      // REFERENCES, never copied product data. The renderer resolves live
      // name/price/image through the public-store read at view time; a missing/
      // archived product renders the fallback (skipped), never stale data.
      // Structural validation here (bounded id list, one org's storefront);
      // existence is a render-time concern by design (products churn under pages).
      const productIds = Array.isArray(d.productIds)
        ? (d.productIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80).slice(0, 24)
        : [];
      if (!partial && productIds.length === 0) throw new OpenwopError('validation_error', 'productGrid.productIds needs at least one product id.', 400, {});
      const storeOrgId = optionalCleanString(d.storeOrgId, 120);
      if (!partial && !storeOrgId) throw new OpenwopError('validation_error', 'productGrid.storeOrgId is required (whose storefront to resolve against).', 400, {});
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(productIds.length > 0 ? { productIds } : {}),
        ...(storeOrgId ? { storeOrgId } : {}),
      };
    }
    case 'form': {
      // ADR 0331 §D2 — content-capture composition: a VALIDATED FORM REFERENCE
      // ({ formId }; orgId kept as editor convenience), never copied fields.
      // The renderer resolves the public render schema live at view time; a
      // missing/unpublished/toggled-off form renders nothing (uniform 404
      // honesty) — existence is a render-time concern (the productGrid model).
      const formId = cleanOpaqueToken(d.formId, 128);
      if (!partial && !formId) throw new OpenwopError('validation_error', 'form.formId is required (which form to render).', 400, {});
      const formOrgId = optionalCleanString(d.orgId, 120);
      // ADR 1064 — `layout: 'card'`: the copy beside the form, which sits in a
      // card; an optional `person` (who reads the message) heads the card. A
      // person picture always carries its alt text; anything else is dropped.
      const person = d.layout === 'card' ? cleanFormPerson(d.person) : undefined;
      // ADR 1068 D3 — a short note under the form card ("Read by a person.
      // We answer within a day.").
      // An overlay names no layout, so it keeps the note's words (the base decides whether it shows).
      const formNote = partial || d.layout === 'card' ? optionalCleanContent(d.note, MAX.sectionNote, 'note') : undefined;
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(formId ? { formId } : {}),
        ...(formOrgId ? { orgId: formOrgId } : {}),
        ...(d.layout === 'card' ? { layout: 'card' } : {}),
        ...(person ? { person } : {}),
        ...(formNote ? { note: formNote } : {}),
        // ADR 1080 D12 — a photo beside the form card, and the button's words.
        ...formPicture(d),
        ...(optionalCleanContent(d.submitLabel, MAX.badge, 'submitLabel') ? { submitLabel: optionalCleanContent(d.submitLabel, MAX.badge, 'submitLabel') } : {}),
      };
    }
    case 'entityList': {
      // ADR 0407 D1 — entity-backed section: a VALIDATED QUERY REFERENCE
      // (tenant + type + bounded presentation config), never copied entity
      // data. The renderer resolves live rows through the ANONYMOUS
      // public-entities read at view time (publicRead types only — the section
      // can never surface anything the anonymous wire wouldn't); a missing/
      // non-public type renders the fallback. Structural validation here;
      // existence is a render-time concern (the productGrid model). The
      // stored query spec EXECUTES only in the entities feature (ADR 0386
      // correction-note boundary) — cms never grows a query engine.
      const tenantId = optionalCleanString(d.tenantId, 120);
      if (!partial && !tenantId) throw new OpenwopError('validation_error', 'entityList.tenantId is required (whose workspace to resolve against).', 400, {});
      const typeName = optionalCleanString(d.typeName, 120);
      if (!partial && !typeName) throw new OpenwopError('validation_error', 'entityList.typeName is required (which entity type to list).', 400, {});
      const titleField = optionalCleanString(d.titleField, 80);
      if (!partial && !titleField) throw new OpenwopError('validation_error', 'entityList.titleField is required (which field titles each card).', 400, {});
      const limitRaw = typeof d.limit === 'number' && Number.isFinite(d.limit) ? Math.floor(d.limit) : undefined;
      const sortDir = d.sortDir === 'asc' || d.sortDir === 'desc' ? d.sortDir : undefined;
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(tenantId ? { tenantId } : {}),
        ...(typeName ? { typeName } : {}),
        ...(titleField ? { titleField } : {}),
        ...(optionalCleanString(d.bodyField, 80) ? { bodyField: optionalCleanString(d.bodyField, 80) } : {}),
        ...(limitRaw !== undefined ? { limit: Math.min(Math.max(limitRaw, 1), 24) } : {}),
        ...(optionalCleanString(d.sortKey, 80) ? { sortKey: optionalCleanString(d.sortKey, 80) } : {}),
        ...(sortDir ? { sortDir } : {}),
        // ADR 0407 Phase 3 — optional taxonomy-term narrowing (an opaque term
        // reference; membership resolves in the entities feature at render).
        ...(cleanOpaqueToken(d.termId, 128) ? { termId: cleanOpaqueToken(d.termId, 128) } : {}),
        // ADR 0408 Phase D — ONE bounded equality pair (e.g. kind=post for an
        // entityList over cms.page). Still a carried spec: the query executes
        // in the entities feature, validated closed-world against the type.
        ...(optionalCleanString(d.filterKey, 80) && optionalCleanString(d.filterValue, 200)
          ? { filterKey: optionalCleanString(d.filterKey, 80), filterValue: optionalCleanString(d.filterValue, 200) }
          : {}),
      };
    }
    case 'entityDetail': {
      // ADR 0407 D1 — a single-entity reference (the entityList rules, one row).
      const tenantId = optionalCleanString(d.tenantId, 120);
      if (!partial && !tenantId) throw new OpenwopError('validation_error', 'entityDetail.tenantId is required.', 400, {});
      const typeName = optionalCleanString(d.typeName, 120);
      if (!partial && !typeName) throw new OpenwopError('validation_error', 'entityDetail.typeName is required.', 400, {});
      const entityId = cleanOpaqueToken(d.entityId, 128);
      if (!partial && !entityId) throw new OpenwopError('validation_error', 'entityDetail.entityId is required (which entity to render).', 400, {});
      const titleField = optionalCleanString(d.titleField, 80);
      if (!partial && !titleField) throw new OpenwopError('validation_error', 'entityDetail.titleField is required.', 400, {});
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(tenantId ? { tenantId } : {}),
        ...(typeName ? { typeName } : {}),
        ...(entityId ? { entityId } : {}),
        ...(titleField ? { titleField } : {}),
        ...(optionalCleanString(d.bodyField, 80) ? { bodyField: optionalCleanString(d.bodyField, 80) } : {}),
      };
    }
    case 'richText': {
      // Stored as PLAIN TEXT / markdown — NOT raw HTML. The renderer treats it as
      // text, so there is no stored-XSS surface to sanitize. Bounded + scrubbed.
      // ADR 0920 D5 — the conversation picture beside the copy.
      const rtVisual = pickEnum(RICH_TEXT_VISUALS, d.visual);
      const chat = cleanChat(d.chat);
      // ADR 1074 D1 — the screenshot beside the copy (`visual: 'image'`), always
      // in a browser frame. Kept like `chat` when the author switches visuals.
      const rtShot = richTextShot(d);
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(!partial || has('text') ? { text: cleanContent(d.text, MAX.markdown, 'text') } : {}),
        ...tone(),
        ...headStyle(),
        ...(rtVisual ? { visual: rtVisual } : {}),
        ...(chat ? { chat } : {}),
        ...rtShot,
        // ADR 1080 D5/D8 — the picture on the copy's start side, and the card picture.
        ...(pickEnum(RICH_TEXT_SIDES, d.side) ? { side: pickEnum(RICH_TEXT_SIDES, d.side) } : {}),
        ...(cleanRichTextCard(d.card, safeLink) ? { card: cleanRichTextCard(d.card, safeLink) } : {}),
        // ADR 1064 P3f — inline code spans render as <cite> source pills.
        ...(d.sources === true ? { sources: true } : {}),
        // ADR 1073 D1 — a pull quote under the heading (plain text, like a testimonial).
        ...(optionalCleanContent(d.quote, MAX.caption, 'quote') ? { quote: optionalCleanContent(d.quote, MAX.caption, 'quote') } : {}),
      };
    }
    case 'image': {
      // Opaque media REFERENCE — charset-validated, NOT secret-scrubbed (see hero).
      const token = cleanOpaqueToken(d.token, MAX.token);
      if (!partial && !token) throw new OpenwopError('validation_error', 'image.token is required.', 400, {});
      // ADR 1032 — an optional head over the figure, and a browser frame whose
      // address label is plain text (a label, never a link).
      const frame = pickEnum(IMAGE_FRAMES, d.frame);
      const frameUrl = optionalCleanContent(d.frameUrl, MAX.label, 'frameUrl');
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(frame ? { frame } : {}),
        ...(frameUrl ? { frameUrl } : {}),
        ...(token ? { token } : {}),
        ...(optionalCleanContent(d.alt, MAX.alt, 'alt') ? { alt: optionalCleanContent(d.alt, MAX.alt, 'alt') } : {}),
        ...(optionalCleanContent(d.caption, MAX.caption, 'caption') ? { caption: optionalCleanContent(d.caption, MAX.caption, 'caption') } : {}),
        ...tone(), // ADR 1050 D5 — the same band as the other sections
      };
    }
    case 'cta': {
      const label = cleanContent(d.label, MAX.label, 'label');
      if (!partial && !label) throw new OpenwopError('validation_error', 'cta.label is required.', 400, {});
      const align = pickEnum(CTA_ALIGNS, d.align); // ADR 0920 D6
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(optionalCleanContent(d.subheading, MAX.text, 'subheading') ? { subheading: optionalCleanContent(d.subheading, MAX.text, 'subheading') } : {}),
        ...(label ? { label } : {}),
        ...(!partial || has('url') ? { url: safeLink(d.url, MAX.url) } : {}),
        ...tone(),
        ...(align ? { align } : {}),
        // ADR 1062 D4 — a short line under the button ("No card needed").
        ...(optionalCleanContent(d.note, MAX.caption, 'note') ? { note: optionalCleanContent(d.note, MAX.caption, 'note') } : {}),
      };
    }
    case 'columns': {
      const cols = Array.isArray(d.columns) ? d.columns : [];
      const layout = COLUMN_LAYOUTS.includes(d.layout as typeof COLUMN_LAYOUTS[number]) ? (d.layout as string) : 'cards';
      const mapped = cols.slice(0, MAX.columns).map((c) => {
        const cc = c as { status?: unknown; state?: unknown; title?: unknown; text?: unknown; href?: unknown; icon?: unknown; optional?: unknown; eyebrow?: unknown; progress?: unknown; badge?: unknown; future?: unknown; partial?: unknown; count?: unknown; tone?: unknown; gauge?: unknown; art?: unknown; items?: unknown; wide?: unknown; imageToken?: unknown; alt?: unknown; frameUrl?: unknown; highlight?: unknown; callout?: unknown; tags?: unknown; more?: unknown; unit?: unknown; ctaLabel?: unknown; ctaUrl?: unknown; tall?: unknown; countLabel?: unknown; imagePosition?: unknown; tag?: unknown };
        const title = optionalCleanContent(cc.title, MAX.label, 'title');
        // Optional per-card link target → the whole card renders as a link
        // (cards layout, #414). `safeLink` guards open-redirect / non-http(s).
        const href = safeLink(cc.href, MAX.url);
        // Optional per-card icon slug (ADR 0027) — an opaque token the public
        // renderer maps to a glyph (ICON_BY_SLUG), unknown slugs falling back to
        // the node motif. Bounded + cleaned; never interpreted server-side.
        const icon = optionalCleanString(cc.icon, MAX.slug);
        // ADR 0920 D4 — per-item label line, progress bar, badge, "not yet"
        // card, drawing, and `list` rows (name + right-aligned length).
        const itemEyebrow = optionalCleanContent(cc.eyebrow, MAX.eyebrow, 'eyebrow');
        const progress = unitFraction(cc.progress);
        const badge = optionalCleanContent(cc.badge, MAX.badge, 'badge');
        const art = pickEnum(COLUMN_ART, cc.art);
        const items = (Array.isArray(cc.items) ? cc.items : []).slice(0, MAX.listItems).map((it) => {
          const ii = asObject(it) ?? {};
          const meta = optionalCleanContent(ii.meta, MAX.itemMeta, 'meta');
          // ADR 1071 D3 — a short note on the row's other side ("your-app.com").
          const aside = optionalCleanContent(ii.aside, MAX.itemMeta, 'aside');
          return { label: typeof ii.label === 'string' ? cleanContent(ii.label, MAX.label, 'label') : '', ...(meta ? { meta } : {}), ...(aside ? { aside } : {}) };
        }).filter((it) => it.label.length > 0);
        // ADR 1037 — a picture on the item (a bento tile's foot, a marquee app
        // card). An opaque media REFERENCE like `image.token` (charset-checked,
        // never secret-scrubbed). A picture always carries its alt text: an
        // image without one is refused, never published unlabelled. `frameUrl`
        // is the ADR 1032 browser frame's plain-text address label (never a link).
        const imageToken = cleanOpaqueToken(cc.imageToken, MAX.token);
        const itemAlt = optionalCleanContent(cc.alt, MAX.alt, 'alt');
        if (imageToken && !itemAlt) {
          throw new OpenwopError('validation_error', 'columns[].alt is required when columns[].imageToken is set.', 400, {});
        }
        const frameUrl = imageToken ? optionalCleanContent(cc.frameUrl, MAX.label, 'frameUrl') : undefined;
        // ADR 1047 — a feature card's callout ("The problem it solves"), its
        // status pills, and its folded "How you use it". Kept on any layout (a
        // locale overlay may not name one); only `features` draws them. A
        // callout or disclosure needs its text; a pill needs its label.
        const co = asObject(cc.callout) ?? {};
        const calloutText = optionalCleanContent(co.text, MAX.lede, 'callout');
        const callout = calloutText ? defined({ label: optionalCleanContent(co.label, MAX.eyebrow, 'callout'), text: calloutText }) : undefined;
        const tags = (Array.isArray(cc.tags) ? cc.tags : []).slice(0, MAX.featureTags).map((tg) => {
          const tt = asObject(tg) ?? {};
          return defined({ label: optionalCleanContent(tt.label, MAX.featureTag, 'tag'), state: pickEnum(FEATURE_TAG_STATES, tt.state) });
        }).filter((tg) => tg.label !== undefined);
        const mo = asObject(cc.more) ?? {};
        const moreText = optionalCleanContent(mo.text, MAX.featureMore, 'more');
        const more = moreText ? defined({ label: optionalCleanContent(mo.label, MAX.label, 'more'), text: moreText }) : undefined;
        // ADR 1038 D8 — a flow node's status word and styling state.
        // On the base layer they are kept only on a flow (an overlay names no
        // layout, so it keeps them and the base sync corrects the state).
        const flowItem = partial || layout === 'flow';
        const status = flowItem ? optionalCleanContent(cc.status, MAX.flowLabel, 'status') : undefined;
        const state = flowItem ? pickEnum(FLOW_STATES, cc.state) : undefined;
        return {
          ...(title ? { title } : {}),
          text: cleanContent(cc.text, MAX.text, 'text'),
          ...(href ? { href } : {}),
          ...(icon ? { icon } : {}),
          ...(cc.optional === true ? { optional: true } : {}),
          ...(itemEyebrow ? { eyebrow: itemEyebrow } : {}),
          ...(progress !== undefined ? { progress } : {}),
          ...(badge ? { badge } : {}),
          ...(cc.future === true ? { future: true } : {}),
          // A status list's middle state ("partly there"). `future` wins if both are set.
          ...(cc.partial === true && cc.future !== true ? { partial: true } : {}),
          // ADR 1029 D5 — a `bento` tile two columns wide.
          ...(cc.wide === true ? { wide: true } : {}),
          // ADR 1070 D1 — a bento tile two rows tall.
          ...(cc.tall === true ? { tall: true } : {}),
          // ADR 1063 P2c — a tile's headline number (counts up from 0) and a
          // dark tile. An integer 0–9,999,999; anything else is dropped.
          ...(typeof cc.count === 'number' && Number.isInteger(cc.count) && cc.count >= 0 && cc.count <= 9_999_999 ? { count: cc.count } : {}),
          // ADR 1070 D1 — `mist` joins `inverse`: a muted tile.
          ...(pickEnum(COLUMN_ITEM_TONES, cc.tone) ? { tone: pickEnum(COLUMN_ITEM_TONES, cc.tone) } : {}),
          // ADR 1070 D2 — the words under a tile's headline number ("features, already built").
          ...(optionalCleanContent(cc.countLabel, MAX.badge, 'countLabel') ? { countLabel: optionalCleanContent(cc.countLabel, MAX.badge, 'countLabel') } : {}),
          // ADR 1070 D3 — a bento tile's picture at its top instead of its foot.
          ...(pickEnum(COLUMN_IMAGE_POSITIONS, cc.imagePosition) ? { imagePosition: pickEnum(COLUMN_IMAGE_POSITIONS, cc.imagePosition) } : {}),
          // ADR 1064 P3d — a card's ring gauge: its words ("415/415"), the
          // ring's fill from the item's own `progress`. Content, never computed.
          ...(optionalCleanContent(cc.gauge, MAX.badge, 'gauge') ? { gauge: optionalCleanContent(cc.gauge, MAX.badge, 'gauge') } : {}),
          ...(art ? { art } : {}),
          ...(items.length > 0 ? { items } : {}),
          ...(imageToken ? { imageToken, alt: itemAlt } : {}),
          ...(frameUrl ? { frameUrl } : {}),
          // ADR 1037 — the item the section singles out (a featured plan, a
          // standout tile). Presentation only.
          ...(cc.highlight === true ? { highlight: true } : {}),
          // ADR 1069 D1 — a plan card's price unit ("a month, per app") and its
          // own button. The link is guarded like every other; no label, no link.
          ...(optionalCleanContent(cc.unit, MAX.badge, 'unit') ? { unit: optionalCleanContent(cc.unit, MAX.badge, 'unit') } : {}),
          ...(optionalCleanContent(cc.ctaLabel, MAX.label, 'ctaLabel') ? { ctaLabel: optionalCleanContent(cc.ctaLabel, MAX.label, 'ctaLabel'), ctaUrl: safeLink(cc.ctaUrl, MAX.url) } : {}),
          ...(callout ? { callout } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(more ? { more } : {}),
          ...(status ? { status } : {}),
          ...(state ? { state } : {}),
          // ADR 1080 D9 — a short mono tag over a gallery caption ("Powder room").
          ...(optionalCleanContent(cc.tag, MAX.badge, 'tag') ? { tag: optionalCleanContent(cc.tag, MAX.badge, 'tag') } : {}),
        };
      });
      // ADR 1038 D8 — a flow holds at most six nodes; refuse rather than cut an
      // author's seventh step silently (a longer process is a timeline).
      if (!partial && layout === 'flow' && cols.length > MAX.flowNodes) {
        throw new OpenwopError('validation_error', `columns: a flow holds at most ${MAX.flowNodes} steps; use the timeline layout for a longer process.`, 400, {});
      }
      const colNote = optionalCleanContent(d.note, MAX.sectionNote, 'note');
      const sectionStat = cleanSectionStat(d.stat);
      const numbers = pickEnum(STEP_NUMBERS, d.numbers);
      const toggles = cleanToggles(d.toggles);
      const diagram = layout === 'rows' ? cleanDiagram(d.diagram) : undefined;
      // ADR 1047 — the words each pill state means ("Available now", "Rolling
      // out"), shown as a legend over a `features` grid and read with each pill.
      const lg = asObject(d.tagLegend) ?? {};
      const tagLegend = defined({ now: optionalCleanContent(lg.now, MAX.badge, 'tagLegend'), soon: optionalCleanContent(lg.soon, MAX.badge, 'tagLegend') });
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(!partial || has('layout') ? { layout } : {}),
        ...(!partial || has('columns') ? { columns: mapped } : {}),
        ...(colNote ? { note: colNote } : {}),
        // ADR 1069 D2 — the footnote as a boxed callout.
        ...(colNote && pickEnum(COLUMN_NOTE_STYLES, d.noteStyle) ? { noteStyle: pickEnum(COLUMN_NOTE_STYLES, d.noteStyle) } : {}),
        ...(numbers ? { numbers } : {}),
        ...(toggles ? { toggles } : {}),
        ...(diagram ? { diagram } : {}),
        ...(Object.keys(tagLegend).length > 0 ? { tagLegend } : {}),
        // ADR 1064 P3b — status filter chips over a `tiles` grid.
        ...(d.filter === true ? { filter: true } : {}),
        // ADR 1072 D1 — steps drawn as boxed cards with an arrow between them.
        ...(layout === 'steps' && d.cards === true ? { cards: true } : {}),
        // ADR 1072 D2 — a gallery led by one tall picture, the rest stacked beside it.
        ...(layout === 'gallery' && pickEnum(GALLERY_LAYOUTS, d.galleryLayout) ? { galleryLayout: pickEnum(GALLERY_LAYOUTS, d.galleryLayout) } : {}),
        // ADR 1080 D9 — a gallery that runs edge to edge.
        ...(layout === 'gallery' && d.bleed === true ? { bleed: true } : {}),
        // ADR 1064 P3c — a flow's marks light in turn (a loop with a pause control).
        ...(layout === 'flow' && d.run === true ? { run: true } : {}),
        // ADR 1064 P3f — a timeline's picture beside the rail (alt required).
        // ADR 1071 D1 — the section's headline number, and its picture beside the head.
        ...(sectionStat ? { stat: sectionStat } : {}),
        ...timelineShot(layout, d, sectionStat !== undefined),
        // ADR 1073 D2 — a timeline's head and picture on the start side, the rail beside them.
        ...(layout === 'timeline' && pickEnum(TIMELINE_SHOT_SIDES, d.shotSide) ? { shotSide: pickEnum(TIMELINE_SHOT_SIDES, d.shotSide) } : {}),
        // ADR 1073 D3 — numbered badges on the rail instead of dots.
        ...(layout === 'timeline' && pickEnum(TIMELINE_MARKERS, d.markers) ? { markers: pickEnum(TIMELINE_MARKERS, d.markers) } : {}),
        ...tone(),
        ...headStyle(),
      };
    }
    case 'pricing': {
      // ADR 0391 (b) — a marketing wrapper around the plan tiers. It names WHICH
      // tiers to show (a closed-enum subset) + copy + a CTA; it carries NO prices
      // (the client resolves the display-safe tier catalog live from the
      // `/public/pricing` billing read). All fields optional — an empty pricing
      // section still renders the tier grid client-side.
      const tiers = Array.isArray(d.tiers)
        ? [...new Set((d.tiers as unknown[]).filter((t): t is typeof PRICING_TIER_IDS[number] => PRICING_TIER_IDS.includes(t as typeof PRICING_TIER_IDS[number])))]
        : [];
      const ctaLabel = optionalCleanContent(d.ctaLabel, MAX.label, 'ctaLabel');
      // ADR 1069 D4 — `plans`: AUTHORED named plans for a site with no billing
      // tiers yet (DeckTalk: "Pilot · Open now"). Present ⇒ it REPLACES the live
      // billing read, and still carries no price: there is no price field, and
      // nothing renders a number. A new field, because `tiers` already means
      // billing tier ids and an overlay must never read one field two ways.
      // A locale overlay (partial) drops a nameless plan instead of failing,
      // like every other overlay field; a saved section refuses it.
      const plans = (Array.isArray(d.plans) ? d.plans : []).slice(0, MAX.plans).flatMap((p, i) => {
        const pp = (p ?? {}) as Record<string, unknown>;
        const name = optionalCleanContent(pp.name, MAX.planName, 'name');
        if (!name) {
          if (partial) return [];
          throw new OpenwopError('validation_error', `pricing.plans[${i}].name is required.`, 400, {});
        }
        const status = optionalCleanContent(pp.status, MAX.badge, 'status');
        const blurb = optionalCleanContent(pp.blurb, MAX.planBlurb, 'blurb');
        const planCta = optionalCleanContent(pp.ctaLabel, MAX.label, 'ctaLabel');
        return [{
          name,
          ...(status ? { status } : {}),
          ...(blurb ? { blurb } : {}),
          ...(planCta ? { ctaLabel: planCta, ctaUrl: safeLink(pp.ctaUrl, MAX.url) } : {}),
          ...(pp.highlight === true ? { highlight: true } : {}),
        }];
      });
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(optionalCleanContent(d.blurb, MAX.text, 'blurb') ? { blurb: optionalCleanContent(d.blurb, MAX.text, 'blurb') } : {}),
        ...(tiers.length > 0 ? { tiers } : {}),
        ...(plans.length > 0 ? { plans } : {}),
        ...(ctaLabel ? { ctaLabel, ctaUrl: safeLink(d.ctaUrl, MAX.url) } : {}),
        // ADR 0820 §7 — where an UNPRICED plan's "Contact us" goes (same link guard).
        ...(safeLink(d.contactUrl, MAX.url) ? { contactUrl: safeLink(d.contactUrl, MAX.url) } : {}),
      };
    }
    case 'comparison': {
      // ADR 0485 — a capability comparison MATRIX (rows = capabilities, columns =
      // named products/families). Every cell is a SHORT authored status string
      // ("✓" / "~" / "✗" / "Leaders only"); the renderer treats each cell as TEXT
      // (no HTML, no links) so there is no stored-XSS surface — the richText model.
      // Bounded on both axes; all authored, in-repo content (no live references to
      // resolve). `highlightColumn` marks the column the renderer emphasizes
      // (our own column); `legend`/`note` carry the key + a dated methodology line.
      const rawCols = Array.isArray(d.columns) ? d.columns : [];
      const columns = rawCols.slice(0, MAX.compareCols)
        .map((c) => cleanContent(c, MAX.label, 'columns'))
        .filter((c) => c.length > 0);
      if (!partial && columns.length === 0) {
        throw new OpenwopError('validation_error', 'comparison.columns needs at least one column header.', 400, {});
      }
      const rawRows = Array.isArray(d.rows) ? d.rows : [];
      const rows = rawRows.slice(0, MAX.compareRows).map((r) => {
        const rr = r as { label?: unknown; cells?: unknown };
        const cells = (Array.isArray(rr.cells) ? rr.cells : [])
          .slice(0, MAX.compareCols)
          // Non-string cells coerce to empty (never "[object Object]"): cells are
          // short authored status tokens, not arbitrary data.
          .map((x) => (typeof x === 'string' ? cleanContent(x, MAX.cell, 'cell') : ''));
        return { label: cleanContent(rr.label, MAX.label, 'label'), cells };
      }).filter((r) => r.label.length > 0);
      if (!partial && rows.length === 0) {
        throw new OpenwopError('validation_error', 'comparison.rows needs at least one capability row.', 400, {});
      }
      const hcRaw = typeof d.highlightColumn === 'number' && Number.isFinite(d.highlightColumn) ? Math.floor(d.highlightColumn) : undefined;
      const highlightColumn = hcRaw !== undefined && hcRaw >= 0 && hcRaw < columns.length ? hcRaw : undefined;
      const legend = optionalCleanContent(d.legend, MAX.text, 'legend');
      const note = optionalCleanContent(d.note, MAX.text, 'note');
      // How the matrix reads. Absent: a MARK matrix (✓ / ~ / ✗ glyphs, the site
      // default). 'text': a TEXT matrix whose cells are sentences (the compare
      // page): roomier cells, mono row heads, a mono footnote. A closed set; an
      // unknown value is refused on the base and dropped from an overlay.
      const styleRaw = typeof d.style === 'string' ? d.style.trim() : '';
      const style = COMPARISON_STYLES.has(styleRaw) ? styleRaw : undefined;
      if (styleRaw && !style && !partial) {
        throw new OpenwopError('validation_error', `comparison.style must be one of: ${[...COMPARISON_STYLES].join(', ')}.`, 400, { field: 'style' });
      }
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(legend ? { legend } : {}),
        ...(note ? { note } : {}),
        ...(!partial || has('columns') ? { columns } : {}),
        ...(!partial || has('rows') ? { rows } : {}),
        ...(highlightColumn !== undefined ? { highlightColumn } : {}),
        ...(style ? { style } : {}),
      };
    }
    case 'faq': {
      // R2-G10 (UX_UPGRADE-site round 2) — an authored Q/A block (2026 pricing/
      // compare/home practice; named-competitor FAQs are what LLM search cites).
      // Plain-text Q/A pairs on the richText model: no HTML, no links, bounded
      // on both axes. The public renderer uses native <details>/<summary>, and
      // the prerender additionally emits a FAQPage JSON-LD block from the SAME
      // validated data.
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = rawItems.slice(0, MAX.faqItems).map((it) => {
        const ii = it as { q?: unknown; a?: unknown };
        // Non-string fields coerce to empty (never "[object Object]") — the
        // comparison-cell rule.
        return {
          q: typeof ii.q === 'string' ? cleanContent(ii.q, MAX.heading, 'q') : '',
          a: typeof ii.a === 'string' ? cleanContent(ii.a, MAX.answer, 'a') : '',
        };
      }).filter((it) => it.q.length > 0 && it.a.length > 0);
      if (!partial && items.length === 0) {
        throw new OpenwopError('validation_error', 'faq.items needs at least one question with an answer.', 400, {});
      }
      // ADR 1063 D2 — two columns on wide screens, the first answer open, and
      // an optional picture under the head. A picture always carries its alt
      // text (the columns rule): an image without one is refused.
      const faqImage = cleanOpaqueToken(d.imageToken, MAX.token);
      const faqAlt = optionalCleanContent(d.alt, MAX.alt, 'alt');
      if (faqImage && !faqAlt) throw new OpenwopError('validation_error', 'faq.alt is required when faq.imageToken is set.', 400, {});
      const faqFrame = faqImage ? optionalCleanContent(d.frameUrl, MAX.label, 'frameUrl') : undefined;
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(!partial || has('items') ? { items } : {}),
        ...(d.columns === 2 ? { columns: 2 } : {}),
        ...(d.openFirst === true ? { openFirst: true } : {}),
        ...(faqImage ? { imageToken: faqImage, alt: faqAlt, ...(faqFrame ? { frameUrl: faqFrame } : {}) } : {}),
        ...tone(),
        ...headStyle(),
      };
    }
    case 'statusTable': case 'dateCalc': case 'conversation': case 'featureIndex': case 'decisionTree': case 'scheduleSim': case 'films': case 'marginCalc': case 'allowanceGap': case 'partyViews': case 'stageChart':
      // ADR 1080 D1–D4, D15, D16; ADR 1082 `films` (held to the `video` URL rule).
      return { ...opt('eyebrow', MAX.eyebrow), ...opt('heading', MAX.heading), ...opt('lede', MAX.lede), ...tone(), ...headStyle(),
        ...buildDesignSectionData(type, d, partial, (v, field) => httpsMediaUrl(v, field, partial, undefined, 'films'), stored) };
    case 'quotes': {
      // R2-G10 — attributed social proof (testimonials). Every 2026 leader puts
      // quantified, ATTRIBUTED quotes near the hero; the fields push authors
      // toward attribution (name/role) without inventing it — an unattributed
      // quote still renders, it just carries no byline. Plain text, bounded.
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = rawItems.slice(0, MAX.quoteItems).map((it) => {
        const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
        const name = typeof ii.name === 'string' ? optionalCleanContent(ii.name, MAX.label, 'name') : undefined;
        const role = typeof ii.role === 'string' ? optionalCleanContent(ii.role, MAX.label, 'role') : undefined;
        return {
          // Non-string quote coerces to empty (never "[object Object]").
          quote: typeof ii.quote === 'string' ? cleanContent(ii.quote, MAX.quote, 'quote') : '',
          ...(name ? { name } : {}),
          ...(role ? { role } : {}),
        };
      }).filter((it) => it.quote.length > 0);
      if (!partial && items.length === 0) {
        throw new OpenwopError('validation_error', 'quotes.items needs at least one quote.', 400, {});
      }
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(!partial || has('items') ? { items } : {}),
        // ADR 1064 P3f — one large quote on the accent colour.
        ...(d.style === 'pull' ? { style: 'pull' } : {}),
        ...tone(),
      };
    }
    case 'video': {
      // ADR 0843 — a narrated film: click-to-play, poster first, nothing loads
      // until asked. Every URL is https-only (httpsMediaUrl); every text field
      // is plain text (never HTML). `title`/`description` also feed the
      // prerender's VideoObject JSON-LD, so both are required on the base.
      const src = httpsMediaUrl(d.src, 'src', partial);
      const poster = httpsMediaUrl(d.poster, 'poster', partial);
      const captions = httpsMediaUrl(d.captions, 'captions', partial);
      const youtubeUrl = httpsMediaUrl(d.youtubeUrl, 'youtubeUrl', partial, YOUTUBE_HOSTS);
      const title = optionalCleanContent(d.title, MAX.title, 'title');
      const description = optionalCleanContent(d.description, MAX.videoDescription, 'description');
      // ADR 1068 D1 — `chipLabel` is the corner play chip's visible words ("Watch
      // the tour"), so `title` can stay the film's name for screen readers and the
      // VideoObject; `caption` is a visible line under the film, also with the chip.
      const chipLabel = optionalCleanContent(d.chipLabel, MAX.label, 'chipLabel');
      const caption = optionalCleanContent(d.caption, MAX.caption, 'caption');
      const lengthRaw = typeof d.length === 'string' ? d.length.trim() : '';
      const length = VIDEO_LENGTH_RE.test(lengthRaw) ? lengthRaw : undefined;
      const uploadRaw = typeof d.uploadDate === 'string' ? d.uploadDate.trim() : '';
      const uploadDate = isValidUploadDate(uploadRaw) ? uploadRaw : undefined;
      // ADR 1032 — an optional second film beside the first, held to the same
      // rules, and a footnote under the pair.
      const film2 = cleanSecondFilm(d.film2, partial);
      const videoNote = optionalCleanContent(d.note, MAX.sectionNote, 'note');
      if (!partial) {
        if (!src) throw new OpenwopError('validation_error', 'video.src is required (an https:// URL to the video file).', 400, { field: 'src' });
        if (!poster) throw new OpenwopError('validation_error', 'video.poster is required (an https:// URL to the poster image).', 400, { field: 'poster' });
        if (!title) throw new OpenwopError('validation_error', 'video.title is required.', 400, { field: 'title' });
        if (!description) throw new OpenwopError('validation_error', 'video.description is required (what the film shows, for screen readers and search).', 400, { field: 'description' });
        if (!length) throw new OpenwopError('validation_error', 'video.length is required as m:ss (e.g. 1:57).', 400, { field: 'length' });
        if (uploadRaw && !uploadDate) throw new OpenwopError('validation_error', 'video.uploadDate must be YYYY-MM-DD or an ISO 8601 datetime with a timezone.', 400, { field: 'uploadDate' });
      }
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(chipLabel ? { chipLabel } : {}),
        ...(caption ? { caption } : {}),
        ...(src ? { src } : {}),
        ...(poster ? { poster } : {}),
        ...(captions ? { captions } : {}),
        ...(length ? { length } : {}),
        ...(uploadDate ? { uploadDate } : {}),
        ...(youtubeUrl ? { youtubeUrl } : {}),
        ...(film2 ? { film2 } : {}),
        ...(videoNote ? { note: videoNote } : {}),
        // ADR 1063 P2b — the play control as a bottom-left chip (title + length).
        ...(d.chip === 'corner' ? { chip: 'corner' } : {}),
        ...tone(),
        ...headStyle(),
      };
    }
    case 'fields': {
      // ADR 0748 — the protocol's open section body (`localized-content.md` §B:
      // "body field shapes are host/section-type-defined") held in the one
      // kernel as flat NAMED TEXT fields. Scalars only, rendered as text
      // everywhere (never HTML, never a link), so an open body on a public page
      // is no wider an injection surface than a `faq` answer. A shape outside
      // that is a 400 — never silently dropped, because the caller chose the
      // keys and must learn which ones this host cannot hold.
      const entries = Object.entries(d);
      if (entries.length > MAX.fieldKeys) {
        throw new OpenwopError('validation_error', `A \`fields\` section holds at most ${MAX.fieldKeys} fields.`, 400, { max: MAX.fieldKeys });
      }
      const out: Record<string, string | number | boolean> = {};
      for (const [k, v] of entries) {
        if (!FIELDS_KEY_RE.test(k)) {
          throw new OpenwopError('validation_error', `Field name \`${k.slice(0, 80)}\` is not allowed (letters, digits and _, starting with a letter).`, 400, { field: k.slice(0, 80) });
        }
        if (typeof v === 'string') out[k] = cleanContent(v, MAX.text, `fields.${k}`);
        else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
        else {
          throw new OpenwopError('validation_error', `Field \`${k}\` must be text, a number or true/false.`, 400, { field: k });
        }
      }
      return out;
    }
    default:
      throw new OpenwopError('validation_error', 'Unknown section type.', 400, {});
  }
}

/** Validate + sanitize the sparse per-locale overlay map (ADR 0064). Keys must
 *  be BCP-47 tags and MUST NOT equal the base locale; each value is cleaned
 *  through the SAME per-type builder as `data` (partial mode). */
/**
 * ADR 0668 D1 (CMSLWF-13) — `pageTenantId` is REQUIRED, not optional, and that is
 * load-bearing.
 *
 * The ADR 0593 §C9 cross-tenant guard was applied to a section's base `data` and NOT to its
 * localization overlays, two lines apart in `validateSection`. An overlay preserves
 * `tenantId` verbatim in partial mode and `resolveSection` merges `{...base, ...exact}`, so
 * the same foreign value the base axis REFUSED was accepted in an `es` overlay and WON at
 * delivery — a reader sending `Accept-Language: es` was served another workspace's entity
 * query.
 *
 * An OPTIONAL parameter would have fixed the page lane and silently no-opped on the
 * shared-section lane, which calls this function directly and passes no tenant. Requiring it
 * makes the COMPILER enumerate the call sites: the ADR's hand-written audit found two, the
 * type system found four. A caller with genuinely no page tenant passes `undefined`
 * explicitly and says why.
 */
/**
 * ADR 1038 D8 (architect review; corrected by the P8 code review and the grading
 * pass) — every list item's styling `state` comes from the base, never from an
 * overlay.
 *
 * An overlay replaces a nested list whole (RFC 0103 §C), so it carries a copy of
 * each item's state taken when it was written: a model asked to translate VALUES
 * translates the enum too ("waiting" → "en attente", which the cleaner drops),
 * a translator can pick another, and a later base edit never reaches it. `state`
 * is presentation, never prose. This runs on the RAW overlay, before the cleaner
 * drops unlabelled items, so positions still match the base; a list whose length
 * differs from the base's is left alone rather than guessed at. Runs on every
 * write (`validateLocalizations`, the AI translate and rewrite lanes, the agent
 * surface), never at serve time: `resolveSection` is the RFC 0103 §C merge every
 * host must share byte for byte. Returns a copy.
 */
export function restoreItemStates(base: unknown, overlay: Record<string, unknown>, type?: string): Record<string, unknown> {
  // ADR 1112 D6 — a section type's own behaviour keys follow the base whatever their JSON type.
  const own = type ? SECTION_ITEM_BASE_KEYS[type] : undefined;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  // A scheduleSim translation is aligned to the base by id first (ADR 1112 D6).
  const copy = type === 'scheduleSim' ? alignSimOverlay(base, structuredClone(overlay)) : structuredClone(overlay);
  const walk = (b: unknown, o: unknown, list = ''): void => {
    if (Array.isArray(b) && Array.isArray(o)) {
      const keys = [...(own?.all ?? []), ...(own?.lists?.[list] ?? [])];
      if (b.length !== o.length) return;
      o.forEach((item, i) => {
        const bi = b[i];
        if (!isObj(item) || !isObj(bi)) return;
        // ADR 1060 widens `state` to every presentation key (ITEM_BASE_KEYS).
        for (const key of ITEM_BASE_KEYS) {
          if (typeof bi[key] === 'string' || typeof bi[key] === 'number') item[key] = bi[key];
          else delete item[key];
        }
        for (const key of keys) {
          if (bi[key] !== undefined) item[key] = structuredClone(bi[key]);
          else delete item[key];
        }
        walk(bi, item);
      });
      return;
    }
    if (isObj(b) && isObj(o)) for (const k of Object.keys(o)) if (Object.hasOwn(b, k)) walk(b[k], o[k], k);
  };
  walk(base, copy);
  return copy;
}

/** An overlay with every list item's `state` removed, for comparing two overlays'
 *  authored content: a state synced from the base is not an author's edit, so it
 *  must not re-stamp an outdated translation as current (ADR 0861 D6). */
function withoutItemStates(v: unknown, type?: string): unknown {
  const own = type ? SECTION_ITEM_BASE_KEYS[type] : undefined;
  const strip = (x: unknown, list = ''): unknown => {
    const synced: readonly string[] = [...ITEM_BASE_KEYS, ...(own?.all ?? []), ...(own?.lists?.[list] ?? [])];
    if (Array.isArray(x)) return x.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return strip(item);
      return strip(Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([k]) => !synced.includes(k))));
    });
    if (typeof x === 'object' && x !== null) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, strip(y, k)]));
    return x;
  };
  return strip(v);
}

function validateLocalizations(type: SectionType, raw: unknown, baseLocale: string, pageTenantId: string | undefined, baseData?: Record<string, unknown>): Record<string, Record<string, unknown>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'section.localizations must be an object.', 400, {});
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [locale, overlay] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_RE.test(locale)) {
      throw new OpenwopError('validation_error', `Invalid localization locale \`${locale}\` (expected BCP-47, e.g. "es", "pt-BR").`, 400, { locale });
    }
    if (locale === baseLocale) {
      throw new OpenwopError('validation_error', 'A localization key MUST NOT be the base locale (the base lives in `data`).', 400, { locale });
    }
    if (typeof overlay !== 'object' || overlay === null || Array.isArray(overlay)) {
      throw new OpenwopError('validation_error', `localizations["${locale}"] must be an object.`, 400, { locale });
    }
    // Same rule as the base axis — equal-or-absent. An overlay naming no `tenantId`
    // inherits the base (the common case, still legal); one that names it must name this
    // page's. Parity, deliberately: a rule stricter than the one it mirrors is its own hazard.
    assertSectionTenant(type, overlay as Record<string, unknown>, pageTenantId);
    // ADR 1038 D8 — list-item states follow the base (see restoreItemStates).
    const raw = baseData ? restoreItemStates(baseData, overlay as Record<string, unknown>, type) : (overlay as Record<string, unknown>);
    out[locale] = buildSectionData(type, raw, true);
  }
  // ADR 1112 D5 — here too, so a shared section's writes are held to the same bytes.
  if (type === 'scheduleSim' && baseData && baseLocale !== '') assertSimSectionBytes(baseData, out);
  return out;
}

/** Sanitize an arbitrary object as a per-locale overlay (ADR 0064 Phase 3) —
 *  the same partial-mode field cleaning as a stored localization, so an AI
 *  translation's output can never carry stored-XSS or an open-redirect. */
export function sanitizeSectionOverlay(type: SectionType, raw: Record<string, unknown>): Record<string, unknown> {
  return buildSectionData(type, raw, true);
}

/** Validate + clean one section against its type schema. Throws on an unknown
 *  type or a missing required field. `baseLocale` scopes localization-key
 *  validation (ADR 0064) — defaults to `'en'` for callers without settings. */
export function validateSection(raw: unknown, baseLocale = 'en', pageTenantId?: string): Section {
  if (typeof raw !== 'object' || raw === null) {
    throw new OpenwopError('validation_error', 'Each section must be an object.', 400, {});
  }
  const r = raw as Record<string, unknown>;
  const type = r.type as SectionType;
  if (!SECTION_TYPES.includes(type)) {
    throw new OpenwopError('validation_error', `section.type must be one of: ${SECTION_TYPES.join(', ')}`, 400, { type: r.type });
  }
  const sectionId = typeof r.sectionId === 'string' && r.sectionId.startsWith('sec:') ? r.sectionId : `sec:${randomUUID()}`;
  // Shared-section reference (ADR 0204 C4): a ref section carries NO own
  // content — its data/localizations come from the shared section at delivery.
  const rawRef = r.ref as { sharedSectionId?: unknown } | undefined;
  if (rawRef && typeof rawRef === 'object') {
    const sharedSectionId = cleanOpaqueToken(rawRef.sharedSectionId, MAX.token);
    if (!sharedSectionId.startsWith('shsec:')) {
      throw new OpenwopError('validation_error', 'section.ref.sharedSectionId must be a `shsec:` id.', 400, {});
    }
    return { sectionId, type, data: {}, ref: { sharedSectionId } };
  }
  const d = (typeof r.data === 'object' && r.data !== null ? r.data : {}) as Record<string, unknown>;
  assertSectionTenant(type, d, pageTenantId); // ADR 0593 §C9 (CMSA-12)
  // The kernel's structure check of a stored row (baseLocale '') keeps its references as they are (ADR 1112 D8).
  const data = buildSectionData(type, d, false, baseLocale === '');
  const localizations = validateLocalizations(type, r.localizations, baseLocale, pageTenantId, data);
  const hasLoc = !!localizations && Object.keys(localizations).length > 0;
  // ADR 1112 D5 (corrected by the P2 measurement): a page saves as one request under the
  // 1 MB JSON limit, and each locale overlay carries a whole copy of the decisions (RFC 0103
  // §C replaces a nested list whole). So the binding limit is the section's bytes, base and
  // overlays together, refused here with the reason rather than as a bare 413 later.
  // Not in the kernel's structure check (baseLocale ''), which re-validates stored pages on
  // system writes (redaction, erasure): those must not fail on a page saved before the limit.
  // `validateLocalizations` already measured base and overlays together (CG-1112-9).
  if (type === 'scheduleSim' && baseLocale !== '' && localizations === undefined) assertSimSectionBytes(data, localizations);
  const aiDrafted = cleanAiDrafted(r.aiDrafted, hasLoc ? localizations : undefined);
  const sourceDigest = cleanSourceDigest(r.sourceDigest, hasLoc ? localizations : undefined);
  return {
    sectionId, type, data,
    ...(hasLoc ? { localizations } : {}),
    ...(aiDrafted ? { aiDrafted } : {}),
    ...(sourceDigest ? { sourceDigest } : {}),
  };
}

/** ADR 0861 D6 — shape-clean a stored digest map (the `cleanAiDrafted` posture:
 *  invalid entries dropped, never fatal; an entry without its overlay dropped). */
function cleanSourceDigest(
  raw: unknown,
  localizations: Record<string, Record<string, unknown>> | undefined,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !localizations) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, d] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_RE.test(locale) || !localizations[locale]) continue;
    if (typeof d === 'string' && /^[0-9a-f]{16}$/.test(d)) out[locale] = d;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Key-sorted canonical JSON — a digest must not move when only key ORDER does. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** ADR 0861 D6 — the digest of what an overlay TRANSLATES: the base values at the
 *  keys it overrides. An image/URL/number the overlay does not override never
 *  makes it outdated (review M2). */
export function sourceDigestOf(base: Record<string, unknown>, overlay: Record<string, unknown>): string {
  const picked = Object.keys(overlay).sort().map((k) => [k, base[k] ?? null]);
  return createHash('sha256').update(canonicalJson(picked)).digest('hex').slice(0, 16);
}

/** ADR 0861 D6 addendum — an overlay whose every overridden key equals the base
 *  value is a COPY of the base (the editor's "Copy from base", or a translation
 *  that echoed its input). It is evidence of nothing, so it is never stamped
 *  `current`; only an explicit confirm can claim it. One differing key is a
 *  translation — partial translation is the editor's claim to make. */
function copiesBase(base: Record<string, unknown>, overlay: Record<string, unknown>): boolean {
  return Object.keys(overlay).every((k) => canonicalJson(overlay[k]) === canonicalJson(base[k]));
}

export type TranslationStatus = 'missing' | 'current' | 'outdated' | 'unknown';

/** ADR 0861 D6 — one locale's translation status for a section (or shared row). */
export function translationStatus(
  section: Pick<Section, 'data' | 'localizations' | 'sourceDigest'>,
  locale: string,
): TranslationStatus {
  const overlay = section.localizations?.[locale];
  if (!overlay || Object.keys(overlay).length === 0) return 'missing';
  const stamp = section.sourceDigest?.[locale];
  if (!stamp) return 'unknown';
  return stamp === sourceDigestOf(section.data, overlay) ? 'current' : 'outdated';
}

/**
 * ADR 0861 D6 — THE stamp. Runs on every page/shared-section content write AFTER
 * validation, against the STORED previous sections:
 *  - an overlay identical to the stored one keeps whatever stamp it had — INCLUDING
 *    none (review H3: a legacy overlay stays `unknown` until someone writes or
 *    confirms it; stamping it here would mark it current on no evidence);
 *  - a new or changed overlay is stamped from the base it is being saved with —
 *    UNLESS it is a copy of that base (`copiesBase`): "Copy from base" is not a
 *    translation, so it stays `unknown` until the text changes or an editor
 *    confirms it (ADR 0861 D6 addendum, owner decision 2026-10-11);
 *  - `confirm` re-stamps one (section, locale) without changing the overlay.
 * Client-sent digests are discarded: only `prev` is read.
 */
/** A stored overlay put through the write path's restore and cleaner, against a base. */
function realignedOverlay(type: SectionType, base: Record<string, unknown>, overlay: Record<string, unknown>): unknown {
  try {
    return buildSectionData(type, restoreItemStates(base, overlay, type), true);
  } catch {
    return undefined; // an old overlay the cleaner refuses is not "unchanged"
  }
}

export function stampSourceDigests<S extends Pick<Section, 'sectionId' | 'data' | 'localizations' | 'sourceDigest'> & { type?: SectionType }>(
  prev: ReadonlyArray<Pick<Section, 'sectionId' | 'localizations' | 'sourceDigest'>> | undefined,
  next: S[],
  confirm?: { sectionId: string; locale: string },
): S[] {
  const before = new Map((prev ?? []).map((s) => [s.sectionId, s] as const));
  return next.map((s) => {
    const out: S = { ...s };
    delete out.sourceDigest;
    if (!s.localizations) return out;
    const old = before.get(s.sectionId);
    const digests: Record<string, string> = {};
    for (const [locale, overlay] of Object.entries(s.localizations)) {
      const confirming = confirm?.sectionId === s.sectionId && confirm.locale === locale;
      // Item states are synced from the base (ADR 1038 D8), not authored, so they
      // are left out of "did the author change this overlay".
      const stored = old?.localizations?.[locale];
      const same = (a: unknown): boolean => JSON.stringify(withoutItemStates(a, s.type)) === JSON.stringify(withoutItemStates(overlay, s.type));
      // ADR 1112 D6 — a scheduleSim translation is realigned to the base it is saved with,
      // so an untouched one changes when the base does: compare the stored one aligned the
      // same way, or a base edit would mark an outdated translation current.
      const unchanged = !!stored && (same(stored) || (s.type === 'scheduleSim' && same(realignedOverlay(s.type, s.data, stored))));
      if (!confirming && unchanged) {
        const carried = old?.sourceDigest?.[locale];
        if (carried) digests[locale] = carried;
      } else if (confirming || !copiesBase(s.data, overlay)) {
        digests[locale] = sourceDigestOf(s.data, overlay);
      }
    }
    if (Object.keys(digests).length > 0) out.sourceDigest = digests;
    return out;
  });
}

/** ADR 0592 §3 — sanitize the per-locale AI-provenance map: locale keys must be
 *  valid BCP-47 AND describe an overlay that actually exists (an orphaned stamp
 *  is dropped, so clearing an overlay clears its provenance for free); values
 *  are bounded opaque strings (ISO instants in practice — not trusted as
 *  anything more). Invalid shapes are DROPPED, never fatal: provenance is
 *  advisory metadata and must not brick a save. */
function cleanAiDrafted(
  raw: unknown,
  localizations: Record<string, Record<string, unknown>> | undefined,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !localizations) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, at] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_RE.test(locale)) continue;
    if (!localizations[locale]) continue; // stamp without an overlay — meaningless
    const v = cleanOpaqueToken(at, 64);
    if (v) out[locale] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function validateSections(raw: unknown, baseLocale = 'en', pageTenantId?: string): Section[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`sections` must be an array.', 400, { field: 'sections' });
  const sections = raw.slice(0, MAX.sections).map((s) => validateSection(s, baseLocale, pageTenantId));
  // ADR 1112 D5 — a page saves as one request under the 1 MB JSON limit. Restoring base keys
  // into translations can make the stored page larger than the request that wrote it, so a
  // page over the limit is refused with its size here, before a later save fails as a bare 413.
  const bytes = Buffer.byteLength(JSON.stringify(sections));
  if (baseLocale !== '' && bytes > PAGE_SECTIONS_MAX_BYTES) { // see validateSection: not in the structure check
    throw new OpenwopError('validation_error', `This page's sections come to ${Math.ceil(bytes / 1000)} kB; a page saves as one request of at most 1 MB. Move a large section to its own page, or remove a translation.`, 400, { reason: 'page_too_large', bytes, limit: PAGE_SECTIONS_MAX_BYTES });
  }
  return sections;
}
/** Room under the 1 MB request body for the rest of a page write (title, SEO, settings). */
const PAGE_SECTIONS_MAX_BYTES = 975_000;

/**
 * ADR 0593 §C9 (`CMSA-12` cross-tenant half) — an entity-reference section may
 * only name its OWN page's tenant.
 *
 * `data.tenantId` is editor-controlled at `workspace:write`, and BOTH delivery
 * lanes take the tenant from it: the prerenderer resolves it server-side into
 * crawler HTML + JSON-LD, and the SPA fetches it client-side straight from the
 * section. A read-side guard alone would therefore close the crawler lane and
 * leave the human one open — crawler ≠ human, which is the cloaking mismatch
 * the resolver's own comment says it exists to avoid. Refusing at the WRITE
 * closes both with one rule, and costs nothing in entity authority: the
 * entities feature keeps every bit of its own published/publicRead gating.
 *
 * Applied only where a page tenant is known (create/update). The ADR 0408
 * kernel field-validator path has no page context and is unchanged — recorded
 * because an unstated exemption is how the last three of these got missed.
 */
function assertSectionTenant(type: SectionType, data: Record<string, unknown>, pageTenantId?: string): void {
  if (!pageTenantId) return;
  if (type !== 'entityList' && type !== 'entityDetail') return;
  const named = data.tenantId;
  if (typeof named !== 'string' || named === '' || named === pageTenantId) return;
  throw new OpenwopError(
    'validation_error',
    `A \`${type}\` section may only reference its own workspace — \`tenantId\` must be this page's workspace.`,
    400,
    { field: 'tenantId', section: type },
  );
}

// ── Pages ─────────────────────────────────────────────────────────────────

export interface PageListFilter {
  /** Case-insensitive substring match on title + slug. */
  q?: string;
  tag?: string;
  status?: PageStatus;
  /** ADR 0391 — narrow to posts (`'post'`) or ordinary pages (`'page'`,
   *  which matches the absent-field legacy rows). Narrows, never widens. */
  kind?: 'page' | 'post';
  /** ADR 0391 — narrow to one primary category (posts). */
  category?: string;
  /** ADR 0391 — narrow to one byline principal (posts). */
  authorId?: string;
  /** ADR 0392 — narrow to a content collection. `'docs'` = docs pages only;
   *  `'site'` = everything that is NOT a docs page (the marketing/site default
   *  set); absent = all pages. Never widens visibility (still tenant+org-scoped). */
  collection?: CmsContentCollection | 'site';
}

/** List an org's pages. `filter` only NARROWS the already tenant+org-scoped set
 *  (ADR 0206 B3) — filtering never widens visibility, so there is no IDOR
 *  surface in the query params. */
export async function listPages(tenantId: string, orgId: string, filter?: PageListFilter): Promise<Page[]> {
  // Kernel-backed: a per-type per-tenant slice, no longer a cross-tenant scan.
  let out = (await pages.listForTenant(tenantId)).filter((p) => p.tenantId === tenantId && p.orgId === orgId);
  if (filter?.status) out = out.filter((p) => p.status === filter.status);
  if (filter?.kind) {
    // Absent `kind` means an ordinary page (legacy rows predate the facet).
    out = out.filter((p) => (p.kind ?? 'page') === filter.kind);
  }
  if (filter?.category) out = out.filter((p) => p.category === filter.category);
  if (filter?.authorId) out = out.filter((p) => (p.authorId ?? p.createdBy) === filter.authorId);
  if (filter?.collection === 'docs') out = out.filter((p) => p.collection === 'docs');
  else if (filter?.collection === 'site') out = out.filter((p) => p.collection !== 'docs');
  if (filter?.tag) {
    const tag = filter.tag.toLowerCase();
    out = out.filter((p) => (p.tags ?? []).includes(tag));
  }
  if (filter?.q) {
    const q = filter.q.toLowerCase();
    out = out.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
  }
  return out;
}

/** Clean an incoming `tags` value like the media library does (shared cleaner):
 *  lowercased, bounded, deduped, capped. */
export function cleanPageTags(raw: unknown): string[] {
  return cleanTagList(raw, { maxTags: MAX.tags, maxLen: MAX.tag });
}

/** ADR 1049 — the closed set of public-site nav groups a page may join.
 *  `resources` (guides, help, changelog) added 2026-11-10 for DeckTalk. */
export const SITE_NAV_GROUPS = ['product', 'audience', 'resources', 'trust', 'company', 'legal'] as const;
export type SiteNavGroup = (typeof SITE_NAV_GROUPS)[number];

/** ADR 1049 — a page's public-site nav placement (every field optional). */
export interface PageSiteNav {
  group?: SiteNavGroup;
  /** Short menu label overriding the page title (≤ 40). */
  label?: string;
  /** One-line blurb under the label in the mega menu (≤ 90). */
  description?: string;
  /** Integer 0–999; lower sorts first within the group. */
  order?: number;
  /** Promote into the header's always-visible primary nav. */
  primary?: boolean;
  /** ADR 1056 — make this page the grouped footer's call to action: the
   *  button label (≤ 40) under the brand column. The first page (group, then
   *  order) that sets it wins. */
  cta?: string;
  /** ADR 1056 — also list this page among the grouped footer's bottom-bar
   *  utility links (it stays in its group column too). */
  utility?: boolean;
  /** ADR 1062 D2 — feature this page as the mega menu's card: a short eyebrow
   *  ("New film"), a title, a meta line ("3:57") and an optional `href` (a
   *  `#fragment` on this page or a safe internal path; default: the page). The
   *  first published page (home included) that sets it wins. */
  featured?: SiteNavFeatured;
  /** ADR 1105 D11 — the heading of this page's `group` in the menu and the
   *  grouped footer (≤ 40), in place of the stock one ("Product", …). The first
   *  page in the group (by order, then label) that sets it wins. Needs `group`. */
  groupLabel?: string;
  /** ADR 1113 — extra menu entries this page stores for destinations that are
   *  not CMS pages (an app route such as `/discover`, or a `#fragment` on this
   *  page). Each one is a full nav entry in its OWN `group`, so a site with
   *  two published pages can still fill four columns. At most 12 per page. */
  links?: SiteNavLink[];
}

/** ADR 1113 — one authored nav entry. `href` is a safe internal path or a
 *  `#fragment` on the owning page, never an external URL. */
export interface SiteNavLink { label: string; href: string; group: SiteNavGroup; description?: string; order?: number; groupLabel?: string }

export interface SiteNavFeatured { eyebrow?: string; title: string; meta?: string; href?: string }

const SITE_NAV_MAX = { label: 40, description: 90, cta: 40, groupLabel: 40, order: 999, featuredEyebrow: 30, featuredTitle: 60, featuredMeta: 20, featuredHref: 200, links: 12, linkHref: 200 } as const;

/** ADR 1062 D2 — validate `siteNav.featured`. A title is required; `href` is a
 *  same-page fragment or a safe internal path, never an external URL (the card
 *  sits in the site's own navigation). Anything else is a 400, never coerced. */
function cleanSiteNavFeatured(raw: unknown): SiteNavFeatured | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`siteNav.featured` must be an object.', 400, { field: 'siteNav.featured' });
  }
  const f = raw as Record<string, unknown>;
  const text = (k: 'eyebrow' | 'title' | 'meta', max: number): string | undefined => {
    const v = f[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new OpenwopError('validation_error', `\`siteNav.featured.${k}\` must be a string.`, 400, { field: `siteNav.featured.${k}` });
    return optionalCleanContent(v, max, `siteNav.featured.${k}`) || undefined;
  };
  const title = text('title', SITE_NAV_MAX.featuredTitle);
  if (!title) throw new OpenwopError('validation_error', '`siteNav.featured.title` is required.', 400, { field: 'siteNav.featured.title' });
  const eyebrow = text('eyebrow', SITE_NAV_MAX.featuredEyebrow);
  const meta = text('meta', SITE_NAV_MAX.featuredMeta);
  let href: string | undefined;
  if (f.href !== undefined && f.href !== null && f.href !== '') {
    const h = typeof f.href === 'string' ? f.href.trim() : '';
    if (!h || h.length > SITE_NAV_MAX.featuredHref || !(isFragmentHref(h) || isInternalHref(h))) {
      throw new OpenwopError('validation_error', '`siteNav.featured.href` must be a `#fragment` or an internal path.', 400, { field: 'siteNav.featured.href' });
    }
    href = h;
  }
  return { ...(eyebrow ? { eyebrow } : {}), title, ...(meta ? { meta } : {}), ...(href ? { href } : {}) };
}

/** ADR 1113 — validate `siteNav.links`. Each entry needs a label, an href (a
 *  safe internal path or a `#fragment`) and a group; `description`, `order` and
 *  `groupLabel` follow the page-level rules. Anything else is a 400 naming the
 *  entry, never coerced; an empty list is absent. */
function cleanSiteNavLinks(raw: unknown): SiteNavLink[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`siteNav.links` must be an array.', 400, { field: 'siteNav.links' });
  if (raw.length > SITE_NAV_MAX.links) {
    throw new OpenwopError('validation_error', `\`siteNav.links\` holds at most ${SITE_NAV_MAX.links} entries.`, 400, { field: 'siteNav.links', max: SITE_NAV_MAX.links });
  }
  const out = raw.map((entry, i): SiteNavLink => {
    const field = `siteNav.links[${i}]`;
    const bad = (k: string, why: string): never => { throw new OpenwopError('validation_error', `\`${field}${k ? `.${k}` : ''}\` ${why}`, 400, { field: `${field}${k ? `.${k}` : ''}` }); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) bad('', 'must be an object.');
    const e = entry as Record<string, unknown>;
    const text = (k: 'label' | 'description' | 'groupLabel', max: number): string | undefined => {
      const v = e[k];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string') bad(k, 'must be a string.');
      return optionalCleanContent(v as string, max, `${field}.${k}`) || undefined;
    };
    const label = text('label', SITE_NAV_MAX.label);
    if (!label) bad('label', 'is required.');
    const h = typeof e.href === 'string' ? e.href.trim() : '';
    if (!h || h.length > SITE_NAV_MAX.linkHref || !(isFragmentHref(h) || isInternalHref(h))) bad('href', 'must be a `#fragment` or an internal path.');
    if (typeof e.group !== 'string' || !(SITE_NAV_GROUPS as readonly string[]).includes(e.group)) bad('group', `must be one of ${SITE_NAV_GROUPS.join(', ')}.`);
    let order: number | undefined;
    if (e.order !== undefined && e.order !== null) {
      if (typeof e.order !== 'number' || !Number.isInteger(e.order) || e.order < 0 || e.order > SITE_NAV_MAX.order) bad('order', `must be an integer from 0 to ${SITE_NAV_MAX.order}.`);
      order = e.order as number;
    }
    const description = text('description', SITE_NAV_MAX.description);
    const groupLabel = text('groupLabel', SITE_NAV_MAX.groupLabel);
    return {
      label: label as string, href: h, group: e.group as SiteNavGroup,
      ...(description ? { description } : {}), ...(order !== undefined ? { order } : {}), ...(groupLabel ? { groupLabel } : {}),
    };
  });
  return out.length > 0 ? out : undefined;
}

/** ADR 1049 — validate a `siteNav` value. Unknown keys are dropped; strings are
 *  trimmed + capped through the CONTENT lane (published text, never rewritten —
 *  a credential-shaped token is a refusal); a bad `group`, a non-integer or
 *  out-of-range `order`, or a non-boolean `primary` is a 400 (never coerced);
 *  an object with nothing left is `undefined` (absent = ADR 0486 placement). */
export function cleanSiteNav(raw: unknown): PageSiteNav | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`siteNav` must be an object.', 400, { field: 'siteNav' });
  }
  const r = raw as Record<string, unknown>;
  const out: PageSiteNav = {};
  if (r.group !== undefined && r.group !== null && r.group !== '') {
    if (typeof r.group !== 'string' || !(SITE_NAV_GROUPS as readonly string[]).includes(r.group)) {
      throw new OpenwopError('validation_error', `\`siteNav.group\` must be one of ${SITE_NAV_GROUPS.join(', ')}.`, 400, { field: 'siteNav.group', allowed: [...SITE_NAV_GROUPS] });
    }
    out.group = r.group as SiteNavGroup;
  }
  if (r.label !== undefined && r.label !== null) {
    if (typeof r.label !== 'string') throw new OpenwopError('validation_error', '`siteNav.label` must be a string.', 400, { field: 'siteNav.label' });
    const label = optionalCleanContent(r.label, SITE_NAV_MAX.label, 'siteNav.label');
    if (label) out.label = label;
  }
  if (r.description !== undefined && r.description !== null) {
    if (typeof r.description !== 'string') throw new OpenwopError('validation_error', '`siteNav.description` must be a string.', 400, { field: 'siteNav.description' });
    const description = optionalCleanContent(r.description, SITE_NAV_MAX.description, 'siteNav.description');
    if (description) out.description = description;
  }
  if (r.order !== undefined && r.order !== null) {
    if (typeof r.order !== 'number' || !Number.isInteger(r.order) || r.order < 0 || r.order > SITE_NAV_MAX.order) {
      throw new OpenwopError('validation_error', `\`siteNav.order\` must be an integer from 0 to ${SITE_NAV_MAX.order}.`, 400, { field: 'siteNav.order' });
    }
    out.order = r.order;
  }
  if (r.primary !== undefined && r.primary !== null) {
    if (typeof r.primary !== 'boolean') throw new OpenwopError('validation_error', '`siteNav.primary` must be a boolean.', 400, { field: 'siteNav.primary' });
    if (r.primary) out.primary = true;
  }
  // ADR 1056 — the footer CTA label and the bottom-bar utility flag, held to
  // the same rules as `label` and `primary`.
  if (r.cta !== undefined && r.cta !== null) {
    if (typeof r.cta !== 'string') throw new OpenwopError('validation_error', '`siteNav.cta` must be a string.', 400, { field: 'siteNav.cta' });
    const cta = optionalCleanContent(r.cta, SITE_NAV_MAX.cta, 'siteNav.cta');
    if (cta) out.cta = cta;
  }
  if (r.utility !== undefined && r.utility !== null) {
    if (typeof r.utility !== 'boolean') throw new OpenwopError('validation_error', '`siteNav.utility` must be a boolean.', 400, { field: 'siteNav.utility' });
    if (r.utility) out.utility = true;
  }
  const featured = cleanSiteNavFeatured(r.featured); // ADR 1062 D2
  if (featured) out.featured = featured;
  // ADR 1105 D11 — an authored group heading. It names the page's group, so a
  // page with no group cannot carry one (a 400, not a silent drop).
  if (r.groupLabel !== undefined && r.groupLabel !== null) {
    if (typeof r.groupLabel !== 'string') throw new OpenwopError('validation_error', '`siteNav.groupLabel` must be a string.', 400, { field: 'siteNav.groupLabel' });
    const groupLabel = optionalCleanContent(r.groupLabel, SITE_NAV_MAX.groupLabel, 'siteNav.groupLabel');
    if (groupLabel) {
      if (!out.group) throw new OpenwopError('validation_error', '`siteNav.groupLabel` needs `siteNav.group`: it names that group.', 400, { field: 'siteNav.groupLabel' });
      out.groupLabel = groupLabel;
    }
  }
  const links = cleanSiteNavLinks(r.links); // ADR 1113
  if (links) out.links = links;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ADR 0391 — validate the optional post facets. `kind` is a closed enum;
 *  `authorId` an opaque principal token; `category` slugified (it is a URL
 *  segment on the public archive). Invalid values are a 400, never coerced. */
export function cleanPostFacets(raw: { kind?: unknown; authorId?: unknown; category?: unknown }): Pick<Page, 'kind' | 'authorId' | 'category'> {
  const out: Pick<Page, 'kind' | 'authorId' | 'category'> = {};
  if (raw.kind !== undefined) {
    if (raw.kind !== 'page' && raw.kind !== 'post') {
      throw new OpenwopError('validation_error', "`kind` must be 'page' or 'post'.", 400, { kind: raw.kind });
    }
    out.kind = raw.kind;
  }
  if (raw.authorId !== undefined) {
    const cleaned = cleanOpaqueToken(raw.authorId, MAX.token);
    if (cleaned) out.authorId = cleaned;
  }
  if (raw.category !== undefined) {
    const cleaned = slugify(typeof raw.category === 'string' ? raw.category : '');
    if (cleaned) out.category = cleaned;
  }
  return out;
}

export async function getPage(tenantId: string, orgId: string, pageId: string): Promise<Page | null> {
  const p = await pages.get(tenantId, pageId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

async function slugSet(tenantId: string, orgId: string, exceptPageId?: string): Promise<Set<string>> {
  const all = await listPages(tenantId, orgId);
  return new Set(all.filter((p) => p.pageId !== exceptPageId).map((p) => p.slug));
}

export async function createPage(input: { tenantId: string; orgId: string; title: string; slug?: string; sections?: unknown; tags?: unknown; createdBy: string; pageId?: string; baseLocale?: string; kind?: unknown; authorId?: unknown; category?: unknown; collection?: 'docs'; docsNav?: string; siteNav?: unknown; createOnly?: boolean }): Promise<Page> {
  // A FIXED pageId (host-level seeds, ADR 0027) makes creation idempotent: if the
  // row already exists, return it — so a concurrent cross-instance first-boot seed
  // converges on ONE page instead of a `home` + `home-2` duplicate.
  //
  // ADR 0859 D1 (#4515) — the prior read is RAW (tenant + id, the kernel key), never
  // the org-filtered `getPage`. Through `getPage` another org's page read as absent and
  // the write below replaced it: a run in org B could take org A's approved, live page.
  // Another org's id is a uniform 409 that names nobody (the ADR 0848 D1 wording).
  const ownedOrConflict = (prior: Page): Page => {
    if (prior.orgId !== input.orgId) throw new OpenwopError('conflict', 'That id is already in use.', 409, { pageId: input.pageId });
    // ADR 0754 — idempotent-return is for seeds; a create-only caller asked for a
    // NEW page, and handing it a concurrent writer's page as its own is an overwrite
    // by another name.
    if (input.createOnly) throw new OpenwopError('conflict', `A page with id \`${input.pageId}\` already exists.`, 409, { pageId: input.pageId });
    return prior;
  };
  if (input.pageId) {
    const prior = await pages.get(input.tenantId, input.pageId);
    if (prior) return ownedOrConflict(prior);
  }
  const existing = await listPages(input.tenantId, input.orgId);
  if (existing.length >= MAX.perOrgPages) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgPages} pages.`, 409, { max: MAX.perOrgPages });
  }
  const title = cleanContent(input.title, MAX.title, 'title', 'Untitled page');
  const taken = new Set(existing.map((p) => p.slug));
  const slug = uniqueSlug(input.slug ? slugify(input.slug) : title, taken, 'page');
  const ts = nowIso();
  const tags = cleanPageTags(input.tags);
  const facets = cleanPostFacets(input);
  const siteNav = cleanSiteNav(input.siteNav); // ADR 1049
  const page: Page = {
    pageId: input.pageId ?? `page:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title,
    slug,
    status: 'draft',
    sections: stampSourceDigests(undefined, validateSections(input.sections, input.baseLocale ?? 'en', input.tenantId)),
    ...(tags.length > 0 ? { tags } : {}),
    ...facets,
    ...(input.collection === 'docs' ? { collection: 'docs' as const } : {}),
    ...(input.collection === 'docs' && typeof input.docsNav === 'string' && input.docsNav ? { docsNav: cleanString(input.docsNav, MAX.slug, '') } : {}),
    ...(siteNav ? { siteNav } : {}),
    version: 1,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  // ADR 0754 — the protocol lane creates, never overwrites: a row that appeared
  // under this id after the caller's checks is a 409 here, not a silent update.
  // ADR 0859 D1 — and so does every other lane: a create never overwrites. A row
  // that appeared in the window is re-read and judged by the same rule as above,
  // so a same-org seed racing itself still converges on one page.
  try {
    await pages.create(page);
  } catch (err) {
    if (!(err instanceof OpenwopError && err.code === 'conflict') || !input.pageId) throw err;
    const raced = await pages.get(input.tenantId, input.pageId);
    if (!raced) throw err;
    return ownedOrConflict(raced);
  }
  await syncPageUsage(page);
  return page;
}

export async function updatePage(
  tenantId: string,
  orgId: string,
  pageId: string,
  patch: { title?: string; slug?: string; sections?: unknown; tags?: unknown; baseLocale?: string; kind?: unknown; authorId?: unknown; category?: unknown; docsNav?: string; siteNav?: unknown },
  updatedBy: string,
  // ADR 0592 §1 (CMSL-1) — OPTIONAL optimistic-concurrency pin, enforced HERE
  // (the service read is the authoritative one, so every caller that sends the
  // pin is covered — route, submit auto-translate merge, workflow surface).
  // Optional on purpose: making it required would break clone/agent/API
  // callers in one move; the SPA editor always sends it. The house pattern is
  // the approval pin (contentApproval.ts) + the commerce order-row CAS.
  //
  // ADR 0836 — `authorize` runs on THIS read, the one the CAS then compares
  // against (D2): status-dependent authority (editor on a draft, admin on a live
  // page, gate refusal, translator narrowing) is decided on the row actually
  // written. `transitionPage` never bumps `version`, so the pin alone cannot see
  // a draft become published in between. `keepSchedule` (D3) re-pins a pending
  // scheduled publish to the new version; without it the edit cancels the
  // schedule, because the schedule was set by someone who saw other content.
  // `keepSchedule` may be a probe, evaluated only when the page HAS a pending
  // schedule, so the common (unscheduled) save pays no extra authority read.
  // `confirmSource` (ADR 0861 D6) — re-stamp one overlay's source digest ("still
  // accurate") in the same validated, version-bumping write.
  opts?: { expectedVersion?: number; authorize?: (current: Page) => Promise<void>; keepSchedule?: boolean | ((current: Page) => Promise<boolean>); confirmSource?: { sectionId: string; locale: string } },
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (opts?.authorize) await opts.authorize(p);
  if (opts?.expectedVersion !== undefined && p.version !== opts.expectedVersion) {
    throw new OpenwopError(
      'conflict',
      `The page changed since it was loaded (version ${p.version}, expected ${opts.expectedVersion}) — reload and reapply your edits, or overwrite explicitly.`,
      409,
      { pageId, currentVersion: p.version, expectedVersion: opts.expectedVersion },
    );
  }
  const next: Page = { ...p, updatedBy, updatedAt: nowIso(), version: p.version + 1 };
  // ADR 0391 post facets — validated; explicit null clears (facet removal).
  const facets = cleanPostFacets(patch);
  if (facets.kind !== undefined) next.kind = facets.kind;
  if (patch.authorId === null) delete next.authorId;
  else if (facets.authorId !== undefined) next.authorId = facets.authorId;
  if (patch.category === null) delete next.category;
  else if (facets.category !== undefined) next.category = facets.category;
  if (patch.title !== undefined) next.title = cleanContent(patch.title, MAX.title, 'title', p.title);
  if (patch.slug !== undefined) {
    const desired = slugify(patch.slug);
    const taken = await slugSet(tenantId, orgId, pageId);
    next.slug = uniqueSlug(desired, taken, 'page');
  }
  if (patch.sections !== undefined) next.sections = stampSourceDigests(p.sections, validateSections(patch.sections, patch.baseLocale ?? 'en', tenantId), opts?.confirmSource);
  if (patch.tags !== undefined) {
    const tags = cleanPageTags(patch.tags);
    if (tags.length > 0) next.tags = tags;
    else delete next.tags;
  }
  // ADR 0392 — docs nav ordering (only meaningful on a docs-collection page).
  if (patch.docsNav !== undefined && p.collection === 'docs') {
    const nav = cleanString(patch.docsNav, MAX.slug, '');
    if (nav) next.docsNav = nav; else delete next.docsNav;
  }
  // ADR 1049 — public-site nav placement; explicit null (or an object that
  // cleans to nothing) clears it, like `category`.
  if (patch.siteNav !== undefined) {
    const siteNav = cleanSiteNav(patch.siteNav);
    if (siteNav) next.siteNav = siteNav; else delete next.siteNav;
  }
  // ADR 0836 D3 — a pending scheduled publish was set against `p.version`.
  let scheduleCleared = false;
  if (p.scheduledPublishAt) {
    const keep = typeof opts?.keepSchedule === 'function' ? await opts.keepSchedule(p) : Boolean(opts?.keepSchedule);
    if (keep) {
      next.scheduledPublishVersion = next.version;
    } else {
      delete next.scheduledPublishAt;
      delete next.scheduledPublishVersion;
      scheduleCleared = true;
    }
  }
  // An unpublish on a not-yet-live page exists only as the end of the embargo
  // pair (ADR 0204 C2b); with its publish cancelled it is an orphan no lane
  // would fire and no control would show. Cancel it in the same write.
  const pairedUnpublishCleared = scheduleCleared && p.status !== 'published' && Boolean(p.scheduledUnpublishAt);
  if (pairedUnpublishCleared) delete next.scheduledUnpublishAt;
  // ADR 0836 D9 — an in-place edit of a PUBLISHED page is a publish of the new
  // content without a transition, so it meets the same blockers.
  if (p.status === 'published') { assertNoPublishBlockers(next); await assertResolvedPageFits(next); }
  await casPage(p, next);
  // ADR 0836 D1 — side effects only after the write landed: a lost race used to
  // leave a redirect to a slug the page never got. The write is committed, so a
  // failure below is logged rather than thrown (the transitionPage reasoning).
  // Renaming a PUBLISHED page's slug leaves a redirect so old links survive.
  // COLLAPSE CHAINS (code-review #4): repoint any redirect that pointed at the
  // OLD slug to the new one (so a multi-rename A→B→C still resolves A in one
  // hop), and drop a stale redirect whose fromSlug now equals the new slug.
  if (next.slug !== p.slug && p.status === 'published') {
    try {
      const all = await redirects.list();
      for (const r of all) {
        if (r.tenantId !== tenantId || r.orgId !== orgId) continue;
        if (r.toSlug === p.slug) await redirects.put({ ...r, toSlug: next.slug });
        if (r.fromSlug === next.slug) await redirects.delete(r.redirectId);
      }
      await redirects.put({
        redirectId: `redir:${randomUUID()}`,
        tenantId,
        orgId,
        fromSlug: p.slug,
        toSlug: next.slug,
        createdAt: nowIso(),
      });
    } catch (err) {
      log.error('cms_redirect_failed_after_commit', { tenantId, pageId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (scheduleCleared) {
    await dropMarker(scheduledMarkers, tenantId, orgId, pageId).catch((err: unknown) => log.warn('cms_marker_drop_failed', { pageId, error: err instanceof Error ? err.message : String(err) }));
    recordCmsAction('schedule-cleared', next, updatedBy, { reason: 'content-changed' });
  }
  if (pairedUnpublishCleared) {
    await dropMarker(scheduledUnpublishMarkers, tenantId, orgId, pageId).catch((err: unknown) => log.warn('cms_marker_drop_failed', { pageId, error: err instanceof Error ? err.message : String(err) }));
    recordCmsAction('schedule-unpublish-cleared', next, updatedBy, { reason: 'content-changed' });
  }
  // ADR 0392 grade pass D2 — an in-place edit of a PUBLISHED page (an admin
  // capability; editors must unpublish first) changes live public content
  // without a transition, so it must re-fire the lifecycle or derived stores
  // (the docs KB) go stale until the next unpublish→republish cycle.
  if (next.status === 'published') {
    void fireCmsPageLifecycle({
      tenantId: next.tenantId, orgId: next.orgId, pageId: next.pageId, slug: next.slug,
      title: next.title, ...(next.collection ? { collection: next.collection } : {}), event: 'published',
    });
  }
  await syncPageUsage(next);
  return next;
}

// ── Protocol content façade (ADR 0748, RFC 0103 §D / RFC 0206) ────────────
// The protocol `/content/*` admin ops are a VIEW of these same kernel rows, not
// a second store. Two id spaces meet here, and each rule below exists because
// the CMS convention would otherwise silently change what the caller addressed.

/** A protocol `pageId` / `sectionId`: bounded, and safe as a storage key. */
export const PROTOCOL_CONTENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROTOCOL_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** A protocol SECTION id: the content-id grammar, minus the CMS `sec:` prefix.
 *  `toCmsSectionId` is idempotent on that prefix, so `hero` and `sec:hero` would
 *  both address `sec:hero` — two protocol ids for one stored section, and a
 *  `sectionOrder` holding both passed the raw-id duplicate check and stored two
 *  sections under one id (ADR 0755, WIT-CNT-7). The projection never emits the
 *  prefix, so no id a client read back from this host is refused. */
export function isProtocolSectionId(id: string): boolean {
  return PROTOCOL_CONTENT_ID_RE.test(id) && !id.startsWith('sec:');
}

/** CMS section ids carry a `sec:` prefix (`validateSection` re-mints any other
 *  id), protocol ids do not: `hero` ↔ `sec:hero`, both directions. */
export function toCmsSectionId(id: string): string {
  return id.startsWith('sec:') ? id : `sec:${id}`;
}
export function toProtocolSectionId(id: string): string {
  return id.startsWith('sec:') ? id.slice(4) : id;
}

/**
 * `POST /content/pages`. Refuses where `createPage` would quietly adapt, because
 * on the protocol the caller chose both keys and the slug IS the delivery
 * address: an existing `pageId` is 409 (never the prior row returned as if
 * created), and a taken slug is 409 (never `slug-2`). `sectionOrder` becomes one
 * empty `fields` section per id, in order, so render order lives in the one CMS
 * order rather than a second field. Always created as a DRAFT; the caller
 * publishes through `transitionPage`, which owns the publish side-effects.
 */
export async function createProtocolPage(input: {
  tenantId: string; orgId: string; pageId: unknown; slug: unknown; name: unknown; sectionOrder: unknown;
  createdBy: string; baseLocale: string;
}): Promise<Page> {
  const pageId = typeof input.pageId === 'string' ? input.pageId : '';
  if (!PROTOCOL_CONTENT_ID_RE.test(pageId)) {
    throw new OpenwopError('validation_error', '`pageId` must be 1–128 characters of letters, digits and `._:-`.', 400, { field: 'pageId' });
  }
  const slug = typeof input.slug === 'string' ? input.slug : '';
  // `slugify` is the CMS normaliser; a slug it would rewrite is not one this host
  // can serve at the address the caller asked for.
  if (!PROTOCOL_SLUG_RE.test(slug) || slugify(slug) !== slug) {
    throw new OpenwopError('validation_error', `\`slug\` must match ^[a-z][a-z0-9-]*$ (at most ${MAX.slugChars} characters, no leading/trailing or doubled hyphen).`, 400, { field: 'slug' });
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new OpenwopError('validation_error', '`name` is required.', 400, { field: 'name' });
  }
  if (!Array.isArray(input.sectionOrder)) {
    throw new OpenwopError('validation_error', '`sectionOrder` must be an array of section ids.', 400, { field: 'sectionOrder' });
  }
  const order: string[] = [];
  for (const raw of input.sectionOrder as unknown[]) {
    if (typeof raw !== 'string' || !isProtocolSectionId(raw)) {
      throw new OpenwopError('validation_error', 'Each `sectionOrder` entry must be 1–128 characters of letters, digits and `._:-`, not starting with `sec:`.', 400, { field: 'sectionOrder' });
    }
    if (order.includes(raw)) throw new OpenwopError('validation_error', `Section \`${raw}\` appears twice in \`sectionOrder\`.`, 400, { field: 'sectionOrder' });
    order.push(raw);
  }
  if (order.length > MAX.sections) {
    throw new OpenwopError('validation_error', `A page holds at most ${MAX.sections} sections.`, 400, { max: MAX.sections });
  }
  // TENANT-wide, not org-scoped (ADR 0755, WIT-CNT-1). The kernel row key is
  // (tenant type, pageId) with no org in it, so `getPage`'s org filter read a
  // sibling org's page as absent and `createPage`'s `pages.put` then OVERWROTE it
  // — moved to this org, demoted to draft, sections emptied: a live page in
  // another org taken down by a caller with no authority there. Any row under
  // this id is a 409, whichever org holds it; the message names no org.
  if (await pages.get(input.tenantId, pageId)) {
    throw new OpenwopError('conflict', `A page with id \`${pageId}\` already exists.`, 409, { pageId });
  }
  if ((await slugSet(input.tenantId, input.orgId)).has(slug)) {
    throw new OpenwopError('conflict', `The slug \`${slug}\` is already in use.`, 409, { slug });
  }
  const page = await createPage({
    tenantId: input.tenantId,
    orgId: input.orgId,
    pageId,
    slug,
    title: input.name,
    sections: order.map((id) => ({ sectionId: toCmsSectionId(id), type: 'fields', data: {} })),
    createdBy: input.createdBy,
    baseLocale: input.baseLocale,
    createOnly: true,
  });
  // ADR 0754 — the slug check above is a read; two concurrent creates both pass
  // it. Post-write re-check: if the slug is not ours ALONE (another page holds it,
  // or `createPage` renamed ours because one landed in between), withdraw ours and
  // 409. Both racers may withdraw — a retry then succeeds — but never two pages on
  // one slug and never a silent rename, which is the "409, never renamed" promise.
  const holders = (await listPages(input.tenantId, input.orgId)).filter((p) => p.slug === slug && p.pageId !== page.pageId);
  if (page.slug !== slug || holders.length > 0) {
    await deletePage(input.tenantId, input.orgId, page.pageId);
    throw new OpenwopError('conflict', `The slug \`${slug}\` is already in use.`, 409, { slug });
  }
  return page;
}

/**
 * `PUT /content/pages/{pageId}/sections/{sectionId}` — `locale == baseLocale`
 * REPLACES the section's base `data`, any other locale replaces
 * `localizations[locale]` (PUT semantics). A section the page does not hold is
 * appended as a `fields` section. An existing typed section keeps its closed
 * schema: fields outside it are dropped, as in the editor, and the returned
 * record shows exactly what was kept.
 *
 * `authorize` runs against the FRESH page on every attempt, so the caller's
 * status-dependent authority (draft = editor, live = admin, gated = refused)
 * is decided on the row actually written, not on an earlier read. Version-pinned
 * through `updatePage` with ONE bounded retry — the `updateSectionDraft` shape.
 */
export async function upsertProtocolSection(input: {
  tenantId: string; orgId: string; pageId: string; sectionId: string; locale: string;
  data: Record<string, unknown>; baseLocale: string; actor: string;
  authorize: (page: Page) => Promise<void>;
}): Promise<{ page: Page; section: Section } | null> {
  if (!isProtocolSectionId(input.sectionId)) {
    throw new OpenwopError('validation_error', '`sectionId` must be 1–128 characters of letters, digits and `._:-`, not starting with `sec:`.', 400, { field: 'sectionId' });
  }
  const cmsId = toCmsSectionId(input.sectionId);
  const isBase = input.locale === input.baseLocale;
  for (let attempt = 0; ; attempt += 1) {
    const page = await getPage(input.tenantId, input.orgId, input.pageId);
    if (!page) return null;
    await input.authorize(page);
    const existing = page.sections.find((s) => s.sectionId === cmsId);
    // A shared-section reference carries no content of its own (ADR 0204 C4):
    // `validateSection` would keep the ref and DROP the write, answering 200 for
    // text that never landed. Detaching is an editor decision, not a side effect.
    if (existing?.ref) {
      throw new OpenwopError('conflict', 'This section inherits a shared section; detach it in the editor before writing its content.', 409, { sectionId: input.sectionId, sharedSectionId: existing.ref.sharedSectionId });
    }
    if (!existing && page.sections.length >= MAX.sections) {
      throw new OpenwopError('validation_error', `A page holds at most ${MAX.sections} sections.`, 400, { max: MAX.sections });
    }
    const base: Section = existing ?? { sectionId: cmsId, type: 'fields', data: {} };
    let next: Section;
    if (isBase) {
      next = { ...base, data: input.data };
    } else {
      // The stamp described the overlay being replaced; a stamp is kept only while
      // its overlay exists (ADR 0592 §3), and this write makes no provenance claim.
      const { [input.locale]: _replaced, ...restStamps } = base.aiDrafted ?? {};
      next = {
        ...base,
        localizations: { ...(base.localizations ?? {}), [input.locale]: input.data },
        ...(Object.keys(restStamps).length > 0 ? { aiDrafted: restStamps } : {}),
      };
      if (Object.keys(restStamps).length === 0) delete next.aiDrafted;
    }
    const sections = existing ? page.sections.map((s) => (s.sectionId === cmsId ? next : s)) : [...page.sections, next];
    try {
      const saved = await updatePage(input.tenantId, input.orgId, input.pageId, { sections, baseLocale: input.baseLocale }, input.actor, {
        expectedVersion: page.version,
        // ADR 0836 D2 — re-run on updatePage's OWN read, the one the CAS swaps.
        // `transitionPage` does not bump `version`, so the pin above cannot see a
        // draft published between this loop's read and the write.
        authorize: input.authorize,
      });
      if (!saved) return null;
      const section = saved.sections.find((s) => s.sectionId === cmsId);
      if (!section) throw new OpenwopError('internal_error', 'The section was not stored.', 500, {});
      return { page: saved, section };
    } catch (err) {
      if (attempt === 0 && err instanceof OpenwopError && err.code === 'conflict') continue;
      throw err;
    }
  }
}

export async function deletePage(
  tenantId: string,
  orgId: string,
  pageId: string,
  // ADR 0748 correction (2026-09-27) — a status-dependent authority decision
  // (draft = editor, anything live = admin tier) must be taken on the row this
  // function is about to delete, not on a caller's earlier read. The kernel has
  // no conditional delete, so this is the narrowest window available: the
  // decision runs on THIS read, immediately before `pages.delete`. A throw aborts
  // the delete.
  opts?: { authorize?: (page: Page) => Promise<void> },
): Promise<boolean> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return false;
  if (opts?.authorize) await opts.authorize(p);
  await pages.delete(tenantId, pageId);
  // WF-SHARE-4 — cascade the public share links that referenced this page.
  // Dynamic import: sharing imports THIS module for its resolver, so a static
  // edge back would cycle (the crm/signService precedent). Best-effort — a
  // cascade failure must not fail the delete, and the link would 404 anyway;
  // what it must not do is leave a row that reports "in use externally".
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'cms_page', pageId);
  } catch { /* best-effort cascade — the link resolves 404 regardless */ }
  // CMNT-2 — cascade the page's comment threads. Comment `body` is declared PII
  // and `listThread` never re-derives visibility from the parent, so an orphaned
  // thread stays API-readable to anyone with `workspace:read` who knows the id,
  // for up to the retention window. `chat_message` / `canvas_document` /
  // `creative_brief` already cascade; `cms_page` did not.
  // Dynamic import for the same reason as the sharing cascade above: comments
  // imports THIS module for its resolver registry, so a static edge would cycle.
  // Best-effort (the delete already succeeded) but never SILENT — CMSGAP-2.
  try {
    const { pruneThreadsForResourceAndComposites } = await import('../comments/commentsService.js');
    await pruneThreadsForResourceAndComposites(tenantId, 'cms_page', pageId);
  } catch (err) {
    log.warn('comment_thread_cascade_failed', { resourceType: 'cms_page', pageId, error: err instanceof Error ? err.message : String(err) });
  }
  // ADR 0392 grade pass D1 — deleting a page must fire the lifecycle seam so
  // consumers (the docs→KB sync) drop their derived documents; without this a
  // deleted docs page stays citable by the chat forever (an orphan).
  void fireCmsPageLifecycle({
    tenantId: p.tenantId, orgId: p.orgId, pageId: p.pageId, slug: p.slug,
    title: p.title, ...(p.collection ? { collection: p.collection } : {}), event: 'deleted',
  });
  try {
    await clearUsageForRef(tenantId, orgId, 'cms-page', pageId);
  } catch (err) {
    // Best-effort — the delete already succeeded — but never silent (CMSGAP-2).
    log.warn('cms usage cleanup failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  // RI/content-scout — cascade the page's own CMS children (page FIRST so a mid-cascade
  // failure leaves inert orphans, never a live page with half its versions). Best-effort
  // + logged, like the usage clear above. All three live in the cms feature (intra-feature).
  try {
    // The authoritative scan, not the index: a row the index has not marked yet must
    // not outlive its page. Page deletes are rare.
    for (const v of (await versions.list()).filter((v) => v.tenantId === tenantId && v.orgId === orgId && v.pageId === pageId)) {
      await versions.delete(v.versionId);
    }
    // Redirects are slug-keyed: a redirect FROM this page's slug is dead, and an inbound
    // redirect TO it now dead-ends — delete both (also prevents a stale redirect resurrecting
    // against a future page that reclaims the freed slug).
    for (const r of (await redirects.list()).filter((r) => r.tenantId === tenantId && r.orgId === orgId && (r.fromSlug === p.slug || r.toSlug === p.slug))) {
      await redirects.delete(r.redirectId);
    }
    for (const e of await listExperiments(tenantId, orgId, pageId)) {
      await deleteExperiment(tenantId, orgId, pageId, e.experimentId, 'system', { pageCascade: true });
    }
  } catch (err) {
    log.warn('cms page child cascade failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  // ADR 0593 D2 (CMSA-2a / CMSAWF-1) — cascade the page's pending editorial
  // review. It was the one child store `deletePage` never touched, and the
  // consequence was worse than an orphan: the inbox card became UNCLEARABLE
  // (approve and reject both CAS-resolved, failed the transition, compensated
  // and threw, forever — polluting the governance chain on every attempt).
  // Best-effort like every cascade above, but never silent (CMSGAP-2); the
  // decide-arm backstop in `contentApproval.ts` covers a failure here.
  try {
    await rejectPendingApprovalForPage(tenantId, pageId, 'Closed automatically — the page was deleted.', true);
    // ADR 0859 D6 — pruning now keeps each page's newest resolved review; a deleted
    // page must not keep one (the governance chain holds the decision).
    await deleteResolvedContentApprovalsForPage(tenantId, pageId);
  } catch (err) {
    log.warn('cms pending approval cascade failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

// ── Media usage references (ADR 0206 / gap-analysis B4) ─────────────────────

/** Every media serve token a page's sections reference — base data AND per-locale
 *  overlays (locale image variants, ADR 0007). Tokens are opaque here; media
 *  resolves them. */
export function collectMediaTokens(sections: readonly Section[]): string[] {
  const tokens = new Set<string>();
  const grab = (d: Record<string, unknown>): void => {
    for (const key of ['imageToken', 'token'] as const) {
      const v = d[key];
      if (typeof v === 'string' && v.length > 0) tokens.add(v);
    }
    // ADR 1080 — pictures nested in cards, gallery columns and the richText card,
    // so the media "used by" graph sees them too.
    for (const nested of [...(Array.isArray(d.columns) ? d.columns : []), d.card, d.person]) {
      const v = typeof nested === 'object' && nested !== null ? (nested as { imageToken?: unknown }).imageToken : undefined;
      if (typeof v === 'string' && v.length > 0) tokens.add(v);
    }
  };
  for (const s of sections) {
    grab(s.data);
    for (const overlay of Object.values(s.localizations ?? {})) grab(overlay);
  }
  return [...tokens];
}

/** Reconcile the media "used by" graph for this page (best-effort — a save must
 *  never fail because usage bookkeeping did). Media owns the rows + the
 *  token→asset resolution (ADR 0007 boundary). */
async function syncPageUsage(page: Page): Promise<void> {
  try {
    await syncUsageRefs(
      page.tenantId,
      page.orgId,
      { kind: 'cms-page', id: page.pageId, label: page.title },
      collectMediaTokens(page.sections),
    );
  } catch (err) {
    // Best-effort — a save never fails on bookkeeping — but never silent (CMSGAP-2).
    log.warn('cms media-usage reconcile failed', { pageId: page.pageId, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Versions + redirects (Phase 3) ──────────────────────────────────────────

export interface PageVersion {
  versionId: string;
  tenantId: string;
  orgId: string;
  pageId: string;
  version: number;
  snapshot: { title: string; slug: string; sections: Section[] };
  publishedBy: string;
  publishedAt: string;
  /**
   * ADR 0593 §C3 (CMSA-11) — WHY this snapshot exists. `snapshotPage` fires on
   * SUBMIT as well as on publish (ADR 0206 B1), so "a version row exists" has
   * never meant "this content was ever approved": a submitted-and-then-REJECTED
   * version leaves a durable, addressable snapshot behind, and the page
   * experiment lane will bind it to live traffic.
   *
   * `'publish'` is MONOTONIC — a row captured at submit is PROMOTED in place
   * when that same `page.version` is published (`transitionPage` does not bump
   * `version`, so submit→approve lands on the very row submit captured, and a
   * capture-time-only stamp would mark every legitimately published snapshot
   * `'submit'` forever).
   *
   * OPTIONAL, and absence makes NO claim: rows written before this field
   * existed carry neither value. The experiment gate treats that as
   * unidentifiable and REFUSES rather than falling through (the CMSA-7 rule) —
   * see `pageExperimentsService.assertVariantSnapshotReviewed`.
   *
   * ADR 0817 — `'seed'`: content a code seed would have written, offered
   * instead of overwriting a page a person has edited or published. It was
   * never the page's content, so it is not a capture of the page: the
   * distinct-content dedupe skips it, and the experiment gate refuses it like
   * any unreviewed row. A person adopts it with Restore, which lands in draft.
   */
  origin?: 'publish' | 'submit' | 'seed';
  /** Internal original-content capture. No approval/publish claim; hidden from editor history. */
  promotionBaseline?: { experimentId: string; wasPublished: boolean };
  /** Monotonic snapshot sequence — a stable newest-first tiebreaker for snapshots
   *  taken in the same millisecond. */
  seq: number;
}
export interface Redirect {
  redirectId: string;
  tenantId: string;
  orgId: string;
  fromSlug: string;
  toSlug: string;
  createdAt: string;
}

/** DG-1112-11 — what the version list sorts and filters on, without the snapshot. A
 *  snapshot is up to ~975 kB since ADR 1112, so the tenant index marker carries this
 *  projection and a page's history is read without decoding every tenant's snapshots. */
type VersionMeta = {
  versionId: string; tenantId: string; orgId: string; pageId: string; version: number; origin?: PageVersion['origin']; publishedAt: string; seq: number; baseline: boolean;
  /** UXG-1112-14 — what the history list shows. A marker written before these existed lacks them. */
  title?: string; slug?: string; publishedBy?: string;
};
const versionMeta = (v: PageVersion): VersionMeta => ({
  versionId: v.versionId, tenantId: v.tenantId, orgId: v.orgId, pageId: v.pageId, version: v.version,
  ...(v.origin ? { origin: v.origin } : {}), publishedAt: v.publishedAt, seq: v.seq, baseline: !!v.promotionBaseline,
  title: v.snapshot.title, slug: v.snapshot.slug, publishedBy: v.publishedBy,
});
const isVersionMeta = (m: Record<string, unknown>): m is Record<string, unknown> & VersionMeta =>
  typeof m.versionId === 'string' && typeof m.tenantId === 'string' && typeof m.orgId === 'string' && typeof m.pageId === 'string'
  && typeof m.version === 'number' && typeof m.publishedAt === 'string' && typeof m.baseline === 'boolean';
const versions = new DurableCollection<PageVersion>('cms:pageversion', (v) => v.versionId, undefined, (v) => v.tenantId, versionMeta);
// ADR 0866 — the index gains `tenantOf` in a deploy, so reads stay on the full scan
// until the hourly reconcile has verified it.
registerTenantIndexAdoption('cms:pageversion', versions);

/** DG-1112-11 — one page's history, newest first, as metadata. Through the tenant
 *  index once it is verified; the full scan before that. */
async function pageVersionMetas(tenantId: string, orgId: string, pageId: string): Promise<VersionMeta[]> {
  const all = await versions.tenantIndexVerified()
    ? (await versions.listForTenantProjected(tenantId)).filter(isVersionMeta)
    : (await versions.list()).filter((v) => v.tenantId === tenantId).map(versionMeta);
  return all.filter((m) => m.tenantId === tenantId && m.orgId === orgId && m.pageId === pageId).sort(byNewest);
}

/** The rows behind `metas`, in order. A marker can outlive its row, so a missing
 *  row is skipped, and a row is kept only when it is still this page's. */
async function versionRows(metas: readonly VersionMeta[]): Promise<PageVersion[]> {
  const out: PageVersion[] = [];
  for (const m of metas) {
    const v = await versions.get(m.versionId);
    if (v && v.tenantId === m.tenantId && v.orgId === m.orgId && v.pageId === m.pageId) out.push(v);
  }
  return out;
}

/** The first of `metas` whose row still exists (`put` writes the marker first, so a
 *  crash can leave a marker with no row, and a projected read does not drop it). */
async function firstRow(metas: readonly VersionMeta[]): Promise<PageVersion | undefined> {
  for (const m of metas) {
    const [row] = await versionRows([m]);
    if (row) return row;
  }
  return undefined;
}

/** Drop the oldest of a page's history beyond MAX_VERSIONS (baselines are kept). The
 *  projection only says whether the page is over the cap; what to delete is decided on
 *  the rows, so a marker with no row can never push out a real snapshot. */
async function capPageVersions(tenantId: string, orgId: string, pageId: string): Promise<void> {
  const metas = (await pageVersionMetas(tenantId, orgId, pageId)).filter((m) => !m.baseline);
  if (metas.length <= MAX_VERSIONS) return;
  const rows = (await versionRows(metas)).filter((v) => !v.promotionBaseline).sort(byNewest);
  for (const old of rows.slice(MAX_VERSIONS)) await versions.delete(old.versionId);
}

/** Every version row of one tenant (erasure). */
async function tenantVersions(tenantId: string): Promise<PageVersion[]> {
  if (await versions.tenantIndexVerified()) return versions.listForTenantIndexed(tenantId);
  return (await versions.list()).filter((v) => v.tenantId === tenantId);
}
const redirects = new DurableCollection<Redirect>('cms:redirect', (r) => r.redirectId);
const MAX_VERSIONS = 50;
let versionSeq = 0;

/** Newest-first by `publishedAt` (RESTART-SAFE — persisted), with the in-process
 *  monotonic `seq` as a same-millisecond tiebreaker only (code-review #3). */
function byNewest(a: { publishedAt: string; seq: number }, b: { publishedAt: string; seq: number }): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  return (b.seq ?? 0) - (a.seq ?? 0);
}

/**
 * Capture a content snapshot. DISTINCT-CONTENT-ONLY (ADR 0206 / ADR 0009
 * correction): skip when the newest snapshot already captures this
 * `page.version` — so submit→publish of unchanged content, or a re-submit
 * without edits, never duplicates a capture. Snapshots are content captures
 * keyed by version, not status events; `publishedBy`/`publishedAt` read as
 * "capturedBy/capturedAt" (field names kept for stored-row + editor-API
 * compatibility).
 */
async function snapshotPage(page: Page, publishedBy: string, origin: 'publish' | 'submit'): Promise<void> {
  // ADR 0836 D4 — page ids are per tenant: without the tenant/org filter, tenant
  // B's publish of a same-id page deduped against (and PROMOTED) tenant A's row.
  const newest = await firstRow((await pageVersionMetas(page.tenantId, page.orgId, page.pageId))
    .filter((x) => x.origin !== 'seed' && !x.baseline)); // ADR 0817: an offer, not a capture
  if (newest && newest.version === page.version) {
    // ADR 0593 §C3 (CMSA-11) — dedupe, but PROMOTE. `transitionPage` never
    // bumps `version`, so an approve lands on exactly the row submit captured
    // and this early return is the common publish path, not a corner. A
    // capture-time-only stamp would therefore mark the canonical published
    // snapshot `'submit'` on every gated org and the experiment gate would
    // refuse the ONE version it must allow — the prescribed cure, built
    // literally, is the gate-with-no-exit shape. Promotion is one-way.
    // NOTE (review F8): only `origin` is rewritten. `publishedBy`/`publishedAt`
    // keep naming the SUBMITTER and the submit instant, which is correct under
    // this row's own doc ("they read as capturedBy/capturedAt") — the capture
    // really did happen then, by them. Approver attribution lives on the
    // approval row, which is the record that answers "who let this out".
    if (origin === 'publish' && newest.origin !== 'publish') {
      await versions.put({ ...newest, origin: 'publish' });
    }
    return;
  }
  const v: PageVersion = {
    origin,
    versionId: `pver:${randomUUID()}`,
    tenantId: page.tenantId,
    orgId: page.orgId,
    pageId: page.pageId,
    version: page.version,
    snapshot: { title: page.title, slug: page.slug, sections: page.sections },
    publishedBy,
    publishedAt: nowIso(),
    seq: ++versionSeq,
  };
  await versions.put(v);
  await capPageVersions(page.tenantId, page.orgId, page.pageId);
}

/**
 * ADR 0817 — offer a code seed's newer content for a page the seed may no
 * longer overwrite (a person edited or published it). It lands in the page's
 * history as a `'seed'` row the editor can diff and Restore; the page itself
 * is untouched. Idempotent per content: an identical newest offer is not
 * recorded twice.
 */
export async function offerSeedVersion(
  page: Page,
  snapshot: { title: string; sections: Section[] },
  actor: string,
  baseLocale = 'en', // `updatePage`'s default — the locale the seed writes in
): Promise<PageVersion | null> {
  // The page's own write path validates (ADR 0009 content safety, minted
  // `sec:` ids) and Restore copies the snapshot verbatim, so validate here.
  const sections = validateSections(snapshot.sections, baseLocale, page.tenantId);
  // Ids are minted per validation, so compare content without them.
  const content = (ss: readonly Section[]): string => JSON.stringify(ss.map(({ sectionId: _id, ...rest }) => rest));
  const lastOffer = await firstRow((await pageVersionMetas(page.tenantId, page.orgId, page.pageId)).filter((x) => x.origin === 'seed'));
  if (lastOffer && lastOffer.snapshot.title === snapshot.title
    && content(lastOffer.snapshot.sections) === content(sections)) return null;
  const v: PageVersion = {
    origin: 'seed',
    versionId: `pver:${randomUUID()}`,
    tenantId: page.tenantId,
    orgId: page.orgId,
    pageId: page.pageId,
    version: page.version,
    snapshot: { title: snapshot.title, slug: page.slug, sections },
    publishedBy: actor,
    publishedAt: nowIso(),
    seq: ++versionSeq,
  };
  await versions.put(v);
  await capPageVersions(page.tenantId, page.orgId, page.pageId);
  return v;
}

export async function listVersions(tenantId: string, orgId: string, pageId: string): Promise<PageVersion[]> {
  // newest first — createdAt primary (restart-safe), seq tiebreaker
  return versionRows((await pageVersionMetas(tenantId, orgId, pageId)).filter((m) => !m.baseline));
}

/** UXG-1112-14 — a history entry without its sections: what the editor's History
 *  list and the experiment variant picker show. Compare reads the whole row through
 *  `getVersion`. */
export type PageVersionSummary = Pick<PageVersion, 'versionId' | 'tenantId' | 'orgId' | 'pageId' | 'version' | 'publishedAt' | 'publishedBy' | 'origin' | 'seq'>
  & { snapshot: { title: string; slug: string } };

/** `listVersions` without the sections, from the index markers. A marker written
 *  before it carried title/slug/publishedBy falls back to its row (and a row that is
 *  gone drops the entry). Residue: a marker whose row write never landed (a crash
 *  inside `put`) stays listed; Compare and Restore on it
 *  answer 404. */
export async function listVersionSummaries(tenantId: string, orgId: string, pageId: string): Promise<PageVersionSummary[]> {
  const out: PageVersionSummary[] = [];
  for (const m of (await pageVersionMetas(tenantId, orgId, pageId)).filter((x) => !x.baseline)) {
    let head: { title: string; slug: string; publishedBy: string } | null =
      typeof m.title === 'string' && typeof m.slug === 'string' && typeof m.publishedBy === 'string'
        ? { title: m.title, slug: m.slug, publishedBy: m.publishedBy } : null;
    if (!head) {
      const [row] = await versionRows([m]);
      if (!row) continue;
      head = { title: row.snapshot.title, slug: row.snapshot.slug, publishedBy: row.publishedBy };
    }
    out.push({
      versionId: m.versionId, tenantId: m.tenantId, orgId: m.orgId, pageId: m.pageId, version: m.version,
      publishedAt: m.publishedAt, publishedBy: head.publishedBy, seq: m.seq, ...(m.origin ? { origin: m.origin } : {}),
      snapshot: { title: head.title, slug: head.slug },
    });
  }
  return out;
}

/** One version row, tenant+org+page IDOR-guarded (ADR 0236 D1 — the experiment
 *  seam reads a variant's snapshot exactly the way restoreVersion does). */
export async function getVersion(tenantId: string, orgId: string, pageId: string, versionId: string): Promise<PageVersion | null> {
  const v = await versions.get(versionId);
  return v && v.tenantId === tenantId && v.orgId === orgId && v.pageId === pageId ? v : null;
}

/** Closed receipts can never publish again, so their capture no longer needs
 * retention. An interrupted cleanup retries on the next receipt reconciliation. */
async function discardClosedPromotionBaselines(page: Page): Promise<void> {
  for (const receipt of Object.values(page.promotionReceipts ?? {})) {
    if (receipt.phase === 'rolled_back' || receipt.phase === 'superseded') await versions.delete(receipt.restoreRef);
  }
}

/** Only host promotion code supplies this option; route bodies never do. */
function applyPromotionGuard(page: Page, next: Page, guard: PagePromotionGuard | undefined): void {
  if (!guard) return;
  const receipt = page.promotionReceipts?.[guard.experimentId];
  const approved = receipt?.pendingApproval && receipt.ownedStatus === 'in_review' && page.status === 'published';
  if (!receipt || receipt.phase !== guard.from || receipt.ownedVersion !== page.version
    || (receipt.ownedStatus !== page.status && !approved)) {
    throw new OpenwopError('conflict', 'The promotion or its page changed before this write.', 409, { reason: 'promotion_changed' });
  }
  next.promotionReceipts = { ...page.promotionReceipts, [guard.experimentId]: { ...receipt,
    phase: guard.to, ownedVersion: next.version, ownedStatus: next.status, ...(guard.pendingApproval === undefined ? {} : { pendingApproval: guard.pendingApproval }) } };
}

/** Pin the original content before changing it. A failed page CAS never lets a
 * retry replace this immutable capture with content it did not originally see. */
export async function preparePagePromotion(
  tenantId: string, orgId: string, pageId: string, experimentId: string, winnerRef: string | null, actor: string,
  operation: 'finalize' | 'rollback',
): Promise<Page> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const page = await getPage(tenantId, orgId, pageId);
    if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, {});
    const existing = page.promotionReceipts?.[experimentId];
    if (existing) {
      if (existing.winnerRef !== winnerRef) throw new OpenwopError('conflict', 'The promotion names another winner.', 409, { reason: 'promotion_mismatch' });
      // A restore's primary commit can precede a failed usage-index update.
      if (['restored', 'rollback_restored', 'rolled_back'].includes(existing.phase) && existing.ownedVersion === page.version) await syncPageUsage(page);
      await discardClosedPromotionBaselines(page);
      if (operation === 'finalize' && ['rolling_back', 'rollback_restored', 'rollback_submitted', 'rolled_back', 'superseded'].includes(existing.phase)) {
        throw new OpenwopError('conflict', 'The promotion has been closed.', 409, { reason: 'promotion_rolled_back' });
      }
      return page;
    }
    const restoreRef = `pver:${createHash('sha256').update(JSON.stringify([tenantId, orgId, pageId, experimentId])).digest('hex')}`;
    const capsule: PageVersion = { versionId: restoreRef, tenantId, orgId, pageId, version: page.version,
      snapshot: { title: page.title, slug: page.slug, sections: page.sections }, publishedBy: actor, publishedAt: nowIso(), seq: ++versionSeq,
      promotionBaseline: { experimentId, wasPublished: page.status === 'published' } };
    await versions.putIfAbsent(capsule);
    const original = await getVersion(tenantId, orgId, pageId, restoreRef);
    if (!original || original.version !== page.version || original.promotionBaseline?.wasPublished !== (page.status === 'published')
      || JSON.stringify(original.snapshot) !== JSON.stringify(capsule.snapshot)) {
      throw new OpenwopError('conflict', 'The page changed before its promotion could be prepared.', 409, { reason: 'promotion_changed' });
    }
    const baselineRef = page.status === 'published'
      ? (await listVersions(tenantId, orgId, pageId)).find((v) => v.origin === 'publish' && v.version === page.version)?.versionId ?? null : null;
    const receipts = { ...page.promotionReceipts };
    for (const [id, prior] of Object.entries(receipts)) {
      if (prior.phase !== 'rolled_back' && prior.phase !== 'superseded') {
        if (prior.phase !== 'finalized' && prior.ownedVersion === page.version) {
          throw new OpenwopError('conflict', 'Another promotion is changing this page.', 409, { reason: 'promotion_in_progress' });
        }
        receipts[id] = { ...prior, phase: 'superseded' };
      }
    }
    const receipt: PagePromotionReceipt = { winnerRef, baselineRef, restoreRef, baselinePublished: page.status === 'published',
      ownedVersion: page.version, ownedStatus: page.status, phase: operation === 'rollback' ? 'rolled_back' : 'prepared' };
    try {
      await casPage(page, { ...page, promotionReceipts: { ...receipts, [experimentId]: receipt } });
    } catch (err) {
      if (err instanceof OpenwopError && err.httpStatus === 409) continue;
      throw err;
    }
    const prepared = await getPage(tenantId, orgId, pageId);
    if (!prepared) throw new OpenwopError('not_found', 'Page not found.', 404, {});
    await discardClosedPromotionBaselines(prepared);
    return prepared;
  }
  throw new OpenwopError('conflict', 'The page keeps changing. Retry the promotion.', 409, { reason: 'promotion_changed' });
}

/** Advance evidence only; restore/transition advance it atomically with content. */
export async function advancePagePromotion(
  tenantId: string, orgId: string, pageId: string, guard: PagePromotionGuard,
): Promise<Page> {
  const page = await getPage(tenantId, orgId, pageId);
  if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, {});
  const next = { ...page };
  applyPromotionGuard(page, next, guard);
  await casPage(page, next);
  await discardClosedPromotionBaselines(next);
  return next;
}

/** Restore a past version's content into the page's DRAFT (does not publish). */
export async function restoreVersion(
  tenantId: string,
  orgId: string,
  pageId: string,
  versionId: string,
  actor: string,
  // ADR 0593 CORRECTION (review F5) — WHY the pending review is being closed.
  // The experiment-promote lane calls this FIRST and unconditionally, so by the
  // time its own arm tried to close the row the CAS had already refused and the
  // recorded cause was the generic restore note. The caller that knows the real
  // reason has to supply it, or the governance record says the wrong thing.
  closeReviewNote = 'Closed automatically — a previous version was restored and the page returned to draft.',
  // ADR 0836 D8 — `expectedVersion` pins the restore to the content the editor
  // was looking at (a restore over an edit it never saw is the lost update the
  // page PATCH already refuses). `republishing` is set by the ONE caller that
  // restores and republishes in the same operation (experiment promote): there
  // the page never leaves the public surface from a reader's point of view, and a
  // fire-and-forget `unpublished` racing the `published` could evict a live docs
  // page from the KB.
  opts?: { expectedVersion?: number; republishing?: boolean; promotion?: PagePromotionGuard },
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (opts?.expectedVersion !== undefined && p.version !== opts.expectedVersion) {
    throw new OpenwopError(
      'conflict',
      `The page changed since it was loaded (version ${p.version}, expected ${opts.expectedVersion}) — reload before restoring.`,
      409,
      { pageId, currentVersion: p.version, expectedVersion: opts.expectedVersion },
    );
  }
  const v = await versions.get(versionId);
  if (!v || v.pageId !== pageId || v.tenantId !== tenantId || v.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Version not found for this page.', 404, { versionId });
  }
  const wasLive = p.status === 'published' || p.status === 'archived';
  const next: Page = { ...p, title: v.snapshot.title, sections: v.snapshot.sections, status: 'draft', version: p.version + 1, updatedBy: actor, updatedAt: nowIso() };
  // A restore lands in draft: a pending schedule was set against other content
  // (publish) or a page that is no longer live (unpublish).
  delete next.scheduledPublishAt;
  delete next.scheduledPublishVersion;
  delete next.scheduledUnpublishAt;
  applyPromotionGuard(p, next, opts?.promotion);
  await casPage(p, next);
  if (p.scheduledPublishAt) await dropMarker(scheduledMarkers, tenantId, orgId, pageId);
  if (p.scheduledUnpublishAt) await dropMarker(scheduledUnpublishMarkers, tenantId, orgId, pageId);
  await syncPageUsage(next); // restored sections may reference different assets
  // ADR 0593 D2 (CMSA-2b) — a restore ALWAYS lands the page in `draft`, so a
  // pending review of the pre-restore content is about content that no longer
  // exists. Left open it wedged: approve 409'd stale (correct) but reject
  // 409'd-and-reopened forever, because `transitionPage('reject')` demands
  // `in_review`. Close it and say why; a resubmit mints a fresh, correctly
  // pinned row (that is what the gated experiment-promote lane now does).
  try {
    await rejectPendingApprovalForPage(tenantId, pageId, closeReviewNote, true);
  } catch (err) {
    log.warn('cms pending approval cascade failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  recordCmsAction('restore', next, actor, { restoredVersion: v.version }); // ADR 0204 C1/C5
  // ADR 0836 D8 (G2) — restoring a live page takes it OFF the public surface.
  // It used to do so silently: no `unpublished` event or lifecycle, so derived
  // stores (the docs KB) kept citing a page that now 404s.
  if (wasLive && !opts?.republishing) recordPageUnpublishedByRestore(next);
  return next;
}

/** ADR 0836 D8 — the `unpublish` event + lifecycle a restore of a live page owes.
 *  Exported for the one caller that suppresses it (`republishing`) and must still
 *  emit it when its republish then fails. */
export function recordPageUnpublishedByRestore(page: Page): void {
  recordCmsAction('unpublish', page, page.updatedBy, { cause: 'restore' });
}

// ── Lifecycle events + audit (ADR 0204 C1/C5) ───────────────────────────────

/** Workflow action → the `host.cms.page.*` lifecycle event it emits (vendor
 *  pattern, `openwop-app.crm.contact-triaged` precedent — schema-legal, no RFC). */
const EVENT_FOR_ACTION: Record<string, string> = {
  submit: 'host.cms.page.submitted',
  approve: 'host.cms.page.published',
  publish: 'host.cms.page.published',
  reject: 'host.cms.page.rejected',
  archive: 'host.cms.page.archived',
  unpublish: 'host.cms.page.unpublished',
  restore: 'host.cms.page.restored',
};

/**
 * Record a CMS action: an audit row (C5 — `payload.tenantId` is REQUIRED, the
 * tenant-scoped governance read withholds rows without it, fail-closed) and,
 * when the action maps to a lifecycle event, a webhook fan-out through the
 * ONE delivery pipeline (C1). Both best-effort — bookkeeping never fails the
 * write it describes. No section content rides an event or audit row (titles
 * only).
 *
 * CORRECTED (ADR 0668 D2) — this used to read "and never a locale (RFC 0103 §F)".
 * §F's invariant (`spec/v1/localized-content.md:165`) is scoped to a **run event
 * log**; a `host.cms.page.*` host-extension webhook is not one. The claim was also
 * already inaccurate: `setLocalePublishState` passes `{ locale, state }` through
 * `extra`, so the AUDIT row has carried a locale since ADR 0205. A host-ext
 * lifecycle payload may carry the locale it describes; a run event log may not.
 */
function recordCmsAction(action: string, page: Page, actor: string, extra?: Record<string, unknown>): void {
  const at = nowIso();
  const base = { tenantId: page.tenantId, orgId: page.orgId, pageId: page.pageId, slug: page.slug, status: page.status, version: page.version, actor, at, ...extra };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `cms.${action}`, resource: page.pageId, outcome: 'success', payload: base })
      .catch((err) => log.warn('cms audit append failed', { action, pageId: page.pageId, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  // ADR 0668 D2 (CMSLWF-15) — releasing a withheld locale is a PUBLISH for the readers
  // of that locale (ADR 0593's own gate comment says so: it "instantly serves overlays
  // that were being held back"), and it emitted on NO lane. It rides the EXISTING kinds
  // rather than minting one, because a new `host.cms.page.*` type is an operator-catalog
  // change under the ADR 0617 D4 parity gate; the `locale` in `extra` is the discriminator.
  const eventType = action === 'locale-publish-state'
    ? (extra?.state === 'published' ? 'host.cms.page.published' : 'host.cms.page.unpublished')
    : EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: page.tenantId, payload: { ...base, title: page.title } });
  }
  // ADR 0392 — the in-process page-lifecycle seam (consumers filter on
  // `collection`; CMS stays ignorant of who cares). Fire only for the publish
  // STATE transitions that move a page in/out of the public surface.
  // ADR 0668 D2 — the lifecycle seam is DELIBERATELY not extended to a locale flip.
  // `CmsPageLifecycleChange` carries no locale (`host/cmsPageLifecycle.ts`), and the one
  // registered consumer DELETES the whole document on `unpublished`
  // (`features/docs/docsKnowledgeService.ts`) — so withholding a single `es` overlay of a
  // docs page would evict a still-published page, English body included, from the docs KB.
  // The KB also flattens BASE `data` only, so a locale flip changes nothing it stores:
  // firing this seam would be pure loss in one direction and a no-op in the other.
  const lifecycle = action === 'locale-publish-state' ? undefined : LIFECYCLE_FOR_ACTION[action];
  if (lifecycle) {
    void fireCmsPageLifecycle({
      tenantId: page.tenantId, orgId: page.orgId, pageId: page.pageId, slug: page.slug,
      title: page.title, ...(page.collection ? { collection: page.collection } : {}), event: lifecycle,
    });
  }
}

/** The lifecycle event a workflow action produces, when it changes public
 *  visibility (ADR 0392). `submit`/`reject` don't move the page in/out of the
 *  public surface, so they don't fire. `restore` DOES when the page was live
 *  (it lands in draft) — ADR 0836 D8 corrected this comment, which said it never
 *  did; `restoreVersion` records the `unpublish` itself in that case. */
const LIFECYCLE_FOR_ACTION: Record<string, 'published' | 'unpublished' | 'archived'> = {
  approve: 'published',
  publish: 'published',
  unpublish: 'unpublished',
  archive: 'archived',
};

// ── Editorial workflow (Phase 2) ────────────────────────────────────────────

export type WorkflowAction = 'submit' | 'approve' | 'reject' | 'publish' | 'archive' | 'unpublish';

/** Legal `from → to` per action; the ROUTE enforces the SCOPE (submit =
 *  workspace:write; the rest = host:members:manage). `unpublish` (and the exit
 *  from `archived`) is how a published/archived page returns to draft to be
 *  edited through the gate again — there is no other path back to draft except
 *  restoreVersion (code-review #1/#5: closes the archived dead-end + gives a
 *  clean re-edit path so live content isn't patched in place). */
const TRANSITIONS: Record<WorkflowAction, { from: PageStatus[]; to: PageStatus }> = {
  // UX_UPGRADE-content R2 (CMS2-M1 fold-in) — `in_review` is a legal FROM state
  // because a resubmit is how an edited in-review page RE-PINS its approval.
  // The version pin refuses to publish content that changed after submit, which
  // is the point; but with submit draft-only there was no way to make the pin
  // catch up, so an admin editing an in-review page (which `routes.ts` allows,
  // deliberately, so a reviewer's requested change can be made) left the page
  // permanently unapprovable — the 409's own remedy, "submit it again", was
  // itself a 409. The only escape was `reject`, which fires a rejection event
  // and audit row against content the reviewer actually wanted.
  submit: { from: ['draft', 'in_review'], to: 'in_review' },
  approve: { from: ['in_review'], to: 'published' },
  reject: { from: ['in_review'], to: 'draft' },
  publish: { from: ['draft', 'in_review'], to: 'published' }, // admin direct-publish
  archive: { from: ['published'], to: 'archived' },
  unpublish: { from: ['published', 'archived'], to: 'draft' }, // back to draft to re-edit
};

/** A `[TODO …]` marker left in content — the seed's convention for "the author
 *  still owes this". Mirrors the browser checklist's ONE `block` rule
 *  (`frontend/react/src/features/cms/publishChecks.ts` `TODO`), pinned by a parity
 *  test. The browser's empty-title rule is deliberately NOT here: server titles
 *  fall back to "Untitled page", so a witness for it could never go red. */
export const TODO_MARKER = /\[TODO\b/i;

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => collectStrings(x, out));
  return out;
}

export type PublishBlocker =
  | { rule: 'todo'; sectionId: string }
  // DG-1112-5 — the page as readers get it, its shared sections resolved, is over the page limit.
  | { rule: 'too_large'; bytes: number; limit: number };

/** ADR 0836 D9 — what stops content reaching readers, decided on the server.
 *  Own-section `data` only, like the browser: a shared-section ref has no own
 *  content and overlays are translations of what is checked here. */
export function publishBlockers(page: Pick<Page, 'sections'>): PublishBlocker[] {
  return page.sections
    .filter((s) => !s.ref && collectStrings(s.data).some((x) => TODO_MARKER.test(x)))
    .map((s) => ({ rule: 'todo' as const, sectionId: s.sectionId }));
}

/**
 * DG-1112-5 (ADR 1112 D5) — the page limit, applied to the page readers get. A save measures
 * the stored sections; a shared-section ref is resolved only at delivery, and each shared
 * scheduleSim may hold 850 kB, so a page of refs could go out at several MB with no check.
 * Measured where content reaches readers (publish, and an edit of a published page), with
 * the same `publish_blocked` refusal every publish lane already handles. A page with no
 * refs is what its save measured, so it costs no read.
 */
export async function assertResolvedPageFits(page: Page, pending?: SharedSection): Promise<void> {
  if (!page.sections.some((s) => s.ref)) return;
  const bytes = Buffer.byteLength(JSON.stringify((await resolveSharedRefs(page, pending)).sections));
  if (bytes <= PAGE_SECTIONS_MAX_BYTES) return;
  throw new OpenwopError(
    'validation_error',
    pending
      ? `This change would bring the published page "${page.title}" to ${Math.ceil(bytes / 1000)} kB; a published page is at most ${PAGE_SECTIONS_MAX_BYTES / 1000} kB. Make the shared section smaller, or move it off that page first.`
      : `With its shared sections, this page comes to ${Math.ceil(bytes / 1000)} kB; a published page is at most ${PAGE_SECTIONS_MAX_BYTES / 1000} kB. Replace a large shared section with a smaller one, or move it to its own page.`,
    422,
    {
      reason: 'publish_blocked', pageId: page.pageId, ...(pending ? { pageTitle: page.title } : {}),
      blockers: [{ rule: 'too_large', bytes, limit: PAGE_SECTIONS_MAX_BYTES }] satisfies PublishBlocker[],
    },
  );
}

/** Throws the typed `422 validation_error` (`details.reason: 'publish_blocked'`). */
export function assertNoPublishBlockers(page: Pick<Page, 'pageId' | 'sections'>): void {
  const blockers = publishBlockers(page);
  if (blockers.length === 0) return;
  // `validation_error` + `details.reason` rather than a new code: a new code is a
  // wire-registry change (v2 vendor-namespaces it) for what is one more refusal
  // of the existing shape; the reason is what the editor keys on.
  throw new OpenwopError(
    'validation_error',
    `This page still has ${blockers.length === 1 ? 'a [TODO …] marker' : `${blockers.length} sections with [TODO …] markers`} — finish or remove ${blockers.length === 1 ? 'it' : 'them'} before it goes to readers.`,
    422,
    { reason: 'publish_blocked', pageId: page.pageId, blockers },
  );
}

export async function transitionPage(
  tenantId: string,
  orgId: string,
  pageId: string,
  action: WorkflowAction,
  actor: string,
  // ADR 0593 D3 (CMSA-3 / CMSAWF-3) — OPTIONAL optimistic-concurrency pin, the
  // same shape `updatePage` takes (ADR 0592 §1). The approval handler threads
  // `approval.pageVersion` on the APPROVE arm so the approve-what-you-saw pin is
  // a precondition on the write rather than a check-then-act read: an admin
  // PATCH landing in the window used to publish unseen content under the
  // reviewer's name. Optional on purpose — every other transition lane
  // (submit/reject/publish/unpublish/archive, the sweep, promote) is unchanged.
  opts?: { expectedVersion?: number; promotion?: PagePromotionGuard },
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (opts?.expectedVersion !== undefined && p.version !== opts.expectedVersion) {
    throw new OpenwopError(
      'conflict',
      `This page changed after it was submitted for review (version ${p.version}, expected ${opts.expectedVersion}). Re-open it, read the current version, and submit it again.`,
      409,
      // `phase: 'transition'` distinguishes this from the handler's pre-CAS
      // staleness read. Same user-facing meaning and the same FE arm, but a
      // witness for the TOCTOU window CANNOT tell the two apart without it —
      // both produce a 409 and leave the row pending, so the test would pass
      // whether or not the precondition exists.
      { reason: 'stale_review', phase: 'transition', pageId, currentVersion: p.version, approvedVersion: opts.expectedVersion },
    );
  }
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(p.status)) {
    throw new OpenwopError('validation_error', `Cannot ${action} a page in status \`${p.status}\`.`, 409, { status: p.status, action });
  }
  // ADR 0836 D9 — the server half of the pre-publish checklist. Every lane that
  // moves content TO READERS meets it here: the routes, the protocol lane,
  // approval decide, experiment promote, the sweep. NOT `submit`: ADR 0828 keeps
  // submit open with blockers on purpose ("a reviewer can help finish the
  // page"), and the approve that follows is checked here. (The pre-code review's
  // AR-M5 asked for submit too; that would have overturned 0828's product call.)
  if (rule.to === 'published') { assertNoPublishBlockers(p); await assertResolvedPageFits(p); }
  const next: Page = { ...p, status: rule.to, updatedBy: actor, updatedAt: nowIso() };
  // ADR 0859 D2 — a NEW submission (draft → in_review) opens a new review cycle; a
  // resubmit of an in_review page stays in the cycle it is in (it re-pins that row).
  if (action === 'submit' && p.status === 'draft') next.reviewCycle = (p.reviewCycle ?? 0) + 1;
  if (rule.to === 'published') {
    next.publishedVersion = next.version;
    next.publishedAt = next.updatedAt; // ADR 0391 (a) — the publish instant (blog order + RSS pubDate)
    delete next.scheduledPublishAt; // any publish consumes a pending schedule (ADR 0204 C2)
    delete next.scheduledPublishVersion;
    // A pending scheduledUnpublishAt deliberately SURVIVES publish — it is the
    // embargo-end half of the pair (ADR 0204 C2b).
  } else if (p.status === 'published' || p.status === 'archived') {
    // Leaving published/archived (manual unpublish, archive) makes a pending
    // unpublish schedule moot — consume the field; the marker self-heals at
    // the next sweep read (the same discipline as the publish lane).
    delete next.scheduledUnpublishAt;
  }
  applyPromotionGuard(p, next, opts?.promotion);
  await casPage(p, next);
  // ADR 0836 D1 — the snapshot is written only once the transition landed. It
  // used to run first, so a lost race could still promote the submit row's
  // `origin` to 'publish' — the marker the experiment gate trusts.
  //
  // The CAS above IS the commit point: the page is published (or in review)
  // from here on. A snapshot failure must therefore not THROW — a caller that
  // compensates on a throw (approval decide reopens its row) would record the
  // opposite of what happened, and the lifecycle event below would be lost.
  // Version history is derived state; a missing capture is logged, not undone.
  try {
    if (rule.to === 'published') {
      await snapshotPage(next, actor, 'publish'); // capture the published snapshot (Phase 3)
    } else if (action === 'submit') {
      // ADR 0206 (B1): capture at submit too, so review-time version compares
      // have the submitted content. snapshotPage dedupes by version, so
      // submit→publish of unchanged content still yields ONE capture (and the
      // publish arm PROMOTES that row's `origin` — ADR 0593 §C3).
      await snapshotPage(next, actor, 'submit');
    }
  } catch (err) {
    log.error('cms_snapshot_failed_after_commit', { tenantId, pageId, action, error: err instanceof Error ? err.message : String(err) });
  }
  recordCmsAction(action, next, actor); // ADR 0204 C1/C5 — event + audit, best-effort
  return next;
}

// ── Translator locale grants (ADR 0205 D1) ──────────────────────────────────
// A NARROWING filter over an editor's write authority (the ADR 0132
// conversation-scope precedent — narrowing filters live with the feature;
// authority itself stays accessControl's): a member with a grant may edit ONLY
// the granted locales' overlays on draft pages — never base content, page
// chrome (title/slug/tags), section structure, foreign locales, or workflow
// status. No grant ⇒ unchanged full-editor behavior.

export interface CmsLocaleGrant {
  grantId: string; // `${tenantId}:${orgId}:${subject}` — deterministic
  tenantId: string;
  orgId: string;
  /** The member's authenticated subject (User.userId). */
  subject: string;
  locales: string[];
  updatedBy: string;
  updatedAt: string;
}

const localeGrants = new DurableCollection<CmsLocaleGrant>('cms:localegrant', (g) => g.grantId);

export async function listLocaleGrants(tenantId: string, orgId: string): Promise<CmsLocaleGrant[]> {
  return (await localeGrants.list()).filter((g) => g.tenantId === tenantId && g.orgId === orgId);
}

export async function getLocaleGrant(tenantId: string, orgId: string, subject: string): Promise<CmsLocaleGrant | null> {
  const g = await localeGrants.get(`${tenantId}:${orgId}:${subject}`);
  return g && g.tenantId === tenantId && g.orgId === orgId ? g : null;
}

/** Set (or, with an empty locale list, remove) a member's translator grant.
 *  ADR 0592 §9 (CMSL-7) — grant locales are validated against the org's
 *  CONFIGURED `supportedLocales`: a grant for an unconfigured locale narrows
 *  a member to overlays no lane delivers (a de-facto lockout that looks like
 *  a working grant), so it 400s at write with the unsupported set named. */
export async function putLocaleGrant(tenantId: string, orgId: string, subject: string, locales: unknown, updatedBy: string): Promise<CmsLocaleGrant | null> {
  if (!Array.isArray(locales)) throw new OpenwopError('validation_error', '`locales` must be an array.', 400, {});
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of locales) {
    const l = String(raw);
    if (!LOCALE_RE.test(l)) throw new OpenwopError('validation_error', `Invalid locale \`${l}\` (expected BCP-47).`, 400, { locale: l });
    if (!seen.has(l)) { seen.add(l); cleaned.push(l); }
  }
  if (cleaned.length > 0) {
    const settings = await getContentLanguageSettings(tenantId, orgId);
    const unsupported = cleaned.filter((l) => !settings.supportedLocales.includes(l));
    if (unsupported.length > 0) {
      throw new OpenwopError(
        'validation_error',
        `These locales are not configured translation locales for this org: [${unsupported.join(', ')}] — add them in language settings first.`,
        400,
        { unsupported, supportedLocales: settings.supportedLocales },
      );
    }
  }
  const grantId = `${tenantId}:${orgId}:${subject}`;
  if (cleaned.length === 0) {
    await localeGrants.delete(grantId);
    return null;
  }
  const row: CmsLocaleGrant = { grantId, tenantId, orgId, subject, locales: cleaned, updatedBy, updatedAt: nowIso() };
  await localeGrants.put(row);
  return row;
}

const stable = (v: unknown): string => JSON.stringify(v ?? null);

/**
 * Enforce the translator narrowing on a page PATCH (ADR 0205 D1): the incoming
 * sections must be IDENTICAL to the stored page except for overlay changes on
 * granted locales. Structure (count/order/ids/types), base `data`, and shared
 * refs are immutable to a locale-scoped member. Throws `forbidden_scope` 403.
 */
export function assertLocaleScopedSectionsPatch(current: Page, incoming: Section[], grantedLocales: readonly string[]): void {
  const deny = (reason: string, details: Record<string, unknown> = {}): never => {
    throw new OpenwopError('forbidden_scope', `Your translator grant is limited to [${grantedLocales.join(', ')}] — ${reason}`, 403, { grantedLocales: [...grantedLocales], ...details });
  };
  if (incoming.length !== current.sections.length) deny('sections cannot be added or removed.');
  const granted = new Set(grantedLocales);
  current.sections.forEach((cur, i) => {
    const next = incoming[i]!;
    if (next.sectionId !== cur.sectionId || next.type !== cur.type) deny('sections cannot be reordered or retyped.', { sectionId: cur.sectionId });
    if (stable(next.ref) !== stable(cur.ref)) deny('shared-section references cannot change.', { sectionId: cur.sectionId });
    if (stable(next.data) !== stable(cur.data)) deny('base content cannot change.', { sectionId: cur.sectionId });
    const locales = new Set([...Object.keys(cur.localizations ?? {}), ...Object.keys(next.localizations ?? {})]);
    for (const locale of locales) {
      if (stable(next.localizations?.[locale]) !== stable(cur.localizations?.[locale]) && !granted.has(locale)) {
        deny(`the \`${locale}\` overlay is outside your grant.`, { sectionId: cur.sectionId, locale });
      }
    }
    // ADR 0592 §3 correction (review F4) — the AI-provenance stamps are part
    // of the per-locale surface this guard protects: without this, a
    // translator granted only `es` could STRIP (or forge) `fr`'s `aiDrafted`
    // stamp with a 200 — laundering the exact signal the human review gate
    // depends on, through the narrowed lane itself (the in-family instance).
    // Their OWN granted locales stay free: editing legitimately clears the
    // stamp there.
    const aiLocales = new Set([...Object.keys(cur.aiDrafted ?? {}), ...Object.keys(next.aiDrafted ?? {})]);
    for (const locale of aiLocales) {
      if (stable(next.aiDrafted?.[locale]) !== stable(cur.aiDrafted?.[locale]) && !granted.has(locale)) {
        deny(`the \`${locale}\` AI-provenance stamp is outside your grant.`, { sectionId: cur.sectionId, locale });
      }
    }
  });
}

// ── Shared sections (ADR 0204 C4, inherit-only v1) ──────────────────────────

/** A reusable section owned by the org — pages reference it (`Section.ref`)
 *  and inherit its content at delivery time. Content is validated/sanitized
 *  exactly like an inline section. */
export interface SharedSection {
  sharedSectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  type: SectionType;
  data: Record<string, unknown>;
  localizations?: Record<string, Record<string, unknown>>;
  /** ADR 0861 D6 — the same server-owned translation-status stamp as `Section`. */
  sourceDigest?: Record<string, string>;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const sharedSections = new DurableCollection<SharedSection>('cms:sharedsection', (s) => s.sharedSectionId);
const MAX_SHARED_SECTIONS = 100;

export async function listSharedSections(tenantId: string, orgId: string): Promise<SharedSection[]> {
  return (await sharedSections.list()).filter((s) => s.tenantId === tenantId && s.orgId === orgId);
}

export async function getSharedSection(tenantId: string, orgId: string, sharedSectionId: string): Promise<SharedSection | null> {
  const s = await sharedSections.get(sharedSectionId);
  return s && s.tenantId === tenantId && s.orgId === orgId ? s : null;
}

export async function createSharedSection(
  tenantId: string,
  orgId: string,
  input: { name: string; type: unknown; data: unknown; localizations?: unknown },
  createdBy: string,
  baseLocale = 'en',
): Promise<SharedSection> {
  const existing = await listSharedSections(tenantId, orgId);
  if (existing.length >= MAX_SHARED_SECTIONS) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX_SHARED_SECTIONS} shared sections.`, 409, { max: MAX_SHARED_SECTIONS });
  }
  const type = input.type as SectionType;
  if (!SECTION_TYPES.includes(type)) {
    throw new OpenwopError('validation_error', `type must be one of: ${SECTION_TYPES.join(', ')}`, 400, { type: input.type });
  }
  const d = (typeof input.data === 'object' && input.data !== null ? input.data : {}) as Record<string, unknown>;
  // ADR 0668 D1 — this lane never called `validateSection`, so the ADR 0593 §C9 guard had
  // NEVER run on a shared section, on either axis. `resolveSharedRefs` copies `data` AND
  // `localizations` into every page that references this section, so one poisoned shared
  // section is served everywhere it is used — the same defect as the page lane, wider.
  assertSectionTenant(type, d, tenantId);
  const data = buildSectionData(type, d, false);
  const localizations = validateLocalizations(type, input.localizations, baseLocale, tenantId, data);
  const ts = nowIso();
  const row: SharedSection = {
    sharedSectionId: `shsec:${randomUUID()}`,
    tenantId,
    orgId,
    name: cleanString(input.name, MAX.title, 'Untitled shared section'),
    type,
    data,
    ...(localizations && Object.keys(localizations).length > 0 ? { localizations } : {}),
    version: 1,
    createdBy,
    updatedBy: createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  const [stamped] = stampSourceDigests(undefined, [{ ...row, sectionId: row.sharedSectionId }]);
  if (stamped?.sourceDigest) row.sourceDigest = stamped.sourceDigest;
  await sharedSections.put(row);
  return row;
}

export async function updateSharedSection(
  tenantId: string,
  orgId: string,
  sharedSectionId: string,
  patch: { name?: string; data?: unknown; localizations?: unknown },
  updatedBy: string,
  baseLocale = 'en',
): Promise<SharedSection | null> {
  const cur = await getSharedSection(tenantId, orgId, sharedSectionId);
  if (!cur) return null;
  const next: SharedSection = { ...cur, updatedBy, updatedAt: nowIso(), version: cur.version + 1 };
  if (patch.name !== undefined) next.name = cleanString(patch.name, MAX.title, cur.name);
  if (patch.data !== undefined) {
    const d = (typeof patch.data === 'object' && patch.data !== null ? patch.data : {}) as Record<string, unknown>;
    assertSectionTenant(cur.type, d, tenantId); // ADR 0668 D1 — see createSharedSection
    next.data = buildSectionData(cur.type, d, false);
  }
  if (patch.localizations !== undefined || (patch.data !== undefined && next.localizations)) {
    // A base edit re-syncs the stored overlays' item states too (ADR 1038 D8).
    const loc = validateLocalizations(cur.type, patch.localizations !== undefined ? patch.localizations : next.localizations, baseLocale, tenantId, next.data);
    if (loc && Object.keys(loc).length > 0) next.localizations = loc;
    else delete next.localizations;
  }
  // ADR 0861 D6 — the stamp against the stored row (a base edit leaves an unchanged
  // overlay's stamp in place, which is what makes it read `outdated`).
  const [stamped] = stampSourceDigests(
    [{ sectionId: cur.sharedSectionId, ...(cur.localizations ? { localizations: cur.localizations } : {}), ...(cur.sourceDigest ? { sourceDigest: cur.sourceDigest } : {}) }],
    [{ ...next, sectionId: next.sharedSectionId }],
  );
  if (stamped?.sourceDigest) next.sourceDigest = stamped.sourceDigest;
  else delete next.sourceDigest;
  // ADR 1112 Phase E — a published page reads this section at delivery, so growing it
  // can take that page past the page limit with no publish to catch it. Measured with
  // the edit applied, before it is stored. Drafts meet the check when they publish.
  if (patch.data !== undefined || patch.localizations !== undefined) {
    for (const ref of await listPagesUsingSharedSection(tenantId, orgId, sharedSectionId)) {
      if (ref.status !== 'published') continue;
      const page = await getPage(tenantId, orgId, ref.pageId);
      if (page) await assertResolvedPageFits(page, next);
    }
  }
  await sharedSections.put(next);
  return next;
}

/** Pages referencing a shared section — the "impacted pages" list an editor
 *  MUST see before changing shared content (the research-doc acceptance
 *  criterion). Bounded by the per-org page cap. */
/**
 * ADR 0593 §C9 (adversarial review of #3428, F1) — THE sections a reader can
 * actually be served for this page: its own, PLUS every section inside a
 * snapshot bound to a RUNNING experiment.
 *
 * This is the root cause under CMSA-1 and CMSA-10 alike. Every page-set scan in
 * this feature read `page.sections`, and delivery does not always serve
 * `page.sections`: `publicPageBySlug` (ADR 0236 D1) substitutes
 * `version.snapshot.sections` for a visitor on a non-holdout arm, and BOTH
 * `resolveSharedRefs` and `localizePage` then run over the SNAPSHOT. A section
 * dropped from the live page but surviving in a bound snapshot was therefore
 * invisible to `listPagesUsingSharedSection` and to the language-settings
 * scans — while still reaching the public. Proven twice, anonymously, with the
 * gate ON (`test/cms-bound-snapshot-delivery.test.ts`).
 *
 * RUNNING only, deliberately: a draft or stopped experiment serves nobody, and
 * including it would refuse edits that reach no reader — the over-refusal half
 * of the same mistake (§C9 F2). The cost of that choice is that STARTING an
 * experiment enlarges this set, so `startExperiment` re-checks the gate for the
 * same reason it re-checks the snapshot's review stamp.
 *
 * Bounded: ≤1 running experiment per page × `MAX.variants` snapshot reads.
 */
export async function deliverableSectionsForPage(page: Page): Promise<Section[]> {
  const out = [...page.sections];
  // Only a PUBLISHED page has an experiment delivery lane — `publicPageBySlug`
  // reaches the variant path through `getPublishedBySlug`, which is
  // published-only. An in_review page's snapshots serve nobody.
  if (page.status !== 'published') return out;
  const running = await findRunningExperiment(page.tenantId, page.orgId, page.pageId);
  if (!running) return out;
  for (const v of running.variants) {
    if (!v.versionId) continue; // the holdout serves the live page
    const version = await getVersion(page.tenantId, page.orgId, page.pageId, v.versionId);
    if (version) out.push(...version.snapshot.sections);
  }
  return out;
}

export async function listPagesUsingSharedSection(tenantId: string, orgId: string, sharedSectionId: string): Promise<Array<{ pageId: string; title: string; slug: string; status: PageStatus; scheduledPublishAt?: string }>> {
  const all = await listPages(tenantId, orgId);
  const out: Array<{ pageId: string; title: string; slug: string; status: PageStatus; scheduledPublishAt?: string }> = [];
  for (const p of all) {
    // §C9 F1 — the DELIVERABLE sections, not merely the live ones.
    const sections = await deliverableSectionsForPage(p);
    if (sections.some((s) => s.ref?.sharedSectionId === sharedSectionId)) {
      out.push({ pageId: p.pageId, title: p.title, slug: p.slug, status: p.status, ...(p.scheduledPublishAt ? { scheduledPublishAt: p.scheduledPublishAt } : {}) });
    }
  }
  return out;
}

/**
 * ADR 0836 D6 — the ONE live-tier rule. A write that changes what this page's
 * readers see (now, or when its scheduled publish fires) needs the admin tier
 * (`host:members:manage`), whatever the approval-gate setting. Page PATCH and
 * delete already held this for non-draft pages (ADR 0748); SEO and shared-section
 * content did not, and neither did a SCHEDULED draft — whose SEO row and shared
 * content change without moving the page `version` the schedule is pinned to.
 */
export function isLiveTierPage(p: { status: PageStatus; scheduledPublishAt?: string }): boolean {
  return p.status !== 'draft' || Boolean(p.scheduledPublishAt);
}

/** Delete a shared section — 409 while any page still references it (the
 *  reference would dangle; delivery drops dangling refs but the editor must
 *  clean up deliberately). */
export async function deleteSharedSection(tenantId: string, orgId: string, sharedSectionId: string): Promise<boolean> {
  const cur = await getSharedSection(tenantId, orgId, sharedSectionId);
  if (!cur) return false;
  const used = await listPagesUsingSharedSection(tenantId, orgId, sharedSectionId);
  if (used.length > 0) {
    throw new OpenwopError('conflict', `Shared section is referenced by ${used.length} page(s) — detach or remove those sections first.`, 409, { pages: used.map((p) => p.pageId) });
  }
  await sharedSections.delete(sharedSectionId);
  return true;
}

/**
 * Resolve `Section.ref` references into concrete content for DELIVERY (the
 * editor keeps raw refs). A dangling ref (shared section deleted) is DROPPED
 * from delivery — never rendered empty. Type comes from the shared row (the
 * source of truth; the ref section's own `type` is a hint for the editor).
 */
/**
 * ADR 0861 D6 — the page's translation status over the given locales: per section,
 * per locale, plus per-locale counts. A shared-section reference reports the SHARED
 * row's status (its own `localizations` are empty by construction, review M3). An
 * editor-facing read: digests never leave the server, only the verdicts do.
 */
export async function pageTranslationStatus(
  page: Page,
  locales: readonly string[],
): Promise<{ sections: Record<string, Record<string, TranslationStatus>>; counts: Record<string, Record<TranslationStatus, number>> }> {
  const sections: Record<string, Record<string, TranslationStatus>> = {};
  const counts: Record<string, Record<TranslationStatus, number>> = {};
  for (const l of locales) counts[l] = { missing: 0, current: 0, outdated: 0, unknown: 0 };
  for (const sec of page.sections) {
    const source = sec.ref ? await getSharedSection(page.tenantId, page.orgId, sec.ref.sharedSectionId) : sec;
    if (!source || Object.keys(source.data ?? {}).length === 0) continue; // nothing to translate
    const row: Record<string, TranslationStatus> = {};
    for (const l of locales) {
      const st = translationStatus(source, l);
      row[l] = st;
      counts[l]![st] += 1;
    }
    sections[sec.sectionId] = row;
  }
  return { sections, counts };
}

export async function resolveSharedRefs(page: Page, pending?: SharedSection): Promise<Page> {
  if (!page.sections.some((s) => s.ref)) return page;
  const resolved: Section[] = [];
  for (const s of page.sections) {
    if (!s.ref) { resolved.push(s); continue; }
    // `pending`: a shared-section edit not yet stored, measured as if it were (ADR 1112 Phase E).
    const shared = pending && pending.sharedSectionId === s.ref.sharedSectionId
      ? pending
      : await getSharedSection(page.tenantId, page.orgId, s.ref.sharedSectionId);
    if (!shared) continue; // dangling — drop from delivery
    resolved.push({
      sectionId: s.sectionId,
      type: shared.type,
      data: shared.data,
      ...(shared.localizations ? { localizations: shared.localizations } : {}),
    });
  }
  return { ...page, sections: resolved };
}

// ── Scheduled publishing (ADR 0204 C2) ──────────────────────────────────────

/** Set (or replace) a page's one-shot scheduled publish time. Caller (route)
 *  enforces admin scope + the approval-gate 409; here we validate the page is
 *  in a publishable status and the time parses to the future. */
export async function setScheduledPublish(tenantId: string, orgId: string, pageId: string, atIso: string, actor: string): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (p.status !== 'draft' && p.status !== 'in_review') {
    throw new OpenwopError('validation_error', `Cannot schedule a page in status \`${p.status}\` — only draft/in_review pages can be scheduled.`, 409, { status: p.status });
  }
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new OpenwopError('validation_error', 'Invalid `at` — expected an ISO-8601 timestamp.', 400, { at: atIso });
  if (at <= Date.now()) throw new OpenwopError('validation_error', '`at` must be in the future.', 400, { at: atIso });
  // ADR 0836 D3 — pin the schedule to the content the scheduler is looking at.
  const next: Page = { ...p, scheduledPublishAt: new Date(at).toISOString(), scheduledPublishVersion: p.version, updatedBy: actor, updatedAt: nowIso() };
  await casPage(p, next);
  // ADR 0408 — the sweep reads MARKERS, never the page store (see the sweep).
  await dropMarker(scheduledMarkers, tenantId, orgId, pageId); // a legacy bare-pageId row, if any
  await scheduledMarkers.put({ pageId: next.pageId, tenantId, orgId, at: next.scheduledPublishAt ?? '' });
  recordCmsAction('schedule', next, actor, { scheduledPublishAt: next.scheduledPublishAt });
  return next;
}

/** Cancel a pending scheduled publish (or record a sweep skip — `reason`). */
export async function clearScheduledPublish(tenantId: string, orgId: string, pageId: string, actor: string, reason = 'cancelled'): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (!p.scheduledPublishAt) return p;
  const next: Page = { ...p, updatedBy: actor, updatedAt: nowIso() };
  delete next.scheduledPublishAt;
  delete next.scheduledPublishVersion;
  await casPage(p, next);
  await dropMarker(scheduledMarkers, tenantId, orgId, pageId);
  recordCmsAction('schedule-cleared', next, actor, { reason });
  return next;
}

/** Pages whose scheduled publish time has passed and are still publishable —
 *  the sweep's work list. ADR 0408: reads the tiny `cms:scheduled` MARKER set
 *  (never a page scan — cheaper than the pre-kernel cross-tenant scan);
 *  stale markers (page gone / schedule cleared out-of-band) self-heal here. */
export async function listScheduledDuePages(nowIso_: string): Promise<Page[]> {
  const due = (await scheduledMarkers.list()).filter((m) => m.at <= nowIso_);
  const out: Page[] = [];
  for (const m of due) {
    const p = await getPage(m.tenantId, m.orgId, m.pageId);
    if (p && p.scheduledPublishAt && p.scheduledPublishAt <= nowIso_ && (p.status === 'draft' || p.status === 'in_review')) {
      out.push(p);
    } else {
      await dropMarker(scheduledMarkers, m.tenantId, m.orgId, m.pageId); // self-heal
    }
  }
  return out;
}

// ── Scheduled unpublish (ADR 0204 C2b — embargo end) ────────────────────────

/** Set (or replace) a page's one-shot scheduled UNPUBLISH time. Legal while
 *  the page is `published`, or while a publish schedule is pending (the
 *  embargo pair, in which case the unpublish must be strictly later). The
 *  approval gate deliberately does NOT apply here: the gate protects the
 *  PUBLISH direction (content going public); unpublishing removes content —
 *  the fail-safe direction (Contentful/Sanity likewise leave it ungated). */
export async function setScheduledUnpublish(tenantId: string, orgId: string, pageId: string, atIso: string, actor: string): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const pairedWithPendingPublish = (p.status === 'draft' || p.status === 'in_review') && Boolean(p.scheduledPublishAt);
  if (p.status !== 'published' && !pairedWithPendingPublish) {
    throw new OpenwopError('validation_error', `Cannot schedule an unpublish for a page in status \`${p.status}\` — the page must be published, or have a pending scheduled publish.`, 409, { status: p.status });
  }
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new OpenwopError('validation_error', 'Invalid `at` — expected an ISO-8601 timestamp.', 400, { at: atIso });
  if (at <= Date.now()) throw new OpenwopError('validation_error', '`at` must be in the future.', 400, { at: atIso });
  const iso = new Date(at).toISOString();
  if (pairedWithPendingPublish && p.scheduledPublishAt && iso <= p.scheduledPublishAt) {
    throw new OpenwopError('validation_error', 'The unpublish time must be after the scheduled publish time.', 400, { at: iso, scheduledPublishAt: p.scheduledPublishAt });
  }
  const next: Page = { ...p, scheduledUnpublishAt: iso, updatedBy: actor, updatedAt: nowIso() };
  await casPage(p, next);
  await dropMarker(scheduledUnpublishMarkers, tenantId, orgId, pageId); // a legacy bare-pageId row, if any
  await scheduledUnpublishMarkers.put({ pageId: next.pageId, tenantId, orgId, at: iso });
  recordCmsAction('schedule-unpublish', next, actor, { scheduledUnpublishAt: iso });
  return next;
}

/** Cancel a pending scheduled unpublish (or record a sweep skip — `reason`). */
export async function clearScheduledUnpublish(tenantId: string, orgId: string, pageId: string, actor: string, reason = 'cancelled'): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (!p.scheduledUnpublishAt) return p;
  const next: Page = { ...p, updatedBy: actor, updatedAt: nowIso() };
  delete next.scheduledUnpublishAt;
  await casPage(p, next);
  await dropMarker(scheduledUnpublishMarkers, tenantId, orgId, pageId);
  recordCmsAction('schedule-unpublish-cleared', next, actor, { reason });
  return next;
}

/** Pages whose scheduled unpublish time has passed and are still PUBLISHED —
 *  the unpublish lane's work list. The fire guard is `published` ONLY: an
 *  archived page is legal for a MANUAL unpublish but a scheduled one firing
 *  there would yank it to draft as a surprise — such markers self-heal with
 *  the schedule cleared out-of-band (the sweep audits the skip). */
export async function listScheduledDueUnpublishPages(nowIso_: string): Promise<Page[]> {
  const due = (await scheduledUnpublishMarkers.list()).filter((m) => m.at <= nowIso_);
  const out: Page[] = [];
  for (const m of due) {
    const p = await getPage(m.tenantId, m.orgId, m.pageId);
    if (p && p.scheduledUnpublishAt && p.scheduledUnpublishAt <= nowIso_ && p.status === 'published') {
      out.push(p);
    } else if (p && p.scheduledUnpublishAt && p.scheduledUnpublishAt <= nowIso_) {
      // Due but NOT published (e.g. the pair's publish was cancelled and the
      // page never went live): clear BOTH field and marker with an audit —
      // deleting only the marker would strand a forever-"pending" schedule
      // the page still displays and no lane will ever fire.
      // ADR 0836 — now a CAS write, so it can 409; one page must not stop the tick.
      await clearScheduledUnpublish(m.tenantId, m.orgId, m.pageId, 'system:cms-scheduler', 'not-published')
        .catch((err: unknown) => log.warn('cms_unpublish_marker_clear_failed', { pageId: m.pageId, error: err instanceof Error ? err.message : String(err) }));
    } else {
      await dropMarker(scheduledUnpublishMarkers, m.tenantId, m.orgId, m.pageId); // stale marker — self-heal
    }
  }
  return out;
}

/** Resolve a slug to a PUBLISHED page, following at most one redirect hop. Drafts
 *  / in-review / archived pages are invisible by slug. */
export async function getPublishedBySlug(tenantId: string, orgId: string, slug: string): Promise<{ page: Page; redirectedFrom?: string } | null> {
  const all = await listPages(tenantId, orgId);
  const direct = all.find((p) => p.slug === slug && p.status === 'published');
  // ADR 0204 C4 — the ONE delivery chokepoint resolves shared-section refs
  // (every published read routes through here: cms by-slug, publishing public
  // page, /v1/content, the workflow surface's getPage).
  if (direct) return { page: await resolveSharedRefs(direct) };
  const redirect = (await redirects.list()).find((r) => r.tenantId === tenantId && r.orgId === orgId && r.fromSlug === slug);
  if (redirect) {
    const target = all.find((p) => p.slug === redirect.toSlug && p.status === 'published');
    if (target) return { page: await resolveSharedRefs(target), redirectedFrom: slug };
  }
  return null;
}

// ── Content language settings + localized delivery (ADR 0064) ───────────────
//
// ADR 0406 Phase 1 (the ADR 0408 parity seam): the settings model + store
// moved to core `host/contentLocales.ts` so cms and entities consume ONE
// locale truth per org. The collection name (`cms:langsettings`) and every
// symbol are unchanged — this re-export keeps all consumers and the wire
// byte-identical; cms remains the management ROUTE surface.
import {
  getContentLanguageSettings,
  getStoredContentLanguageSettings,
  updateContentLanguageSettings,
  __resetContentLocales,
  type ContentLanguageSettings,
} from '../../host/contentLocales.js';
export { getContentLanguageSettings, getStoredContentLanguageSettings, updateContentLanguageSettings, type ContentLanguageSettings };

/** A delivery-shaped section: base+overlay resolved to one locale; `localizations`
 *  stripped (public delivery never exposes other locales). */
export interface DeliverySection {
  sectionId: string;
  type: SectionType;
  data: Record<string, unknown>;
}

/**
 * ADR 0861 D1 — the ONE derivation of a page's withheld locales: every
 * `localePublishState` key held at `'draft'`, configured or not. Delivery,
 * the settings live-edit diff and the editor's preview mirror
 * (`resolvePreviewLocale.ts`) all model the same set.
 */
export function withheldLocales(page: Pick<Page, 'localePublishState'>): string[] {
  return Object.entries(page.localePublishState ?? {}).filter(([, v]) => v === 'draft').map(([l]) => l);
}

/**
 * Resolve a page's sections for delivery in the locale negotiated from
 * `Accept-Language` (RFC 0103 / ADR 0064). When the org has authored no
 * `supportedLocales`, this negotiates to the base and returns base `data` —
 * byte-identical to the non-localized CMS. Returns the page with resolved
 * sections + the locale actually used (for `Content-Language`).
 */
export function localizePage(
  page: Page,
  acceptLanguage: string | undefined | null,
  settings: ContentLanguageSettings,
): { page: Omit<Page, 'sections'> & { sections: DeliverySection[] }; locale: string; served: string[] } {
  // ADR 0205 D2 — a locale explicitly held in `'draft'` is withheld from
  // delivery: it is removed from the negotiable set AND its overlays are
  // stripped before resolution, so requests fall through the existing RFC 0103
  // chain (family → base). Absent state = published (backward compatible).
  //
  // ADR 0861 D1 (CMSL2WF-1) — the withheld set is a property of the PAGE. It was
  // `supportedLocales.filter(draft)`, so a hold only bit while its locale was also
  // configured: a withheld `pt` reached a `pt-BR` reader through the family step
  // the moment `pt` left the org's locales (the ungated narrowing direction).
  const withheld = withheldLocales(page);
  const deliverable = settings.supportedLocales.filter((l) => !withheld.includes(l));
  const supported = [settings.baseLocale, ...deliverable];
  const locale = supported.length > 1
    ? negotiateLocale(acceptLanguage, supported, settings.baseLocale)
    : settings.baseLocale;
  const sections: DeliverySection[] = page.sections.map((s) => {
    let source = s;
    if (withheld.length > 0 && s.localizations) {
      const loc = { ...s.localizations };
      for (const l of withheld) delete loc[l];
      source = { ...s, ...(Object.keys(loc).length > 0 ? { localizations: loc } : {}) };
      if (Object.keys(loc).length === 0) delete source.localizations;
    }
    return {
      sectionId: s.sectionId,
      type: s.type,
      data: resolveSection(source, locale, settings.baseLocale),
    };
  });
  // ADR 0861 D5 — the locales this page actually serves (base first), for the
  // prerender's hreflang. Computed HERE because only this function holds the stored
  // row; the public projection carries no `localePublishState`.
  return { page: { ...page, sections }, locale, served: supported };
}

/** Flip one locale's publish state (ADR 0205 D2). Admin-tier at the route;
 *  only configured supported locales are addressable. */
export async function setLocalePublishState(
  tenantId: string,
  orgId: string,
  pageId: string,
  locale: string,
  state: 'draft' | 'published',
  actor: string,
  // ADR 0861 D2 — runs on THIS read, the one the CAS compares (the ADR 0836
  // `updatePage` shape). The release route's live-edit gate lives here.
  opts?: { authorize?: (current: Page) => Promise<void> },
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (opts?.authorize) await opts.authorize(p);
  const settings = await getContentLanguageSettings(tenantId, orgId);
  // ADR 0593 §C8 (adversarial review F3) — the "configured locale" precondition
  // applies to the RELEASE direction only. It used to apply to both, and that
  // made the §C2 widening refusal a gate with no PRACTICAL exit: the safe way
  // to add a locale is to withhold it per page FIRST and then release each page
  // through the already-gated publish route — but withholding an unconfigured
  // locale 400'd, and adding it was refused because it was not withheld. A
  // perfect circle, whose only remaining exit was unpublishing every live page
  // that held an overlay. Withholding removes content from delivery, so opening
  // it is the same fail-safe direction `unpublish` and the widening/narrowing
  // split already turn on.
  if (state === 'published' && !settings.supportedLocales.includes(locale)) {
    throw new OpenwopError('validation_error', `\`${locale}\` is not a configured translation locale for this org.`, 400, { locale });
  }
  if (!LOCALE_RE.test(locale) || locale === settings.baseLocale) {
    throw new OpenwopError('validation_error', `\`${locale}\` is not a valid non-base translation locale.`, 400, { locale });
  }
  // ADR 0593 (CMSA-8) — bump the version. This was the ONE page write outside
  // the version discipline, and therefore invisible to the approval pin: a
  // locale could be withheld or released while the page sat `in_review` and the
  // approve would never notice. Low-stakes (admin tier, delivery state rather
  // than content) but it is the same closed world the pin depends on, so it
  // joins it rather than being an exception a later reader has to rediscover.
  const next: Page = { ...p, updatedBy: actor, updatedAt: nowIso(), version: p.version + 1 };
  const map = { ...(p.localePublishState ?? {}) };
  if (state === 'published') delete map[locale]; // absent = published (compat)
  else map[locale] = 'draft';
  if (Object.keys(map).length > 0) next.localePublishState = map;
  else delete next.localePublishState;
  // ADR 0836 D3 — admin tier (the route requires `host:members:manage`), so a
  // pending scheduled publish follows this version rather than dying at fire time.
  if (next.scheduledPublishAt) next.scheduledPublishVersion = next.version;
  await casPage(p, next);
  recordCmsAction('locale-publish-state', next, actor, { locale, state });
  return next;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCms(): Promise<void> {
  await pages.__clear();
  await versions.__clear();
  await redirects.__clear();
  await __resetContentLocales();
  await sharedSections.__clear();
  await localeGrants.__clear();
}

/** R3 (UX_UPGRADE-content known-open) — subject erasure over the KERNEL-adapted
 *  page store (the legacy `cms:page` collection is read-dark; an eraser writing
 *  it would touch rows nothing reads — which is why this lives HERE, beside the
 *  adapter, not in a module with its own store handles). Anonymize-not-delete
 *  for org content; the subject's OWN locale grant is DELETED (an anonymized
 *  grant would still grant, to nobody auditable). */
export const ERASED_SUBJECT = 'erased:subject';

/** DG-1112-6 / RI-1112-1 — the page with every locale overlay put back through
 *  `restoreItemStates` against its base, or null when none changes. The test is the
 *  integrity gauge's own (`integrityGauge.ts` `staleItemOverlays`), so a repaired page
 *  stops counting. Only base-owned item states move (ADR 1038 D8, ADR 1112 D6); no
 *  translated text changes, so each overlay's source digest is kept as stored. */
export function realignPageOverlays(page: Page): { next: Page; overlays: number } | null {
  let overlays = 0;
  const sections = page.sections.map((s) => {
    if (!s.localizations) return s;
    const base = typeof s.data === 'object' && s.data !== null ? s.data : {};
    let changed = false;
    const localizations: Record<string, Record<string, unknown>> = {};
    for (const [locale, overlay] of Object.entries(s.localizations)) {
      const fixed = typeof overlay === 'object' && overlay !== null ? restoreItemStates(base, overlay, s.type) : overlay;
      if (JSON.stringify(fixed) !== JSON.stringify(overlay)) { changed = true; overlays += 1; }
      localizations[locale] = fixed;
    }
    return changed ? { ...s, localizations } : s;
  });
  return overlays > 0 ? { next: { ...page, sections }, overlays } : null;
}

export interface OverlayRealignReport {
  pages: number;
  stalePages: number;
  staleOverlays: number;
  realigned: number;
  /** Pages the stored-row validator refuses; the author's next save repairs them. */
  invalid: number;
  /** Pages that changed twice under the job; the next boot retries them. */
  conflicts: number;
  truncatedTenants: number;
  invalidPageIds: string[];
}

/** DG-1112-6 — one pass over every tenant's pages. `report` counts and writes nothing;
 *  `apply` CASes each stale page (same version and author, like the erasure rewrite),
 *  retrying once on a concurrent edit. */
export async function realignStoredOverlays(mode: 'report' | 'apply', perTenantCap = 10_000): Promise<OverlayRealignReport> {
  const { pages: listed, truncatedTenants } = await listAllPagesForIntegrityGauge(perTenantCap);
  const r: OverlayRealignReport = { pages: listed.length, stalePages: 0, staleOverlays: 0, realigned: 0, invalid: 0, conflicts: 0, truncatedTenants, invalidPageIds: [] };
  for (const page of listed) {
    const fix = realignPageOverlays(page);
    if (!fix) continue;
    r.stalePages += 1;
    r.staleOverlays += fix.overlays;
    if (mode === 'report') continue;
    for (let attempt = 0; ; attempt += 1) {
      const cur = await getPage(page.tenantId, page.orgId, page.pageId);
      const next = cur ? realignPageOverlays(cur)?.next : undefined;
      if (!cur || !next) break; // deleted, or already repaired by a save
      try {
        await casPage(cur, next);
        r.realigned += 1;
        break;
      } catch (err) {
        if (err instanceof OpenwopError && err.code === 'conflict') {
          if (attempt === 0) continue;
          r.conflicts += 1;
        } else if (err instanceof OpenwopError && err.code === 'validation_error') {
          r.invalid += 1;
          r.invalidPageIds.push(page.pageId);
        } else {
          throw err;
        }
        break;
      }
    }
  }
  return r;
}

export async function eraseCmsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!subjectKey) return { rowsTouched: 0 };
  // ADR 0592 §8 — match every subject-key FORM (raw `alice` + scoped
  // `user:alice`): the DSAR entry point accepts either, while cms rows store
  // the raw principal (the approvals eraser's subjectKeyForms discipline; a
  // scoped-vs-raw mismatch used to no-op silently).
  const { forms } = subjectKeyForms(subjectKey);
  const hit = (v: unknown): boolean => typeof v === 'string' && forms.has(v);
  let touched = 0;
  // ADR 0836 D1 — the list is a whole-tenant snapshot, so a plain `put` reverted
  // any edit (or schedule change) made since it was taken. Re-read and CAS each
  // page; one retry absorbs a concurrent edit, a second miss is a real error.
  const redact = (p: Page): Page | null => {
    let next: Page | null = null;
    if (hit(p.authorId)) next = { ...(next ?? p), authorId: ERASED_SUBJECT };
    if (hit(p.createdBy)) next = { ...(next ?? p), createdBy: ERASED_SUBJECT };
    if (hit(p.updatedBy)) next = { ...(next ?? p), updatedBy: ERASED_SUBJECT };
    return next;
  };
  for (const listed of await pages.listForTenant(tenantId)) {
    if (listed.tenantId !== tenantId || !redact(listed)) continue;
    for (let attempt = 0; ; attempt += 1) {
      const p = await getPage(tenantId, listed.orgId, listed.pageId);
      const next = p ? redact(p) : null;
      if (!p || !next) break;
      try {
        await casPage(p, next);
        touched += 1;
        break;
      } catch (err) {
        if (attempt === 0 && err instanceof OpenwopError && err.code === 'conflict') continue;
        throw err;
      }
    }
  }
  for (const v of await tenantVersions(tenantId)) {
    if (!hit(v.publishedBy)) continue;
    await versions.put({ ...v, publishedBy: ERASED_SUBJECT });
    touched += 1;
  }
  for (const g of await localeGrants.list()) {
    if (g.tenantId !== tenantId) continue;
    if (hit(g.subject)) { await localeGrants.delete(g.grantId); touched += 1; continue; }

    if (hit(g.updatedBy)) { await localeGrants.put({ ...g, updatedBy: ERASED_SUBJECT }); touched += 1; }
  }
  // ADR 0592 §8 (CMSL-4) — the two stores the eraser NEVER enumerated:
  // shared-section attribution and the per-org language-settings operator
  // attribution (anonymize-not-delete, same as pages).
  for (const s of await sharedSections.list()) {
    if (s.tenantId !== tenantId) continue;
    let next: SharedSection | null = null;
    if (hit(s.createdBy)) next = { ...(next ?? s), createdBy: ERASED_SUBJECT };
    if (hit(s.updatedBy)) next = { ...(next ?? s), updatedBy: ERASED_SUBJECT };
    if (next) { await sharedSections.put(next); touched += 1; }
  }
  touched += await eraseContentLanguageSettingsSubject(tenantId, forms, ERASED_SUBJECT);
  // ADR 0592 §8 (CMSLWF-9) — page-experiment creator attribution (cms-owned
  // sibling store; call-time import keeps the module edge cycle-safe).
  touched += await erasePageExperimentSubject(tenantId, forms, ERASED_SUBJECT);
  log.info('cms_subject_erased', { tenantId, rows: touched });
  return { rowsTouched: touched };
}
