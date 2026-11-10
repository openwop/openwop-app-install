/**
 * Shared CMS section renderer (ADR 0027). ONE renderer for two modes:
 *   - `mode="editor"` — a rough live preview inside the CMS / Front-page editor.
 *   - `mode="public"` — the designed marketing front page (the "engineering
 *     broadsheet": serif display, mono numerals, the node-glyph motif, the
 *     cards / steps / stats layouts). Styled in styles/global.css (`.fp-*`).
 *
 * Content-safety posture (ADR 0009): NO `dangerouslySetInnerHTML`. Prose runs
 * through a tiny SAFE markdown subset — paragraphs, `### ` subheadings, `- ` /
 * `1. ` lists and `> ` quotes (ADR 0813, `proseBlocks.ts`) + `**bold**` /
 * `*italic*` / `` `code` `` / `[label](url)` with an http(s)/mailto /
 * internal-path guard.
 */
import { DesignSection, HeroQueue, isDesignSection, RichTextCard } from './DesignSections.js';
import { CtaLink, isFragment, isInternal, isSafeHref } from './CtaLink.js';
import type { CSSProperties, ReactNode } from 'react';
import { Fragment, Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { formatNumber } from '../../i18n/format.js';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import type { Section } from './cmsClient.js';
import { assetUrl } from './cmsClient.js';
import { headingSlug } from './headingSlug.js';
import { HeadingText, stripHeadingEmphasis } from './headingEmphasis.js';
import { parseProseBlocks } from './proseBlocks.js';
import { ActivityCard, ChatCard, FlowFigure, FlowRail, HERO_VISUALS, Marquee, PanelArt, PlanCard, ProgressBar, StatValue, fraction, heroEmphasisClass, sectionMotionClass, sectionStyleClass, type HeroVisual } from './sectionStyles.js';
import { HeroArtFigure, isHeroArtVisual } from './heroArt.js';
import { config, fetchOpts } from '../../client/config.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { useFormat } from '../../i18n/useFormat.js';
import { useDemoMode } from '../../client/useDemoMode.js';
import { brand } from '../../brand/brand.js';
import { isStockOpenwopBrand } from '../../brand/defaults.js';
// ADR 0331 §D2 — the ONE public fill renderer, lazy so public pages without a
// form section never load it (and cms/→forms/ stays a soft edge).
// ADR 0820 §7 — the pricing section (tier grid, cadence switch, comparison,
// add-ons, credit packs) is its own chunk: only /pricing and pages that author a
// pricing section ever load it.
const LazyPricingSection = lazy(() => import('./PricingSection.js').then((m) => ({ default: m.PricingSection })));
const LazyPublicFormRenderer = lazy(() => import('../forms/render/PublicFormRenderer.js').then((m) => ({ default: m.PublicFormRenderer })));
import type { IconCmp } from '../../chrome/featureTypes.js';
import {
  MessageSquareIcon, MessageCircleIcon, BotIcon, WorkflowIcon, FolderIcon,
  InboxIcon, ColumnsIcon, ClockIcon, MonitorIcon, PlayIcon, BoxesIcon,
  PackageIcon, BriefcaseIcon, ShieldIcon, DatabaseIcon, StarIcon, ActivityIcon,
  BookOpenIcon, FileTextIcon, PencilIcon, MicIcon, SparklesIcon, ImageIcon,
  LayoutGridIcon, GlobeIcon, ClipboardIcon, ScaleIcon, FlagIcon, LifeBuoyIcon,
  ListIcon, MegaphoneIcon, LockIcon, PlugIcon, KeyIcon, BuildingIcon, UserIcon,
  SettingsIcon, TerminalIcon, LinkIcon,
  // ADR 1047 — hub spoke glyphs.
  UsersIcon, PhoneIcon, CodeIcon, MoonIcon, DevicesIcon,
  // ADR 1068 D2 — the incidents' billing glyph.
  CreditCardIcon,
  ArrowRightIcon, ArrowUpRightIcon,
} from '../../ui/icons/index.js';

/** Per-feature card icons (ADR 0027). A card's `icon` slug (authored in
 *  featurePages.json / editable in the CMS) maps to one glyph here; an absent or
 *  unknown slug falls back to the node motif (`NodeGlyph`). Slugs are semantic,
 *  so several may resolve to the same Lucide glyph across distant sections. */
const ICON_BY_SLUG: Record<string, IconCmp> = {
  chat: MessageSquareIcon, channels: MessageCircleIcon, comments: MessageCircleIcon,
  bot: BotIcon, workflow: WorkflowIcon, folder: FolderIcon, inbox: InboxIcon,
  board: ColumnsIcon, clock: ClockIcon, monitor: MonitorIcon, play: PlayIcon,
  boxes: BoxesIcon, package: PackageIcon, roster: BriefcaseIcon, briefcase: BriefcaseIcon,
  shield: ShieldIcon, database: DatabaseIcon, star: StarIcon, activity: ActivityIcon,
  book: BookOpenIcon, file: FileTextIcon, pencil: PencilIcon, mic: MicIcon,
  sparkles: SparklesIcon, image: ImageIcon, grid: LayoutGridIcon, globe: GlobeIcon,
  clipboard: ClipboardIcon, scale: ScaleIcon, flag: FlagIcon, lifebuoy: LifeBuoyIcon,
  list: ListIcon, megaphone: MegaphoneIcon, lock: LockIcon, plug: PlugIcon,
  key: KeyIcon, building: BuildingIcon, user: UserIcon, settings: SettingsIcon,
  terminal: TerminalIcon, link: LinkIcon,
  // ADR 1047 — the hub's places (team chat, customers, phone, code, overnight, devices).
  users: UsersIcon, phone: PhoneIcon, code: CodeIcon, moon: MoonIcon, device: DevicesIcon, card: CreditCardIcon, arrow: ArrowRightIcon,
};

/** A node-supplied string field, or '' when absent/non-string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

export type SectionRenderMode = 'editor' | 'public';



/** Inline markdown → React nodes: `**bold**`, `*italic*`, `` `code` ``,
 *  `[label](url)`, and `==highlight==` (ADR 1068 D2, a `<mark>`). No raw HTML;
 *  an unsafe link degrades to plain text. */
function inlineMarkdown(text: string, keyPrefix: string, opts?: { codeAsCite?: boolean }): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|==([^=\n]+)==/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    // ADR 1064 P3f — in a `sources` rich text, a code span is a citation pill.
    else if (m[3] !== undefined) out.push(opts?.codeAsCite ? <cite key={key} className="fp-src">{m[3]}</cite> : <code key={key} className="fp-code">{m[3]}</code>);
    else if (m[4] !== undefined && m[5] !== undefined) {
      const label = m[4]; const url = m[5];
      out.push(isSafeHref(url)
        ? <a key={key} href={url} rel="noopener noreferrer">{label}</a>
        : isInternal(url) ? <Link key={key} to={url}>{label}</Link> : label);
    }
    // ADR 1068 D2 — a highlighted phrase (the design's ink highlight). A real
    // <mark>, so the emphasis is not carried by colour alone.
    else if (m[6] !== undefined) out.push(<mark key={key} className="fp-mark">{m[6]}</mark>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A paragraph that is exactly one bold run (`**…**`, no other text). */
const isKicker = (text: string): boolean => /^\*\*[^*]+\*\*$/.test(text.trim());

/** Render `text` as prose blocks (paragraphs, `###` subheadings, lists,
 *  quotes), inline-formatted. Still no raw HTML. */
function RichText({ text, className = 'cms-richtext', sources = false }: { text: string; className?: string; sources?: boolean }): JSX.Element {
  const blocks = parseProseBlocks(text);
  const im = (s: string, k: string): ReactNode[] => inlineMarkdown(s, k, { codeAsCite: sources });
  if (blocks.length === 0) return <p className={className} />;
  return <>{blocks.map((b, i) => {
    const k = `b${i}`;
    switch (b.kind) {
      case 'h3': return <h3 key={k} className="cms-prose-h3">{im(b.text, k)}</h3>;
      case 'ul': return <ul key={k} className="cms-prose-list">{b.items.map((it, j) => <li key={j}>{im(it, `${k}-${j}`)}</li>)}</ul>;
      case 'ol': return <ol key={k} className="cms-prose-list">{b.items.map((it, j) => <li key={j}>{im(it, `${k}-${j}`)}</li>)}</ol>;
      case 'quote': return <blockquote key={k} className="cms-prose-quote">{im(b.text, k)}</blockquote>;
      // An opening paragraph that is one bold run reads as the essay's kicker
      // (`**You've heard it…**`): a larger lead-in, still a real <p>.
      default: return <p key={k} className={className === 'fp-prose__p' && i === 0 && isKicker(b.text) ? 'fp-prose__p fp-prose__p--kicker' : className}>{im(b.text, k)}</p>;
    }
  })}</>;
}

// ── Public (front-page) building blocks ─────────────────────────────────────

/** Mono eyebrow + serif heading + an optional one-line orienting lede — the
 *  recurring section header. The lede gives a first-time reader one sentence of
 *  context under the heading (ADR 0027 Features page). */
function SectionHead({ eyebrow, heading, lede }: { eyebrow?: string | undefined; heading?: string | undefined; lede?: string | undefined }): JSX.Element | null {
  if (!eyebrow && !heading && !lede) return null;
  return (
    <header className="fp-head">
      {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
      {/* R2-D10 (UX_UPGRADE-docs) — a STABLE anchor id from the heading text,
          so fragment links resolve on cold load (they used to exist only after
          the docs TOC mutated the DOM) and the prerendered HTML carries the
          same ids for bots. Two sections sharing one heading collide: in the
          prerender first-wins (documented there); in the docs SPA `deriveToc`
          rewrites the LATER duplicate (R2R-1), keeping the first id stable. */}
      {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-head__title"><HeadingText text={heading} /></h2> : null}
      {lede ? <p className="fp-head__lede">{inlineMarkdown(lede, 'lede')}</p> : null}
    </header>
  );
}

/** ADR 1071 D1 — a feature head: the section head on the left with its headline
 *  number (the real digits, counted up where the stat count-up applies) and its
 *  words, then the lede; the section's picture on the right. Falls back to the
 *  plain head when the section has no stat. */
function FeatureHead({ d, eyebrow, heading }: { d: Record<string, unknown>; eyebrow?: string | undefined; heading?: string | undefined }): JSX.Element {
  const st = d.stat && typeof d.stat === 'object' ? (d.stat as { value?: unknown; label?: unknown }) : {};
  const lede = str(d.lede);
  return (
    <header className="fp-head fp-head--feature">
      <div className="fp-head__copy">
        {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
        {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-head__title"><HeadingText text={heading} /></h2> : null}
        <p className="fp-head__stat">
          <span className="fp-head__stat-n"><StatValue title={String(st.value)} /></span>
          <span className="fp-head__stat-label">{str(st.label)}</span>
        </p>
        {lede ? <p className="fp-head__lede">{inlineMarkdown(lede, 'lede')}</p> : null}
      </div>
      <ColumnShot token={str(d.imageToken)} alt={str(d.alt)} frameUrl={str(d.frameUrl)} className="fp-head__shot" />
    </header>
  );
}

/** The openwop node motif — square / circle / diamond, cycled per index.
 *  The fallback when a card has no (or an unknown) `icon` slug. */
function NodeGlyph({ i }: { i: number }): JSX.Element {
  const shape = i % 3;
  return (
    <span className="fp-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20">
        {shape === 0 ? <rect x="5" y="5" width="14" height="14" rx="2.5" />
          : shape === 1 ? <circle cx="12" cy="12" r="8" />
            : <path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" />}
      </svg>
    </span>
  );
}

/** ADR 1067 D3 — a checklist row's icon: the column icon set, or nothing for an unknown slug. */
function activityIcon(slug: string): JSX.Element | null {
  const Icon = ICON_BY_SLUG[slug];
  return Icon ? <Icon size={18} /> : null;
}

/** A card's glyph: the per-feature icon for a known `icon` slug, else the node
 *  motif. Same `.fp-glyph` chrome either way so the grid stays visually even. */
/** ADR 1068 D3 — a column's call to action (`ctaLabel`/`ctaUrl`, the same fields
 *  the pricing list draws as a button) as a visible action line in the panels and
 *  cards layouts ("For agencies →"). The arrow is decoration; an unsafe target
 *  renders nothing (the write path blanks it too). */
function ActionLink({ c }: { c: Record<string, unknown> }): JSX.Element | null {
  const label = str(c.ctaLabel); const href = str(c.ctaUrl).trim();
  if (!label || !href) return null;
  const body = <>{label}<span className="fp-col__link-arrow" aria-hidden="true"><ArrowRightIcon size={16} /></span></>;
  const a = isInternal(href) ? <Link className="fp-col__link" to={href}>{body}</Link>
    : isFragment(href) ? <a className="fp-col__link" href={href}>{body}</a>
      : isSafeHref(href) ? <a className="fp-col__link" href={href} rel="noopener noreferrer">{body}</a> : null;
  return a ? <p className="fp-col__link-row">{a}</p> : null;
}

function CardGlyph({ icon, i }: { icon?: string | undefined; i: number }): JSX.Element {
  const Icon = icon ? ICON_BY_SLUG[icon] : undefined;
  if (!Icon) return <NodeGlyph i={i} />;
  return (
    <span className="fp-glyph" aria-hidden="true">
      <Icon size={20} />
    </span>
  );
}

/**
 * The illustrative front-page copy (hero vignette, run ledger, film player, dive
 * art) lives in the LAZY `site` namespace (ADR 0490). It must be read through
 * `useTranslation` — the global `i18n.t` never requests a lazy namespace and
 * never re-renders, so a CMS page painted raw keys ("filmPlay"). Every key is
 * written fully qualified (`site:…`); `cms` leads the list so the file's
 * default namespace (and check-i18n's reading of it) stays `cms`.
 */
const SITE_NS = ['cms', 'site'] as const;

/**
 * A deliberately illustrative, not-live, product vignette for the public hero.
 * The old outline-only diagram told the visitor that this was "technical," but
 * gave no sense of what the product helps them do. This keeps the node motif
 * while showing the simple arc OpenWOP is built for: shape work, run it, retain
 * a reviewable record. It is aria-hidden because the authored hero copy carries
 * the actual product claim.
 */
function HeroSchematic(): JSX.Element {
  const { t } = useTranslation(SITE_NS);
  return (
    <div className="fp-hero__product" aria-hidden="true">
      <div className="fp-product">
        <div className="fp-product__bar">
          <span className="fp-product__brand"><span className="fp-product__brand-mark" /> {t('site:heroVignetteName')}</span>
          <span className="fp-product__state">{t('site:heroVignetteReady')}</span>
        </div>
        <div className="fp-product__canvas">
          <div className="fp-product__node fp-product__node--brief">
            <span className="fp-product__node-kicker">{t('site:heroVignetteContext')}</span>
            <strong>{t('site:heroVignetteBrief')}</strong>
            <span>{t('site:heroVignetteCapture')}</span>
          </div>
          <span className="fp-product__wire fp-product__wire--one" />
          <div className="fp-product__node fp-product__node--route">
            <span className="fp-product__node-kicker">{t('site:heroVignetteWorkflow')}</span>
            <strong>{t('site:heroVignetteRoute')}</strong>
            <span>{t('site:heroVignetteTogether')}</span>
          </div>
          <span className="fp-product__wire fp-product__wire--two" />
          <div className="fp-product__node fp-product__node--review">
            <span className="fp-product__node-kicker">{t('site:heroVignetteRecord')}</span>
            <strong>{t('site:heroVignetteReview')}</strong>
            <span>{t('site:heroVignetteReplay')}</span>
          </div>
        </div>
        <div className="fp-product__footer">
          <span>{t('site:heroVignetteOpen')}</span>
          <span className="fp-product__footer-dot" />
          <span>{t('site:heroVignetteInfrastructure')}</span>
        </div>
      </div>
    </div>
  );
}

/** The journey motif's geometry (viewBox 0 0 560 250): a week's trail with one
 *  missed day, the detour that recovers it, and the goal. */
const JOURNEY_TRAIL = 'M30 190 C 90 190, 100 120, 150 120 S 220 170, 250 160 C 290 150, 300 70, 350 80 S 420 150, 460 120 S 510 60, 530 60';
const JOURNEY_DETOUR = 'M250 160 C 262 205, 300 214, 318 196';
const JOURNEY_DAYS: readonly { x: number; y: number; done: boolean }[] = [
  { x: 30, y: 190, done: true },
  { x: 150, y: 120, done: true },
  { x: 250, y: 160, done: false },
  { x: 350, y: 80, done: true },
  { x: 460, y: 120, done: true },
];

/** A calm momentum path: done days, one missed day and its detour, then the goal.
 *  Decoration only (aria-hidden). The markup is the FINISHED picture; the draw-in,
 *  the node pops and the single goal pulse are CSS that runs only when neither
 *  the OS nor the user's override asks for reduced motion, so a reduced-motion
 *  visitor sees the final state, never a half-drawn one. */
function HeroJourney(): JSX.Element {
  return (
    <svg className="fp-hero__schematic fp-hero__journey" viewBox="0 0 560 250" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
      <path className="fp-journey__wash" d={JOURNEY_TRAIL} />
      <path className="fp-journey__path" d={JOURNEY_TRAIL} pathLength={1} />
      <path className="fp-journey__detour" d={JOURNEY_DETOUR} />
      {JOURNEY_DAYS.map((day, i) => (
        <g key={`${day.x}-${day.y}`} className={`fp-journey__node fp-journey__node--${day.done ? 'done' : 'missed'} fp-journey__node--n${i + 1}`}>
          <circle cx={day.x} cy={day.y} r={15} />
          {day.done ? <path className="fp-journey__check" d={`M${day.x - 6} ${day.y} l4 4 8 -9`} /> : null}
        </g>
      ))}
      <g className="fp-journey__node fp-journey__node--goal fp-journey__node--n6">
        <circle cx={530} cy={60} r={17} />
        <path className="fp-journey__flag" d="M524 70 V50 L537 55 L524 60 Z" />
      </g>
    </svg>
  );
}

/** One line of the run ledger: a wire event name (never translated — it is the
 *  protocol's vocabulary) + the `site:` key of its plain-language gloss. */
const RUN_LEDGER: readonly { at: string; event: string; gloss: string; waits?: boolean }[] = [
  { at: '00.00', event: 'run.started', gloss: 'site:heroRunStarted' },
  { at: '00.41', event: 'agent.decided', gloss: 'site:heroRunDecided' },
  { at: '01.12', event: 'node.completed', gloss: 'site:heroRunToolReturned' },
  { at: '01.13', event: 'budget.consumed', gloss: 'site:heroRunBudget' },
  { at: '01.20', event: 'approval.requested', gloss: 'site:heroRunApprovalRequested', waits: true },
  { at: '03.47', event: 'approval.granted', gloss: 'site:heroRunApprovalGranted' },
  { at: '03.52', event: 'run.completed', gloss: 'site:heroRunCompleted' },
];

/**
 * The run, typeset as its event log — the front page's one signature visual.
 * The story is that the RUN (the loop where AI decides, calls tools, and stops
 * to ask a person) is what OpenWOP opens up, so the hero shows a run rather than
 * a diagram of one. Event names are real run-event types from the protocol;
 * the row where the run waits on a person carries the §6 `openwop-attention`
 * cue — the one human-action state on the page. Illustrative, not live, so it
 * is aria-hidden: the authored hero copy carries the claim.
 */
function HeroRunLedger(): JSX.Element {
  const { t } = useTranslation(SITE_NS);
  return (
    <div className="fp-run" aria-hidden="true">
      <div className="fp-run__bar">
        <span className="fp-run__id"><span className="fp-run__mark" />{t('site:heroRunName')}</span>
        <span>{t('site:heroRunLog')}</span>
      </div>
      <ol className="fp-run__list">
        {RUN_LEDGER.map((row) => (
          <li key={row.event} className={row.waits ? 'fp-run__row fp-run__row--waits' : 'fp-run__row'}>
            <span className="fp-run__at">{row.at}</span>
            <span className="fp-run__event">{row.event}</span>
            <span className="fp-run__gloss">
              {t(row.gloss)}
              {row.waits ? <span className="fp-run__waits">{t('site:heroRunWaiting')}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div className="fp-run__foot">{t('site:heroRunFooter')}</div>
    </div>
  );
}

/**
 * ADR 0762 — the OpenWOP intro film (94 s, narrated), rendered and hosted by
 * openwop.dev (source: openwop-site `video/`). Showcase content, so it is
 * DEMO-GATED (ADR 0196 Gate A): a white-label install never loads media from
 * openwop.dev and falls back to the run ledger. The `?v=` must track
 * openwop.dev's, which serves `/assets/**` immutable — and the backend's
 * `HERO_FILM` (host/systemSiteProfile.ts, the home VideoObject) must match it
 * (ADR 0824 D3; pinned by test/public-site-aeo.test.ts).
 */
const FILM = {
  src: 'https://openwop.dev/assets/video/openwop-intro.mp4?v=2026-10-04.1',
  poster: 'https://openwop.dev/assets/video/openwop-intro-poster.jpg?v=2026-10-04.1',
  captions: 'https://openwop.dev/assets/video/openwop-intro.en.vtt?v=2026-10-04.1',
};

/** Click-to-play: nothing downloads until asked (`preload="none"`), and a play
 *  button over the poster replaces the native control bar until the film starts
 *  (the bar hides the poster's lower third). The film is narrated, so it carries
 *  an English captions track. A cross-origin <track> needs a CORS read, hence
 *  `crossOrigin="anonymous"`: openwop.dev sends Access-Control-Allow-Origin on
 *  /assets/video/** (openwop-site #140).
 *
 *  ADR 0843 — the ONE film player: the home hero's intro film and every CMS
 *  `video` section render through it, so they cannot drift in behaviour. The
 *  caller supplies the visible caption (`caption`) and/or a visually hidden
 *  description (`description`); whichever exists describes the video. */
function FilmPlayer({ src, poster, captions, length, caption, description, captionExtra, corner }: {
  src: string;
  /** ADR 1063 P2b — the play control as a bottom-left chip carrying the film's
   *  title and length (the design's film card); the title then leaves the
   *  caption so it is not read twice. */
  /** ADR 1068 D1 — `label` is the chip's visible words; the accessible name keeps `title`. */
  corner?: { title: string; label?: string | undefined } | undefined;
  poster: string;
  captions?: string | undefined;
  length?: string | undefined;
  /** Visible caption under the frame (the hero's description is visible). */
  caption?: ReactNode;
  /** Screen-reader-only description, wired as aria-describedby. */
  description?: string | undefined;
  /** Extra visible caption content (a CMS video's YouTube link). */
  captionExtra?: ReactNode;
}): JSX.Element {
  // `started` hands the video its native controls (and keeps them); `playing`
  // fades the button out while the video plays and back in when it ends
  // (pressing it again replays from the start).
  const { t } = useTranslation(SITE_NS);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const descId = useId();
  // The faded button is aria-hidden, so focus must leave it BEFORE it fades: an
  // aria-hidden ancestor of the focused element is an a11y error (Chrome blocks
  // it and logs). A <video> without `controls` is not focusable, so until the
  // film has started it carries tabIndex -1 — programmatically focusable, still
  // out of the tab order — and the hand-off below actually lands.
  const moveFocusToVideo = (): void => {
    if (playRef.current && playRef.current.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  };
  const start = (): void => {
    setStarted(true);
    const v = ref.current;
    if (!v) return;
    if (v.ended) v.currentTime = 0;
    v.focus({ preventScroll: true });
    void v.play().catch(() => {});
  };
  const describedBy = [description ? descId : '', caption ? captionId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <figure className={corner ? 'fp-film fp-film--corner' : 'fp-film'}>
      <div className="fp-film__frame">
        <video
          ref={ref}
          className="fp-film__video"
          src={src}
          poster={poster}
          preload="none"
          playsInline
          controls={started}
          tabIndex={started ? undefined : -1}
          width={1920}
          height={1080}
          crossOrigin="anonymous"
          aria-describedby={describedBy}
          onPlay={() => { moveFocusToVideo(); setStarted(true); setPlaying(true); }}
          onEnded={() => setPlaying(false)}
        >
          {captions ? <track kind="captions" srcLang="en" label={t('site:filmCaptionsLabel')} src={captions} /> : null}
        </video>
        {/* Faded out, the button also leaves the tab order and the a11y tree,
            so it is never an invisible, focusable control — and focus has
            already moved to the video (`moveFocusToVideo`), so the aria-hidden
            never lands on the focused element. */}
        <button
          ref={playRef}
          type="button"
          className={playing ? 'fp-film__play fp-film__play--faded' : 'fp-film__play'}
          onClick={start}
          aria-hidden={playing}
          tabIndex={playing ? -1 : 0}
        >
          {corner ? (
            <>
              <span className="fp-film__disc" aria-hidden="true"><PlayIcon size={18} /></span>
              <span className="fp-film__chip-text">
                <span className="sr-only">{t('site:filmPlay')}: </span>
                {/* ADR 1068 D1 — a chip label different from the title is what the chip
                    SHOWS; screen readers still hear the film's name. */}
                {corner.label && corner.label !== corner.title ? (
                  <>
                    {corner.title ? <span className="sr-only">{corner.title}</span> : null}
                    <span className="fp-film__chip-title" aria-hidden="true">{corner.label}</span>
                  </>
                ) : corner.title ? <span className="fp-film__chip-title">{corner.title}</span> : null}
                {length ? <span className="fp-film__len">{length}</span> : null}
              </span>
            </>
          ) : (
            <>
              <PlayIcon size={18} />
              <span>{t('site:filmPlay')}</span>
              {length ? <span className="fp-film__len">{length}</span> : null}
            </>
          )}
        </button>
      </div>
      {description ? <span id={descId} className="sr-only">{description}</span> : null}
      {caption || captionExtra ? (
        <figcaption id={captionId} className="fp-film__cap">{caption}{captionExtra}</figcaption>
      ) : null}
    </figure>
  );
}

function HeroFilm(): JSX.Element {
  const { t } = useTranslation(SITE_NS);
  return (
    <FilmPlayer
      src={FILM.src}
      poster={FILM.poster}
      captions={FILM.captions}
      length={t('site:filmLength')}
      caption={t('site:filmCaption')}
    />
  );
}

/** ADR 0843 — a CMS `video` section: an optional section head, then the film.
 *  URLs were https-checked on save; re-checked here so a row that reached
 *  storage another way never loads a non-https source. The visible caption is
 *  the title (+ a YouTube link); the long description is screen-reader only. */
const httpsOnly = (v: unknown): string => (/^https:\/\//i.test(str(v).trim()) ? str(v).trim() : '');
/** ADR 1064 P3b — a tile's status, from the same flags as a status list. */
const tileStatus = (c: { future?: boolean; partial?: boolean }): 'works' | 'partial' | 'future' => (c.future ? 'future' : c.partial ? 'partial' : 'works');

/**
 * ADR 1064 P3b — tiles a visitor can filter by status. The chips are "All"
 * plus each distinct badge, in order (aria-pressed toggle buttons in a named
 * group). Filtered-out tiles stay in the DOM with `hidden`, so the prerender
 * and crawlers see every one; a polite status line says how many show. Each
 * badge is coloured by the tile's status flags, so a pill never claims "works"
 * for a column flagged future.
 */
function FilteredTiles({ cols, head, note, cls, stg }: {
  cols: Array<{ title?: string; text?: string; badge?: string; future?: boolean; partial?: boolean; eyebrow?: string }>;
  head: ReactNode; note: ReactNode; cls: string; stg: string;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const [pick, setPick] = useState<string | null>(null);
  const badges = [...new Set(cols.map((c) => str(c.badge)).filter(Boolean))];
  const shown = cols.filter((c) => pick === null || str(c.badge) === pick).length;
  const chip = (label: string, value: string | null): JSX.Element => (
    <Button key={value ?? '*'} variant="quiet" size="sm" className="fp-filter__chip" aria-pressed={pick === value} onClick={() => setPick(value)}>{label}</Button>
  );
  return (
    <section className={cls}>
      <div className="fp-shell">
        {head}
        {badges.length > 1 ? (
          <div className="fp-filter" role="group" aria-label={t('tileFilterLabel')}>
            {chip(t('tileFilterAll', { count: cols.length }), null)}
            {badges.map((b) => chip(b, b))}
          </div>
        ) : null}
        <p className="sr-only" role="status">{t('tileFilterShowing', { shown, total: cols.length })}</p>
        <ul className={`fp-cols__grid${stg}`}>
          {cols.map((c, i) => (
            <li key={i} className={`fp-col fp-col--${tileStatus(c)}${c.future ? ' fp-col--future' : ''}`} hidden={pick !== null && str(c.badge) !== pick}>
              {str(c.eyebrow) ? <p className="fp-col__eyebrow">{str(c.eyebrow)}</p> : null}
              {str(c.title) ? <h3 className="fp-col__title">{str(c.title)}</h3> : null}
              {str(c.badge) ? <span className={`fp-col__badge fp-col__badge--${tileStatus(c)}`}>{str(c.badge)}</span> : null}
              {str(c.text) ? <p className="fp-col__text">{inlineMarkdown(str(c.text), `tile-${i}`)}</p> : null}
            </li>
          ))}
        </ul>
        {note}
      </div>
    </section>
  );
}

/** ADR 1064 P3d — a card's ring gauge: the words are real text ("415/415");
 *  the ring is decoration, filled to `value` (0–1). It draws once on load on
 *  the motion path; at rest and with reduced motion it is simply full to
 *  `value`. */
function GaugeRing({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <p className="fp-gauge">
      <svg className="fp-gauge__ring" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
        <circle className="fp-gauge__track" cx="18" cy="18" r="15.9155" pathLength={100} />
        <circle className="fp-gauge__fill" cx="18" cy="18" r="15.9155" pathLength={100} style={{ strokeDasharray: `${Math.round(value * 100)} 100` }} />
      </svg>
      <span className="fp-gauge__label">{label}</span>
    </p>
  );
}

function VideoSection({ d, eyebrow, heading, sx = '' }: { d: Record<string, unknown>; eyebrow?: string | undefined; heading?: string | undefined; sx?: string }): JSX.Element {
  // ADR 1032 — a second film sits beside the first (stacked on a phone), with
  // an optional footnote under the pair.
  const film2 = typeof d.film2 === 'object' && d.film2 !== null ? d.film2 as Record<string, unknown> : null;
  // ADR 1063 P2b — the section's `chip` applies to both films.
  const corner = d.chip === 'corner';
  const second = film2 ? <SectionFilm d={film2} corner={corner} /> : null;
  return (
    <section className={`cms-public-section fp-section${second ? ' fp-films' : ''}${sx}`}>
      <div className="fp-shell">
        <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
        {second ? (
          <div className="fp-films__grid">
            <SectionFilm d={d} corner={corner} />
            {second}
          </div>
        ) : <SectionFilm d={d} corner={corner} />}
        {str(d.note) ? <p className="fp-films__note">{inlineMarkdown(str(d.note), 'films-note')}</p> : null}
      </div>
    </section>
  );
}

/** One film of a `video` section (its first, or its ADR 1032 `film2`). */
function SectionFilm({ d, corner = false }: { d: Record<string, unknown>; corner?: boolean }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const src = httpsOnly(d.src);
  const poster = httpsOnly(d.poster);
  const youtube = httpsOnly(d.youtubeUrl);
  const title = str(d.title);
  // ADR 1068 D1 — the chip's own words (falls back to the title) and a visible
  // caption line, shown with the corner chip too.
  const chipLabel = str(d.chipLabel) || title;
  const filmCaption = str(d.caption);
  if (!src || !poster) return null;
  const titleShown = Boolean(title && !corner);
  return (
          <FilmPlayer
            src={src}
            poster={poster}
            captions={httpsOnly(d.captions) || undefined}
            length={str(d.length) || undefined}
            description={str(d.description) || undefined}
            corner={corner ? { title, label: chipLabel } : undefined}
            caption={titleShown || filmCaption ? (
              <>
                {titleShown ? <span className="fp-film__title">{title}</span> : null}
                {filmCaption ? <span className="fp-film__caption">{filmCaption}</span> : null}
              </>
            ) : null}
            captionExtra={youtube ? (
              <>
                {titleShown || filmCaption ? <span aria-hidden="true"> · </span> : null}
                <a href={youtube} target="_blank" rel="noopener noreferrer">{t('videoWatchOnYouTube')} <ArrowUpRightIcon size={14} /></a>
              </>
            ) : null}
          />
  );
}

function RunHero({ copy, mx = '' }: { copy: ReactNode; mx?: string }): JSX.Element {
  return (
    <section className={`cms-public-section fp-hero fp-hero--run${mx}`}>
      <div className="fp-shell fp-hero__inner fp-hero__split">
        <div className="fp-hero__copy">{copy}</div>
        <HeroRunLedger />
      </div>
    </section>
  );
}

/** ADR 0762 — the film sits UNDER the copy, full width: it is the page's
 *  demonstration, so it gets the room a side column cannot give 16:9. The film
 *  is showcase media from openwop.dev, so it is DEMO-GATED (ADR 0196 Gate A):
 *  anywhere else this is the run hero. The demo read lives here, not in
 *  PublicSection, so only a film hero ever asks the host. */
function FilmOrRunHero({ copy, mx = '' }: { copy: ReactNode; mx?: string }): JSX.Element {
  const demo = useDemoMode();
  if (!demo) return <RunHero copy={copy} mx={mx} />;
  return (
    <section className={`cms-public-section fp-hero fp-hero--film${mx}`}>
      <div className="fp-shell fp-hero__inner fp-hero__stack">
        <div className="fp-hero__copy">{copy}</div>
        <HeroFilm />
      </div>
    </section>
  );
}

/**
 * ADR 0762 — the `dives` layout's built-in illustrations, chosen by the
 * column's `icon` slug (the same opaque, bounded token cards use for a glyph).
 * Illustrative, not live: aria-hidden, like the hero's run ledger; the column's
 * own title and text carry the claim. An unknown slug draws nothing.
 */
function DiveArt({ kind }: { kind: string }): JSX.Element | null {
  const { t } = useTranslation(SITE_NS);
  if (kind === 'canvas') {
    const steps = ['site:diveCanvasTrigger', 'site:diveCanvasAgent', 'site:diveCanvasApproval', 'site:diveCanvasAction'];
    return (
      <div className="fp-dive__art fp-dive__art--canvas" aria-hidden="true">
        <p className="fp-dive__meta"><span>{t('site:diveCanvasName')}</span><span>{t('site:diveCanvasDraft')}</span></p>
        <ol className="fp-dive__nodes">
          {steps.map((k, i) => (
            <li key={k} className={i === 2 ? 'fp-dive__node fp-dive__node--waits' : 'fp-dive__node'}>
              <span className="fp-dive__node-num">{pad2(i + 1)}</span>{t(k)}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (kind === 'ledger') {
    return (
      <div className="fp-dive__art fp-dive__art--ledger" aria-hidden="true">
        <p className="fp-dive__meta"><span>{t('site:heroRunName')}</span><span>{t('site:diveLedgerLive')}</span></p>
        <ol className="fp-run__list">
          {RUN_LEDGER.slice(0, 4).map((row) => (
            <li key={row.event} className="fp-run__row">
              <span className="fp-run__at">{row.at}</span>
              <span className="fp-run__event">{row.event}</span>
              <span className="fp-run__gloss">{t(row.gloss)}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (kind === 'approval') {
    return (
      <div className="fp-dive__art fp-dive__art--approval" aria-hidden="true">
        <p className="fp-dive__meta"><span>approval.requested</span><span>{t('site:heroRunWaiting')}</span></p>
        <p className="fp-dive__ask">{t('site:diveApprovalTitle')}</p>
        <p className="fp-dive__body">{t('site:diveApprovalBody')}</p>
        <p className="fp-dive__actions">
          <span className="fp-btn fp-btn--primary">{t('site:diveApprove')}</span>
          <span className="fp-btn fp-btn--ghost">{t('site:diveDecline')}</span>
        </p>
      </div>
    );
  }
  if (kind === 'fork') {
    return (
      <div className="fp-dive__art fp-dive__art--fork" aria-hidden="true">
        <p className="fp-dive__meta"><span>{t('site:diveForkName')}</span><span>{t('site:diveForkFrom')}</span></p>
        <ol className="fp-dive__fork">
          <li className="fp-dive__fork-row fp-dive__fork-row--reused"><span>1–3</span><span>{t('site:diveForkReused')}</span></li>
          <li className="fp-dive__fork-row"><span>4</span><span>agent.decided · {t('site:diveForkNew')}</span></li>
          <li className="fp-dive__fork-row fp-dive__fork-row--held"><span>5</span><span>send-email · {t('site:diveForkHeld')}</span></li>
        </ol>
        <p className="fp-dive__note">{t('site:diveIllustrative')}</p>
      </div>
    );
  }
  return null;
}

function resolveHeroVisual(d: Record<string, unknown>): HeroVisual {
  const authored = HERO_VISUALS.find((v) => v === d.visual);
  if (authored) return authored;
  if (str(d.imageToken)) return 'image';
  // The schematic is OpenWOP's protocol illustration ("Open protocol · Your
  // infrastructure"). An un-authored hero on a white-label build gets no art
  // rather than another product's diagram (#5226, seen on legal page heroes).
  return isStockOpenwopBrand(brand) ? 'workflow' : 'none';
}

function HeroArtwork({ d, visual }: { d: Record<string, unknown>; visual: HeroVisual }): JSX.Element | null {
  if (visual === 'none') return null;
  if (visual === 'journey') return <HeroJourney />;
  if (visual === 'image') {
    const token = str(d.imageToken);
    if (!token) return null;
    // ADR 1064 P3f(d) — up to four static notes pinned to the picture's corners.
    // Decoration only (aria-hidden, hidden on narrow screens): the hero copy
    // carries the same words, so no reader loses them.
    const chips = (Array.isArray(d.chips) ? d.chips : [])
      .map((c) => ({ text: str((c as { text?: unknown }).text), at: str((c as { at?: unknown }).at) }))
      .filter((c) => c.text && ['tl', 'tr', 'bl', 'br'].includes(c.at))
      .slice(0, 4);
    const img = <img className="fp-hero__image" src={assetUrl(token)} alt={str(d.alt)} />;
    if (chips.length === 0) return img;
    return (
      <div className="fp-hero__annotated">
        {img}
        {chips.map((c, i) => <span key={i} className={`fp-hero__chip fp-hero__chip--${c.at}`} aria-hidden="true">{c.text}</span>)}
      </div>
    );
  }
  return <HeroSchematic />;
}

/** A comparison cell's status class (ADR 0485). The authored glyph itself carries
 *  the meaning, so color is redundant reinforcement — never the sole signal
 *  (DESIGN.md §5.3). Unknown/short-text marks get the neutral cell. */
function compareCellClass(mark: string, highlighted: boolean): string {
  const status = mark === '✓' ? ' fp-matrix__cell--yes'
    : mark === '✗' ? ' fp-matrix__cell--no'
      : mark === '~' ? ' fp-matrix__cell--partial' : '';
  return `fp-matrix__cell${status}${highlighted ? ' fp-matrix__cell--hl' : ''}`;
}

/** The screen-reader word for a status glyph (the glyph alone reads poorly),
 *  localized like the rest of the section. A non-glyph cell (short qualifier
 *  text) is already its own label ⇒ no extra. */
function compareCellAria(mark: string, t: TFunction): string | null {
  if (mark === '✓') return t('comparisonYes', { defaultValue: 'Yes' });
  if (mark === '✗') return t('comparisonNo', { defaultValue: 'No' });
  if (mark === '~') return t('comparisonPartial', { defaultValue: 'Partial' });
  return null;
}

/** ADR 1032 — a `rows` section's try-it panel, or null when it has no switch. */
function toggleSpec(v: unknown): { title: string; items: { label: string; on: boolean }[] } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { title?: unknown; items?: unknown };
  const items = (Array.isArray(o.items) ? o.items : [])
    .map((it) => ({ label: str((it as { label?: unknown })?.label), on: (it as { on?: unknown })?.on === true }))
    .filter((it) => it.label);
  return items.length > 0 ? { title: str(o.title), items } : null;
}

/** ADR 1068 D2 — a rows section's workflow diagram (the design's dark flow
 *  card): the steps in order, one of which may wait for a person. Its words are
 *  real text in an ordered list inside a <figure>; the waiting step says so in
 *  its own label ("Waits for you"), so colour is reinforcement, never the signal. */
type DiagramSpec = { nodes: { label: string; text: string; waiting: boolean }[]; caption: string };
function diagramSpec(v: unknown): DiagramSpec | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { nodes?: unknown; caption?: unknown };
  const nodes = (Array.isArray(o.nodes) ? o.nodes : [])
    .map((n) => ({ label: str((n as { label?: unknown })?.label), text: str((n as { text?: unknown })?.text), waiting: (n as { waiting?: unknown })?.waiting === true }))
    .filter((n) => n.label);
  return nodes.length >= 2 ? { nodes, caption: str(o.caption) } : null;
}
function WorkflowDiagram({ spec }: { spec: DiagramSpec }): JSX.Element {
  return (
    <figure className="fp-diagram">
      <ol className="fp-diagram__nodes">
        {spec.nodes.map((n, i) => (
          <li key={i} className={n.waiting ? 'fp-diagram__node fp-diagram__node--waiting' : 'fp-diagram__node'}>
            <span className="fp-diagram__label">{n.label}</span>
            {n.text ? <span className="fp-diagram__text">{n.text}</span> : null}
          </li>
        ))}
      </ol>
      {spec.caption ? <figcaption className="fp-diagram__cap">{spec.caption}</figcaption> : null}
    </figure>
  );
}

/** ADR 1032 — the try-it switches: real checkboxes (role="switch") the visitor
 *  can flip, each with its state in words, never colour alone. Nothing is saved
 *  and nothing is sent: this is a demonstration of a setting, on the page. */
function TryToggles({ spec }: { spec: { title: string; items: { label: string; on: boolean }[] } }): JSX.Element {
  const { t } = useTranslation('cms');
  const [on, setOn] = useState<boolean[]>(() => spec.items.map((i) => i.on));
  const titleId = useId();
  return (
    <div className="fp-try" role="group" aria-labelledby={spec.title ? titleId : undefined}>
      {spec.title ? <p id={titleId} className="fp-try__title">{spec.title}</p> : null}
      <ul className="fp-try__list">
        {spec.items.map((it, i) => (
          <li key={i}>
            <label className="fp-try__row">
              <span className="fp-try__label">{it.label}</span>
              <span className="fp-try__state" aria-hidden="true">{on[i] ? t('tryWaits') : t('tryRuns')}</span>
              <input
                type="checkbox"
                role="switch"
                className="fp-try__switch"
                checked={on[i] ?? false}
                aria-label={t('trySwitchAria', { step: it.label })}
                onChange={(e) => setOn((prev) => prev.map((x, j) => (j === i ? e.target.checked : x)))}
              />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** ADR 1037 — an item's picture: lazy, with its alt text, and inside the ADR
 *  1032 browser frame when the item names an address. Nothing without a token. */
function ColumnShot({ token, alt, frameUrl, className }: { token: string; alt: string; frameUrl: string; className: string }): JSX.Element | null {
  if (!token) return null;
  const img = <img className="fp-shot__img" src={assetUrl(token)} alt={alt} loading="lazy" decoding="async" width={1600} height={1000} />;
  if (!frameUrl) return <div className={className}>{img}</div>;
  return (
    <div className={`${className} fp-browser`}>
      <div className="fp-browser__bar" aria-hidden="true">
        <span className="fp-browser__dot" /><span className="fp-browser__dot" /><span className="fp-browser__dot" />
        <span className="fp-browser__url">{frameUrl}</span>
      </div>
      {img}
    </div>
  );
}

/**
 * ADR 1047 — the hero's hub picture: one centre (an optional picture and its
 * label) with its places arranged around it. Real text in a <figure> (crawler =
 * human, ADR 0593 §C9); the glyphs and the spokes are decoration. The spokes
 * draw once on load (CSS); reduced motion and print show the finished drawing.
 * Distinct from ADR-1038 D8 `flow`: strictly radial, no edges between places.
 * ADR 1050 D2 — the geometry is physical: each place's `--hub-x`/`--hub-y` is the
 * same point as its spoke's `x2`/`y2`, and the CSS mirrors both together in RTL.
 */
function HubFigure({ hub }: { hub: unknown }): JSX.Element | null {
  const h = hub && typeof hub === 'object' ? (hub as Record<string, unknown>) : {};
  const c = h.center && typeof h.center === 'object' ? (h.center as Record<string, unknown>) : {};
  const spokes = (Array.isArray(h.spokes) ? (h.spokes as unknown[]) : [])
    .map((sp) => (sp && typeof sp === 'object' ? (sp as Record<string, unknown>) : {}))
    .filter((sp) => str(sp.label));
  if (!str(c.label) || spokes.length < 2) return null;
  const n = spokes.length;
  const at = (i: number): { x: number; y: number } => {
    const a = (-90 + (360 * i) / n) * (Math.PI / 180);
    // Rounded to hundredths: geometry, not a displayed number.
    return { x: Math.round((50 + 41 * Math.cos(a)) * 100) / 100, y: Math.round((50 + 41 * Math.sin(a)) * 100) / 100 };
  };
  const summary = `${str(c.label)}: ${spokes.map((sp) => str(sp.label)).join(', ')}`;
  return (
    <figure className="fp-hub" aria-label={summary}>
      <svg className="fp-hub__lines" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="fp-hub__orbit" cx="50" cy="50" r="40" />
        <circle className="fp-hub__ring" cx="50" cy="50" r="22" />
        {spokes.map((_, i) => {
          const p = at(i);
          return (
            <g key={i} style={{ '--hub-i': i } as CSSProperties}>
              <line className="fp-hub__spoke" x1="50" y1="50" x2={p.x} y2={p.y} pathLength={1} />
              <line className="fp-hub__pulse" x1="50" y1="50" x2={p.x} y2={p.y} />
            </g>
          );
        })}
      </svg>
      <figcaption className="fp-hub__center">
        {str(c.imageToken) ? <img className="fp-hub__mark" src={assetUrl(str(c.imageToken))} alt={str(c.alt)} width={78} height={78} /> : null}
        {str(c.eyebrow) ? <span className="fp-hub__eyebrow">{str(c.eyebrow)}</span> : null}
        <strong className="fp-hub__label">{str(c.label)}</strong>
      </figcaption>
      <ul className="fp-hub__places">
        {spokes.map((sp, i) => {
          const p = at(i);
          const Icon = str(sp.icon) ? ICON_BY_SLUG[str(sp.icon)] : undefined;
          return (
            <li key={i} className="fp-hub__place" style={{ '--hub-x': `${p.x}%`, '--hub-y': `${p.y}%`, '--hub-i': i } as CSSProperties}>
              {Icon ? <span className="fp-hub__icon" aria-hidden="true"><Icon size={22} strokeWidth={1.8} /></span> : null}
              <span className="fp-hub__text">
                {str(sp.index) ? <span className="fp-hub__index">{str(sp.index)}</span> : null}
                <span className="fp-hub__name">{str(sp.label)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

interface FeatureItem {
  eyebrow?: string; title?: string; text?: string; imageToken?: string; alt?: string; frameUrl?: string;
  callout?: { label?: string; text?: string }; tags?: { label?: string; state?: string }[]; more?: { label?: string; text?: string };
}

/**
 * ADR 1047 — the `features` layout: a two-column grid of feature cards (one
 * column on a phone). Each card: eyebrow, title (heading emphasis), an optional
 * picture in a dark media box, the lead text, a callout, labelled status pills
 * and a native <details> disclosure. A pill's words are its authored `label`;
 * its `state` only styles it, and the section's `tagLegend` supplies the words
 * a state means (shown as a legend and read with each pill), never a fixed word.
 */
function FeatureCards({ cols, legend, stg }: { cols: FeatureItem[]; legend: Record<string, unknown>; stg: string }): JSX.Element {
  const word = (state: string): string => (state === 'now' ? str(legend.now) : state === 'soon' ? str(legend.soon) : '');
  return (
    <>
      {str(legend.now) || str(legend.soon) ? (
        <ul className="fp-features__legend">
          {str(legend.now) ? <li className="fp-tag fp-tag--now">{str(legend.now)}</li> : null}
          {str(legend.soon) ? <li className="fp-tag fp-tag--soon">{str(legend.soon)}</li> : null}
        </ul>
      ) : null}
      <ul className={`fp-features__grid${stg}`}>
        {cols.map((c, i) => {
          const tags = (Array.isArray(c.tags) ? c.tags : []).filter((tg) => str(tg?.label));
          return (
            <li key={i} className="fp-feature">
              {str(c.eyebrow) ? <p className="fp-feature__eyebrow">{str(c.eyebrow)}</p> : null}
              {str(c.title) ? <h3 className="fp-feature__title"><HeadingText text={str(c.title)} /></h3> : null}
              <ColumnShot token={str(c.imageToken)} alt={str(c.alt)} frameUrl={str(c.frameUrl)} className="fp-feature__media" />
              {str(c.text) ? <p className="fp-feature__text">{inlineMarkdown(str(c.text), `feat-${i}`)}</p> : null}
              {str(c.callout?.text) ? (
                <p className="fp-feature__callout">
                  {str(c.callout?.label) ? <span className="fp-feature__callout-label">{str(c.callout?.label)}</span> : null}
                  {inlineMarkdown(str(c.callout?.text), `feat-co-${i}`)}
                </p>
              ) : null}
              {tags.length > 0 ? (
                <ul className="fp-feature__tags">
                  {tags.map((tg, j) => {
                    const st = str(tg.state);
                    const w = word(st);
                    return (
                      <li key={j} className={`fp-tag${st === 'now' || st === 'soon' ? ` fp-tag--${st}` : ''}`}>
                        {str(tg.label)}{w ? <span className="sr-only">{` (${w})`}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {str(c.more?.text) ? (
                <details className="fp-feature__more">
                  <summary className="fp-feature__more-summary">{str(c.more?.label) || str(c.title)}</summary>
                  <div className="fp-feature__more-body"><RichText text={str(c.more?.text)} className="fp-feature__more-p" /></div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Render one section's PUBLIC (front-page) markup. */
function PublicSection({ section }: { section: Section }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  const eyebrow = str(d.eyebrow) || undefined;
  const heading = str(d.heading) || undefined;
  // ADR 0920 D1/D2 — tone + split head modifiers ('' when the section sets neither).
  const sx = sectionStyleClass(d);
  // ADR 1029 D2 — the scroll motion classes, kept apart from `sx` because faq and
  // quotes add `fp-section` only when a tone is set ('' when there is no motion).
  // A `fields` section's keys are the author's own names, so a field called
  // "motion" there is content, never this enum.
  const mx = section.type === 'fields' ? '' : `${sectionMotionClass(d)}${section.type === 'hero' ? heroEmphasisClass(d) : ''}`;
  // The item lists a `stagger` section moves one by one (no class otherwise, so a
  // section that never chose motion keeps its exact markup).
  const stg = section.type !== 'fields' && d.motion === 'stagger' ? ' fp-stagger' : '';

  switch (section.type) {
    case 'hero': {
      const visual = resolveHeroVisual(d);
      const copy = (
        <>
          {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
          <h1 className="fp-hero__title"><HeadingText text={str(d.heading)} struck={d.emphasis === 'strike'} /></h1>
          {str(d.subheading) ? <p className="fp-hero__lede">{inlineMarkdown(str(d.subheading), 'hl')}</p> : null}
          {/* ADR 1066 D2 — a second, quieter paragraph under the lede. */}
          {str(d.body) ? <p className="fp-hero__body">{inlineMarkdown(str(d.body), 'hb')}</p> : null}
          {str(d.ctaLabel) || str(d.ctaLabel2) ? (
            <div className="fp-hero__cta">
              <CtaLink label={str(d.ctaLabel)} url={str(d.ctaUrl)} primary />
              <CtaLink label={str(d.ctaLabel2)} url={str(d.ctaUrl2)} icon={d.ctaIcon2 === 'play' ? <PlayIcon size={18} /> : undefined} />
            </div>
          ) : null}
          {str(d.note) ? <p className="fp-hero__note">{str(d.note)}</p> : null}
        </>
      );
      // The run ledger is the hero's subject, not its backdrop: it sits IN the
      // grid beside the copy (and under it on a phone) instead of floating
      // behind it and disappearing below 900px like the other visuals.
      if (visual === 'film') return <FilmOrRunHero copy={copy} mx={mx} />;
      if (visual === 'run') return <RunHero copy={copy} mx={mx} />;
      // ADR 0920 D3 — the example plan sits IN the grid beside the copy (the
      // run-ledger model), and under it on a phone.
      // ADR 1080 D7 — the queue sits in the same grid as the plan card.
      if (visual === 'queue') {
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan fp-hero--queue${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <HeroQueue queue={d.queue} />
            </div>
          </section>
        );
      }
      // ADR 1080 D6 — a photo hero's placement: `band` runs the photo the full
      // width above the copy, `card` sets it as a rounded card beside the copy,
      // and `panel` makes an inverse band with the photo filling one half.
      if (visual === 'image' && str(d.imageToken) && (d.placement === 'band' || d.placement === 'card' || d.placement === 'panel')) {
        const photo = <img className="fp-hero__photo" src={assetUrl(str(d.imageToken))} alt={str(d.alt)} />;
        if (d.placement === 'band') {
          return (
            <section className={`cms-public-section fp-hero fp-hero--band${mx}`}>
              {photo}
              <div className="fp-shell fp-hero__inner">{copy}</div>
            </section>
          );
        }
        if (d.placement === 'panel') {
          return (
            <section className={`cms-public-section fp-hero fp-hero--panel fp-tone fp-tone--inverse${mx}`}>
              <div className="fp-hero__panel-copy">{copy}</div>
              {photo}
            </section>
          );
        }
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan fp-hero--card${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              {photo}
            </div>
          </section>
        );
      }
      if (visual === 'plan') {
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <PlanCard plan={d.plan} />
            </div>
          </section>
        );
      }
      // ADR 1029 D5 — the activity card sits in the same grid as the plan card.
      if (visual === 'activity') {
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan fp-hero--activity${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <ActivityCard activity={d.activity} play={d.play} iconFor={activityIcon} />
            </div>
          </section>
        );
      }
      // ADR 1047 — the hub picture sits in the same grid as the activity card.
      if (visual === 'hub') {
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan fp-hero--hub${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <HubFigure hub={d.hub} />
            </div>
          </section>
        );
      }
      // ADR 1066 D1 — `placement: 'below'` puts the flow or illustrated picture
      // after the copy, the full width of the shell, instead of beside it.
      const below = d.placement === 'below' ? ' fp-hero--below' : '';
      // ADR 1038 D8 — the flow picture sits in the same grid as the activity card.
      if (visual === 'flow') {
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan fp-hero--flow${below}${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <FlowFigure flow={d.flow} row={below !== ''} />
            </div>
          </section>
        );
      }
      // ADR 1060 — the illustrated visuals sit in the same grid as the activity card.
      if (isHeroArtVisual(visual)) {
        return (
          <section className={`cms-public-section fp-hero fp-hero--plan fp-hero--art fp-hero--${visual}${below}${mx}`}>
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <HeroArtFigure visual={visual} data={d[visual]} />
            </div>
          </section>
        );
      }
      // The journey follows the copy in the DOM so a phone can show it UNDER the
      // copy; on a wide screen it is absolutely placed either way.
      return (
        <section className={`cms-public-section fp-hero fp-hero--${visual}${mx}`}>
          {visual === 'journey' ? null : <HeroArtwork d={d} visual={visual} />}
          <div className="fp-shell fp-hero__inner">{copy}</div>
          {visual === 'journey' ? <HeroArtwork d={d} visual={visual} /> : null}
        </section>
      );
      }

    case 'richText':
      // ADR 0920 D5 — with a `chat` picture the copy and the picture sit side by side.
      if (d.visual === 'chat' && d.chat) {
        return (
          <section className={`cms-public-section fp-section fp-prose fp-prose--visual${sx}${mx}`}>
            <div className="fp-shell fp-prose__split">
              <div className="fp-prose__copy">
                <SectionHead eyebrow={eyebrow} heading={heading} />
                <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" sources={d.sources === true} /></div>
              </div>
              <ChatCard chat={d.chat} />
            </div>
          </section>
        );
      }
      // ADR 1074 D1 — the screenshot beside the copy: a browser frame when it
      // has a window-bar label, and a mono caption under it.
      // ADR 1080 D8 — a card beside the copy (an approval, an offer).
      if (d.visual === 'card' && d.card) {
        return (
          <section className={`cms-public-section fp-section fp-prose fp-prose--visual${sx}${mx}`}>
            <div className={`fp-shell fp-prose__split${d.side === 'start' ? ' fp-prose__split--start' : ''}`}>
              <div className="fp-prose__copy">
                <SectionHead eyebrow={eyebrow} heading={heading} />
                <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" sources={d.sources === true} /></div>
              </div>
              <RichTextCard card={d.card} />
            </div>
          </section>
        );
      }
      if (d.visual === 'image' && str(d.imageToken)) {
        return (
          <section className={`cms-public-section fp-section fp-prose fp-prose--visual${sx}${mx}`}>
            {/* ADR 1080 D5 — `side: 'start'` puts the picture before the copy on wide screens. */}
            <div className={`fp-shell fp-prose__split${d.side === 'start' ? ' fp-prose__split--start' : ''}`}>
              <div className="fp-prose__copy">
                <SectionHead eyebrow={eyebrow} heading={heading} />
                <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" sources={d.sources === true} /></div>
              </div>
              <figure className="fp-prose__figure">
                <ColumnShot token={str(d.imageToken)} alt={str(d.alt)} frameUrl={str(d.frameUrl)} className="fp-prose__shot" />
                {str(d.caption) ? <figcaption className="fp-figure__cap fp-prose__cap">{str(d.caption)}</figcaption> : null}
              </figure>
            </div>
          </section>
        );
      }
      return (
        <section className={`cms-public-section fp-section fp-prose${sx}${mx}`}>
          <div className="fp-shell fp-shell--narrow">
            {/* ADR 1073 D1 — a pull quote under the heading (the left column of a split head). */}
            {str(d.quote) ? (
              <div className="fp-prose__lead">
                <SectionHead eyebrow={eyebrow} heading={heading} />
                <blockquote className="fp-prose__quote"><p>{str(d.quote)}</p></blockquote>
              </div>
            ) : <SectionHead eyebrow={eyebrow} heading={heading} />}
            <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" sources={d.sources === true} /></div>
          </div>
        </section>
      );

    case 'image': {
      // ADR 1032 — an optional head over the figure, and a browser frame (a
      // window bar with a plain-text address label) around a screenshot. ADR
      // 1050 D5 — and the same tone band as the other sections (`sx`).
      const img = str(d.token) ? <img className="fp-figure__img" src={assetUrl(str(d.token))} alt={str(d.alt)} /> : null;
      const browser = d.frame === 'browser';
      return (
        <section className={`cms-public-section fp-section fp-figure${browser ? ' fp-figure--browser' : ''}${sx}${mx}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            {browser && img ? (
              <div className="fp-browser">
                <div className="fp-browser__bar" aria-hidden="true">
                  <span className="fp-browser__dot" /><span className="fp-browser__dot" /><span className="fp-browser__dot" />
                  {str(d.frameUrl) ? <span className="fp-browser__url">{str(d.frameUrl)}</span> : null}
                </div>
                {img}
              </div>
            ) : img}
            {str(d.caption) ? <p className="fp-figure__cap">{str(d.caption)}</p> : null}
          </div>
        </section>
      );
    }

    case 'cta':
      return (
        // ADR 1062 D4 — `split` puts the copy at the start and the button (with
        // its `note`) at the end on wide screens; `start` keeps the button under
        // left-aligned copy. A `note` ("No card needed") sits under the button.
        <section className={`cms-public-section fp-section fp-cta${d.align === 'start' ? ' fp-cta--start' : d.align === 'split' ? ' fp-cta--split' : ''}${sx}${mx}`}>
          <div className="fp-shell fp-cta__inner">
            <div className="fp-cta__copy">
              {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
              {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-cta__title"><HeadingText text={heading} /></h2> : null}
              {str(d.subheading) ? <p className="fp-cta__lede">{str(d.subheading)}</p> : null}
            </div>
            <div className="fp-cta__actions">
              <CtaLink label={str(d.label)} url={str(d.url)} primary />
              {str(d.note) ? <p className="fp-cta__note">{inlineMarkdown(str(d.note), 'cta-note')}</p> : null}
            </div>
          </div>
        </section>
      );

    case 'columns': {
      const cols: {
        title?: string; text?: string; href?: string; icon?: string; optional?: boolean;
        // ADR 0920 D4 item fields.
        eyebrow?: string; progress?: number; badge?: string; future?: boolean; partial?: boolean; art?: string;
        // ADR 1080 D9: a short mono tag over a gallery caption.
        tag?: string;
        // ADR 1029 D5 — a bento tile two columns wide.
        wide?: boolean;
        items?: { label?: string; meta?: string }[];
        // ADR 1037 — an item's picture (optionally browser-framed) and the
        // item the section singles out.
        imageToken?: string; alt?: string; frameUrl?: string; highlight?: boolean;
        // ADR 1069 D1 — a plan card's price unit and its own button.
        unit?: string; ctaLabel?: string; ctaUrl?: string;
      }[] = Array.isArray(d.columns) ? d.columns : [];
      const layout = str(d.layout) || 'cards';
      // ADR 1071 D1 — a section with a headline stat leads with the feature head.
      const hasStat = !!(d.stat && typeof d.stat === 'object' && typeof (d.stat as { value?: unknown }).value === 'number' && str((d.stat as { label?: unknown }).label));
      const colHead = hasStat
        ? <FeatureHead d={d} eyebrow={eyebrow} heading={heading} />
        : <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />;
      // ADR 0920 D4 — an optional footnote under the grid.
      // Inline markdown like every other columns text field, so a link in the
      // footnote renders as a link instead of `[label](/url)` source.
      // ADR 1069 D2 — `noteStyle: 'callout'` boxes the footnote with a mark.
      const note = !str(d.note) ? null : d.noteStyle === 'callout' ? (
        <p className="fp-cols__note fp-cols__note--callout">
          <span className="fp-cols__note-mark" aria-hidden="true">!</span>
          <span>{inlineMarkdown(str(d.note), 'cols-note')}</span>
        </p>
      ) : <p className="fp-cols__note">{inlineMarkdown(str(d.note), 'cols-note')}</p>;

      // ADR 1064 P3b — tiles with `filter: true`: chips filter the tiles by their
      // badge, and each badge is coloured by the column's status flags.
      if (layout === 'tiles' && d.filter === true) {
        return <FilteredTiles cols={cols} head={<SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />} note={note} cls={`cms-public-section fp-section fp-cols fp-cols--tiles${sx}${mx}`} stg={stg} />;
      }
      if (layout === 'ruled' || layout === 'panels' || layout === 'progress' || layout === 'tiles') {
        // Four parallel layouts that differ only in chrome (see global.css):
        // ruled = a hairline over each column; panels = filled, with a small
        // drawing; progress = a label line + bar; tiles = compact cards, four
        // across, a badge, and a dashed `future` card.
        return (
          <section className={`cms-public-section fp-section fp-cols fp-cols--${layout}${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className={`fp-cols__grid${stg}`}>
                {cols.map((c, i) => {
                  const p = fraction(c.progress);
                  return (
                    <li key={i} className={`fp-col${c.future ? ' fp-col--future' : ''}`}>
                      {layout === 'panels' ? <PanelArt kind={str(c.art)} /> : null}
                      {str(c.eyebrow) ? <p className="fp-col__eyebrow">{str(c.eyebrow)}</p> : null}
                      {layout === 'progress' && p !== null ? <ProgressBar value={p} /> : null}
                      {str(c.title) || str(c.badge) ? (
                        <h3 className="fp-col__title">
                          {str(c.title)}
                          {str(c.badge) ? <span className="fp-col__badge">{str(c.badge)}</span> : null}
                        </h3>
                      ) : null}
                      {str(c.text) ? <p className="fp-col__text">{inlineMarkdown(str(c.text), `col-${i}`)}</p> : null}
                      <ActionLink c={c as Record<string, unknown>} />
                    </li>
                  );
                })}
              </ul>
              {note}
            </div>
          </section>
        );
      }
      if (layout === 'list') {
        // Titled lists: each row a name and a short right-aligned meta ("14 days").
        // A column's `text` (a price, a one-line summary) sits between the title
        // and the list, as in every other layout; it used to be dropped silently.
        // A `future` column ("Not yet") gets `fp-col--future` like the other
        // layouts; it used to be dropped here, so a "Not yet" list looked like a
        // "works" list. When any column is future or `partial` ("partly
        // there") the section is a status list (`fp-cols--status`): works items
        // get a filled dot, partial items an amber half dot, future items a
        // hollow one. A list with neither (pricing) is unchanged.
        const status = cols.some((c) => c.future || c.partial);
        // ADR 1069 D1 — a list of plans (any column with a price unit or a
        // button, and no status) gets the plan cards: big prices, the button
        // pinned to the foot, the highlighted plan raised.
        const plans = !status && cols.some((c) => str(c.unit) || str(c.ctaLabel));
        return (
          <section className={`cms-public-section fp-section fp-cols fp-cols--list${status ? ' fp-cols--status' : ''}${plans ? ' fp-cols--plans' : ''}${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <div className={`fp-cols__grid${stg}`}>
                {cols.map((c, i) => (
                  <div key={i} className={`fp-col${c.highlight ? ' fp-col--highlight' : ''}${plans && c.highlight ? ' fp-tone--inverse' : ''}${c.future ? ' fp-col--future' : c.partial ? ' fp-col--partial' : ''}`}>
                    {str(c.eyebrow) ? <p className="fp-col__eyebrow">{str(c.eyebrow)}</p> : null}
                    {str(c.title) ? <h3 className="fp-col__title">{str(c.title)}{str(c.unit) ? <>{' '}<small className="fp-col__unit">{str(c.unit)}</small></> : null}</h3> : null}
                    {str(c.text) ? <p className="fp-col__text">{inlineMarkdown(str(c.text), `list-${i}`)}</p> : null}
                    <ul className="fp-col__items">
                      {(Array.isArray(c.items) ? c.items : []).filter((it) => str(it?.label)).map((it, j) => (
                        <li key={j} className="fp-col__item">
                          <span>{str(it.label)}</span>
                          {str(it.meta) ? <span className="fp-col__meta">{str(it.meta)}</span> : null}
                        </li>
                      ))}
                    </ul>
                    {str(c.ctaLabel) ? <p className="fp-col__cta"><CtaLink label={str(c.ctaLabel)} url={str(c.ctaUrl)} primary={c.highlight === true} /></p> : null}
                  </div>
                ))}
              </div>
              {note}
            </div>
          </section>
        );
      }

      // ADR 1038 D8 — a flow: the items as ordered steps with a connector. A
      // vertical rail on a phone, one row on a wide screen.
      if (layout === 'flow') {
        // Six steps, like the validator's cap (an overlay replaces the list whole
        // and is not checked against it). Text is inline markdown, like steps.
        const steps = cols.slice(0, 6)
          .map((c, i) => ({ label: str(c.title), text: str(c.text) ? inlineMarkdown(str(c.text), `flow-${i}`) : undefined, status: str((c as { status?: unknown }).status) || undefined, state: str((c as { state?: unknown }).state) || undefined }))
          .filter((st) => st.label);
        return (
          <section className={`cms-public-section fp-section fp-cols fp-cols--flow${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              {/* ADR 1064 P3c — `numbers: 'circle'` numbers the marks; `run` lights them in turn (with a pause control). */}
              <FlowRail steps={steps} pulse={false} numbered={d.numbers === 'circle'} run={d.run === true} className="fp-flow fp-flow--row" />
              {note}
            </div>
          </section>
        );
      }

      if (layout === 'stats') {
        // ADR 0762 — a heading/lede above the figures (optional: a bare stats
        // band still renders exactly as before). ADR 1063 P2d — a figure with
        // `progress` gets a bar under its label, coloured by the same status
        // flags as a status list (`future` / `partial`; none = works).
        return (
          <section className={`cms-public-section fp-section fp-stats${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <dl className={`fp-stats__grid${stg}`}>
                {cols.map((c, i) => {
                  const p = fraction(c.progress);
                  const status = c.future ? ' fp-stat--future' : c.partial ? ' fp-stat--partial' : p !== null ? ' fp-stat--works' : '';
                  return (
                    <div key={i} className={`fp-stat${status}`}>
                      <dt className="fp-stat__value">{d.count === true ? <StatValue title={str(c.title)} /> : str(c.title)}</dt>
                      <dd className="fp-stat__label">{str(c.text)}</dd>
                      {p !== null ? <dd className="fp-stat__bar"><ProgressBar value={p} /></dd> : null}
                    </div>
                  );
                })}
              </dl>
            </div>
          </section>
        );
      }
      // ADR 1063 P2d — a board: one lane per column, each a status (the same
      // `future` / `partial` flags as a status list; none = works) with a dot,
      // the lane title and its item count, then its items as cards (`label`,
      // with `meta` as a small note). Lists, not a grid of cells: each lane is
      // a heading and a list, so it reads in order without the layout.
      // ADR 1063 P2e — a gallery: screenshots as figures, each the column's
      // picture (browser-framed when it has a `frameUrl`) with its title and
      // text as the caption. `highlight` makes a proof card: the screenshot
      // leads a bordered card. A column with no picture is skipped: a gallery
      // item IS its picture, and every picture carries alt text (validator).
      if (layout === 'gallery') {
        const shots = cols.filter((c) => str(c.imageToken));
        return (
          <section className={`cms-public-section fp-section fp-gallery${d.bleed === true ? ' fp-gallery--bleed' : ''}${sx}${mx}`}>
            {/* ADR 1080 D9 — `bleed`: the pictures run edge to edge, with no gutter or corners. */}
            <div className={d.bleed === true ? 'fp-gallery__bleed' : 'fp-shell'}>
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              {/* ADR 1072 D2 — `galleryLayout: 'lead'`: the first picture tall on the left, the rest stacked beside it. */}
              <div className={`fp-gallery__grid${shots.length === 1 ? ' fp-gallery__grid--one' : ''}${d.galleryLayout === 'lead' && shots.length > 1 ? ' fp-gallery__grid--lead' : ''}${stg}`}>
                {shots.map((c, i) => (
                  <figure key={i} className={`fp-gallery__item${c.highlight ? ' fp-gallery__item--proof' : ''}`}>
                    <ColumnShot token={str(c.imageToken)} alt={str(c.alt)} frameUrl={str(c.frameUrl)} className="fp-gallery__shot" />
                    {str(c.title) || str(c.text) || str(c.tag) ? (
                      <figcaption className="fp-gallery__cap">
                        {str(c.tag) ? <span className="fp-gallery__tag">{str(c.tag)}</span> : null}
                        {str(c.title) ? <strong className="fp-gallery__title">{str(c.title)}</strong> : null}
                        {str(c.text) ? <span className="fp-gallery__text">{inlineMarkdown(str(c.text), `gallery-${i}`)}</span> : null}
                      </figcaption>
                    ) : null}
                  </figure>
                ))}
              </div>
              {note}
            </div>
          </section>
        );
      }
      if (layout === 'board') {
        return (
          <section className={`cms-public-section fp-section fp-board${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <div className={`fp-board__lanes${stg}`}>
                {cols.map((c, i) => {
                  const items = (Array.isArray(c.items) ? c.items : []).filter((it) => str(it?.label));
                  const status = c.future ? 'future' : c.partial ? 'partial' : 'works';
                  return (
                    <div key={i} className={`fp-lane fp-lane--${status}`}>
                      <h3 className="fp-lane__title">
                        <span className="fp-lane__dot" aria-hidden="true" />
                        {str(c.title)}
                        <span className="fp-lane__count">{formatNumber(items.length)}</span>
                      </h3>
                      {/* ADR 1068 D3 — a lane's own line (the roadmap's proof line). */}
                      {str(c.text) ? <p className="fp-lane__text">{inlineMarkdown(str(c.text), `lane-${i}`)}</p> : null}
                      <ul className="fp-lane__items">
                        {items.map((it, j) => (
                          <li key={j} className="fp-lane__item">
                            {str(it.label)}
                            {str(it.meta) ? <small className="fp-lane__note">{str(it.meta)}</small> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
              {note}
            </div>
          </section>
        );
      }
      if (layout === 'rows') {
        // Statement rows: a short claim set large on the left, the plain
        // explanation on the right, one hairline between each. For a set of
        // parallel promises — no numbering (they are not a sequence) and no
        // card chrome (they are one argument, not a menu).
        // ADR 1032 — with `toggles`, the head and a try-it panel of switches
        // sit on the left and the rows on the right.
        const toggles = toggleSpec(d.toggles);
        // ADR 1068 D2 — with a diagram, the head and the diagram take the side
        // column and the toggles panel moves to the top of the rows (HOME-31).
        const diagram = diagramSpec(d.diagram);
        if (toggles || diagram) {
          const rowsList = (
                <ul className={`fp-rows__list${stg}`}>
                  {cols.map((c, i) => (
                    <li key={i} className="fp-row">
                      {str(c.title) ? <h3 className="fp-row__title">{str(c.title)}</h3> : null}
                      <p className="fp-row__text">{inlineMarkdown(str(c.text), `row-${i}`)}</p>
                    </li>
                  ))}
                </ul>
          );
          return (
            <section className={`cms-public-section fp-section fp-rows fp-rows--try${diagram ? ' fp-rows--diagram' : ''}${sx}${mx}`}>
              <div className="fp-shell fp-rows__split">
                <div className="fp-rows__side">
                  <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
                  {diagram ? <WorkflowDiagram spec={diagram} /> : toggles ? <TryToggles spec={toggles} /> : null}
                </div>
                {diagram && toggles ? (
                  <div className="fp-rows__main">
                    <TryToggles spec={toggles} />
                    {rowsList}
                  </div>
                ) : rowsList}
              </div>
            </section>
          );
        }
        return (
          <section className={`cms-public-section fp-section fp-rows${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className={`fp-rows__list${stg}`}>
                {cols.map((c, i) => (
                  <li key={i} className="fp-row">
                    {str(c.title) ? <h3 className="fp-row__title">{str(c.title)}</h3> : null}
                    <p className="fp-row__text">{inlineMarkdown(str(c.text), `row-${i}`)}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      }
      // ADR 1029 D5 — a timeline: an ordered list on a rail. The rail fills as the
      // section scrolls into view only when the author chose a motion.
      // ADR 1063 D3 — incidents: timestamped events as stacked cards, each an
      // icon, the time (the column `eyebrow`, in mono) and one sentence. An
      // ordered list: the order is the order they happened in.
      if (layout === 'incidents') {
        // ADR 1068 D2 — under a split head the heading takes the first column and
        // the lede, the incidents and the closing note stack in the second (the
        // design's "It worked in the demo. On Tuesday:"). The note is lede-sized.
        const split = d.head === 'split';
        const incidentNote = str(d.note) ? <p className="fp-cols__note fp-incidents__note">{inlineMarkdown(str(d.note), 'incidents-note')}</p> : null;
        const list = (
              <ol className={`fp-incidents__list${stg}`}>
                {cols.map((c, i) => (
                  <li key={i} className="fp-incident">
                    <CardGlyph icon={c.icon} i={i} />
                    <div className="fp-incident__body">
                      {str(c.eyebrow) ? <p className="fp-incident__when">{str(c.eyebrow)}</p> : null}
                      {str(c.title) ? <h3 className="fp-incident__title">{str(c.title)}</h3> : null}
                      {str(c.text) ? <p className="fp-incident__text">{inlineMarkdown(str(c.text), `incident-${i}`)}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
        );
        if (split) {
          return (
            <section className={`cms-public-section fp-section fp-incidents${sx}${mx}`}>
              <div className="fp-shell fp-incidents__split">
                <div className="fp-incidents__head"><SectionHead eyebrow={eyebrow} heading={heading} /></div>
                <div className="fp-incidents__side">
                  {str(d.lede) ? <p className="fp-head__lede">{inlineMarkdown(str(d.lede), 'lede')}</p> : null}
                  {list}
                  {incidentNote}
                </div>
              </div>
            </section>
          );
        }
        return (
          <section className={`cms-public-section fp-section fp-incidents${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              {list}
              {incidentNote}
            </div>
          </section>
        );
      }
      if (layout === 'timeline') {
        // ADR 1064 P3f — an optional picture beside the rail on wide screens.
        const shot = str(d.imageToken) ? <ColumnShot token={str(d.imageToken)} alt={str(d.alt)} frameUrl={str(d.frameUrl)} className="fp-timeline__shot" /> : null;
        // ADR 1073 D2 — `shotSide: 'start'`: the head and the picture on the start
        // side, the rail beside them (the picture before the list on a phone).
        const startSide = d.shotSide === 'start';
        // ADR 1073 D3 — `markers: 'badge'`: a numbered badge per item; the
        // highlighted (live) item's badge is green.
        const badges = d.markers === 'badge';
        const tlHead = <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />;
        return (
          <section className={`cms-public-section fp-section fp-timeline${shot ? ' fp-timeline--shot' : ''}${startSide ? ' fp-timeline--start' : ''}${badges ? ' fp-timeline--badges' : ''}${sx}${mx}`}>
            <div className="fp-shell">
              {startSide ? null : tlHead}
              <div className="fp-timeline__body">
              {startSide ? <div className="fp-timeline__aside">{tlHead}{shot}</div> : null}
              <ol className={`fp-timeline__list${stg}`}>
                {cols.map((c, i) => (
                  <li key={i} className={`fp-timeline__item${badges && c.highlight ? ' fp-timeline__item--live' : ''}`}>
                    {badges
                      ? <span className="fp-timeline__badge" aria-hidden="true">{pad2(i + 1)}</span>
                      : <span className="fp-timeline__dot" aria-hidden="true" />}
                    {str(c.eyebrow) ? <p className="fp-timeline__when">{str(c.eyebrow)}</p> : null}
                    {str(c.title) ? <h3 className="fp-timeline__title">{str(c.title)}</h3> : null}
                    <p className="fp-timeline__text">{inlineMarkdown(str(c.text), `tl-${i}`)}</p>
                  </li>
                ))}
              </ol>
              {startSide ? null : shot}
              </div>
              {note}
            </div>
          </section>
        );
      }
      // ADR 1029 D5 — a bento grid: cards of mixed width (`wide` spans two).
      if (layout === 'bento') {
        return (
          <section className={`cms-public-section fp-section fp-bento${sx}${mx}`}>
            <div className="fp-shell">
              {colHead}
              <div className={`fp-bento__grid${stg}`}>
                {cols.map((c, i) => {
                  // ADR 1063 P2c — `tone: 'inverse'` makes a dark tile (the band
                  // tokens, scoped to the tile); `count` leads with a number.
                  const cx = c as { count?: unknown; tone?: unknown; gauge?: unknown; tall?: unknown; countLabel?: unknown; imagePosition?: unknown };
                  // ADR 1070 D1 — `tall` spans two rows; `tone: 'mist'` is a muted tile.
                  const tileClass = `fp-card fp-bento__tile${c.wide ? ' fp-bento__tile--wide' : ''}${cx.tall === true ? ' fp-bento__tile--tall' : ''}${c.highlight ? ' fp-bento__tile--highlight' : ''}${cx.tone === 'inverse' ? ' fp-bento__tile--inverse fp-tone--inverse' : cx.tone === 'mist' ? ' fp-bento__tile--mist' : ''}`;
                  const count = typeof cx.count === 'number' && Number.isInteger(cx.count) && cx.count >= 0 ? cx.count : null;
                  // ADR 1070 D2 — a labelled number is the tile's stat, under its text.
                  const countLabel = count !== null ? str(cx.countLabel) : '';
                  // ADR 1070 D3 — the picture at the tile's top instead of its foot.
                  const shotTop = cx.imagePosition === 'top';
                  const shot = <ColumnShot token={str(c.imageToken)} alt={str(c.alt)} frameUrl={str(c.frameUrl)} className={`fp-bento__shot${shotTop ? ' fp-bento__shot--top' : ''}`} />;
                  const tileBody = (
                  <>
                    {/* ADR 1063 P2d — the ADR 1038 D3 count-up (StatValue): the real number
                        stays in the DOM; CSS counts it up on the tile's view timeline. */}
                    {/* ADR 1064 P3d — the same ring gauge as the cards layout, leading the tile. */}
                    {str(cx.gauge) ? <GaugeRing label={str(cx.gauge)} value={fraction(c.progress) ?? 1} /> : null}
                    {shotTop ? shot : null}
                    {count !== null && !countLabel ? <p className="fp-bento__count"><StatValue title={String(count)} /></p> : null}
                    {/* ADR 1070 D4 — a tile's icon, only for a known slug (no node-motif fallback here). */}
                    {c.icon && ICON_BY_SLUG[c.icon] ? <CardGlyph icon={c.icon} i={i} /> : null}
                    {/* ADR 1071 D2 — an eyebrow that is only a number ("01") is a number chip. */}
                    {str(c.eyebrow) ? <p className={`fp-bento__eyebrow${/^\d{1,3}$/.test(str(c.eyebrow)) ? ' fp-bento__eyebrow--num' : ''}`}>{str(c.eyebrow)}</p> : null}
                    {str(c.title) ? <h3 className="fp-card__title">{str(c.title)}</h3> : null}
                    <p className="fp-card__text">{inlineMarkdown(str(c.text), `bento-${i}`)}</p>
                    {countLabel ? (
                      <p className="fp-bento__stat">
                        <span className="fp-bento__count fp-bento__count--big"><StatValue title={String(count)} /></span>
                        <span className="fp-bento__count-label">{countLabel}</span>
                      </p>
                    ) : null}
                    {/* ADR 1032 — a tile's items render as a small inset card:
                        each a bold line and its detail (e.g. "Ready to print"). */}
                    {(Array.isArray(c.items) ? c.items : []).filter((it) => str(it?.label)).map((it, j) => (
                      <p key={j} className="fp-bento__inset">
                        <strong className="fp-bento__inset-title">{str(it.label)}</strong>
                        {str(it.meta) ? <span className="fp-bento__inset-meta">{str(it.meta)}</span> : null}
                        {/* ADR 1071 D3 — a short note on the row's other side. */}
                        {str((it as { aside?: unknown }).aside) ? <span className="fp-bento__inset-aside">{str((it as { aside?: unknown }).aside)}</span> : null}
                      </p>
                    ))}
                    {/* ADR 1037 — a picture at the tile's foot. */}
                    {shotTop ? null : shot}
                  </>
                  );
                  // ADR 1037 — a tile with a link is ONE link (the cards layout model).
                  const href = str(c.href);
                  if (href && isInternal(href)) return <Link key={i} to={href} className={`${tileClass} fp-card--link`}>{tileBody}</Link>;
                  if (href && isSafeHref(href)) return <a key={i} href={href} className={`${tileClass} fp-card--link`} rel="noopener noreferrer">{tileBody}</a>;
                  return <article key={i} className={tileClass}>{tileBody}</article>;
                })}
              </div>
              {note}
            </div>
          </section>
        );
      }
      // ADR 1047 — feature cards: two columns of rich cards.
      if (layout === 'features') {
        return (
          <section className={`cms-public-section fp-section fp-features${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <FeatureCards cols={cols as FeatureItem[]} legend={d.tagLegend && typeof d.tagLegend === 'object' ? (d.tagLegend as Record<string, unknown>) : {}} stg={stg} />
              {note}
            </div>
          </section>
        );
      }
      // ADR 1029 D5 — a marquee: the items' titles drifting sideways, pausable.
      if (layout === 'marquee') {
        return (
          <section className={`cms-public-section fp-section fp-marquee-section${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              {cols.some((c) => str(c.imageToken)) ? (
                // ADR 1037 — items with pictures drift as app cards: a framed
                // screenshot, a name and a line.
                <Marquee
                  items={cols.map((c) => str(c.title) || str(c.text)).filter(Boolean)}
                  cards={cols.filter((c) => str(c.title) || str(c.text)).map((c, i) => (
                    <div className="fp-marquee__card">
                      <ColumnShot token={str(c.imageToken)} alt={str(c.alt)} frameUrl={str(c.frameUrl)} className="fp-marquee__shot" />
                      {str(c.title) ? <p className="fp-marquee__card-title">{str(c.title)}</p> : null}
                      {str(c.text) ? <p className="fp-marquee__card-text">{inlineMarkdown(str(c.text), `mq-${i}`)}</p> : null}
                    </div>
                  ))}
                />
              ) : (
                <Marquee items={cols.map((c) => str(c.title) || str(c.text)).filter(Boolean)} />
              )}
              {note}
            </div>
          </section>
        );
      }
      if (layout === 'steps') {
        // ADR 1050 D1 — five or six steps take one row on a wide screen (2–4
        // already do under auto-fit, and keep their exact markup).
        const fit = cols.length === 5 ? ' fp-steps--n5' : cols.length === 6 ? ' fp-steps--n6' : '';
        // ADR 1072 D1 — `cards`: each step a boxed card with a number chip ("01")
        // and an arrow to the next; a `highlight` step is the dark card.
        const stepCards = d.cards === true;
        return (
          <section className={`cms-public-section fp-section fp-steps${d.numbers === 'circle' && !stepCards ? ' fp-steps--circle' : ''}${stepCards ? ' fp-steps--cards' : ''}${fit}${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} />
              <ol className={`fp-steps__list${stg}`}>
                {cols.map((c, i) => (
                  <li key={i} className={`fp-step${stepCards && c.highlight ? ' fp-step--highlight fp-tone--inverse' : ''}`}>
                    <span className="fp-step__num">{d.numbers === 'circle' && !stepCards ? i + 1 : pad2(i + 1)}</span>
                    <div className="fp-step__body">
                      {str(c.title) ? <h3 className="fp-step__title">{str(c.title)}</h3> : null}
                      <p className="fp-step__text">{inlineMarkdown(str(c.text), `step-${i}`)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        );
      }
      if (layout === 'prompts') {
        // ADR 0762 — example prompts: a short tag (title) over the prompt itself
        // (text), set as a quotation. Each card links where it can be typed.
        return (
          <section className={`cms-public-section fp-section fp-prompts${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className={`fp-prompts__grid${stg}`}>
                {cols.map((c, i) => {
                  const href = str(c.href);
                  const inner = (
                    <>
                      {str(c.title) ? <span className="fp-prompt__tag">{str(c.title)}</span> : null}
                      <q className="fp-prompt__text">{str(c.text)}</q>
                      {href ? <span className="fp-prompt__action">{t('promptTry')} <ArrowRightIcon size={16} /></span> : null}
                    </>
                  );
                  let card: JSX.Element = <div className="fp-prompt">{inner}</div>;
                  if (href && isInternal(href)) card = <Link to={href} className="fp-prompt fp-prompt--link">{inner}</Link>;
                  else if (href && isSafeHref(href)) card = <a href={href} className="fp-prompt fp-prompt--link" rel="noopener noreferrer">{inner}</a>;
                  return <li key={i}>{card}</li>;
                })}
              </ul>
            </div>
          </section>
        );
      }
      if (layout === 'dives') {
        // ADR 0762 — deep dives: one numbered claim per row with a built-in
        // illustration beside it (DiveArt, by `icon` slug), sides alternating.
        return (
          <section className={`cms-public-section fp-section fp-dives${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ol className={`fp-dives__list${stg}`}>
                {cols.map((c, i) => (
                  <li key={i} className="fp-dive">
                    <div className="fp-dive__text">
                      <span className="fp-dive__num">{pad2(i + 1)}</span>
                      {str(c.title) ? <h3 className="fp-dive__title">{str(c.title)}</h3> : null}
                      <p className="fp-dive__lede">{inlineMarkdown(str(c.text), `dive-${i}`)}</p>
                    </div>
                    <DiveArt kind={str(c.icon)} />
                  </li>
                ))}
              </ol>
            </div>
          </section>
        );
      }
      if (layout === 'showcase') {
        return (
          <section className={`cms-public-section fp-section fp-showcase${sx}${mx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <div className={`fp-showcase__grid${stg}`}>
                {cols.map((c, i) => {
                  const href = str(c.href);
                  const hasLink = Boolean(href && (isInternal(href) || isSafeHref(href)));
                  const cardInner = (
                    <>
                      <div className="fp-showcase-card__top">
                        <CardGlyph icon={c.icon} i={i} />
                        <span className="fp-showcase-card__index">{pad2(i + 1)}</span>
                      </div>
                      {str(c.title) ? <h3 className="fp-showcase-card__title">{str(c.title)}</h3> : null}
                      <p className="fp-showcase-card__text">{inlineMarkdown(str(c.text), `showcase-${i}`)}</p>
                      {hasLink ? <span className="fp-showcase-card__action">{t('showcaseExplore')} <ArrowRightIcon size={16} /></span> : null}
                    </>
                  );
                  if (href && isInternal(href)) return <Link key={i} to={href} className="fp-showcase-card fp-showcase-card--link">{cardInner}</Link>;
                  if (href && isSafeHref(href)) return <a key={i} href={href} className="fp-showcase-card fp-showcase-card--link" rel="noopener noreferrer">{cardInner}</a>;
                  return <article key={i} className="fp-showcase-card">{cardInner}</article>;
                })}
              </div>
            </div>
          </section>
        );
      }
      return (
        <section className={`cms-public-section fp-section fp-cards${sx}${mx}`}>
          <div className="fp-shell">
            {colHead}
            <div className={`fp-cards__grid${stg}`}>
              {cols.map((c, i) => {
                const cardInner = (
                  <>
                    {str((c as { gauge?: unknown }).gauge)
                      ? <GaugeRing label={str((c as { gauge?: unknown }).gauge)} value={fraction(c.progress) ?? 1} />
                      : <CardGlyph icon={c.icon} i={i} />}
                    {str(c.title) ? <h3 className="fp-card__title">{str(c.title)}</h3> : null}
                    {c.optional ? <span className="fp-card__badge">{t('optionalBadge')}</span> : null}
                    <p className="fp-card__text">{inlineMarkdown(str(c.text), `card-${i}`)}</p>
                    <ActionLink c={c as Record<string, unknown>} />
                  </>
                );
                // ADR 1068 D3 — a card with its own action line is not ALSO a whole-card
                // link (links never nest); the visible line carries the target.
                const href = str(c.ctaLabel) ? '' : str(c.href);
                // ADR 1070 D5 — a card's own tone, as on a bento tile: dark (the band
                // tokens, scoped to the card) or muted.
                const ct = (c as { tone?: unknown }).tone;
                const cardClass = `fp-card${ct === 'inverse' ? ' fp-card--inverse fp-tone--inverse' : ct === 'mist' ? ' fp-card--mist' : ''}`;
                // Whole-card link: ONE anchor per card (no nested links — card text
                // carries no inline link when href is set). Keyboard + semantics free.
                if (href && isInternal(href)) return <Link key={i} to={href} className={`${cardClass} fp-card--link`}>{cardInner}</Link>;
                if (href && isSafeHref(href)) return <a key={i} href={href} className={`${cardClass} fp-card--link`} rel="noopener noreferrer">{cardInner}</a>;
                return <article key={i} className={cardClass}>{cardInner}</article>;
              })}
            </div>
            {note}
          </div>
        </section>
      );
    }

    // C7 (ecommerce gap plan) — validated product REFERENCES resolved live at
    // render time from the public storefront read; a missing/archived product
    // simply doesn't render (the fallback), never stale copied data.
    case 'productGrid':
      return (
        <section className={`cms-public-section${mx}`}>
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-h2"><HeadingText text={heading} /></h2> : null}
            <ProductGridSection storeOrgId={str(d.storeOrgId)} productIds={Array.isArray(d.productIds) ? (d.productIds as unknown[]).filter((x): x is string => typeof x === 'string') : []} />
          </div>
        </section>
      );

    // ADR 0391 (b) — the pricing tier grid. Heading/eyebrow/blurb are authored
    // in the section; the live tier catalog (names + marketing-safe feature/limit
    // lists + optional operator display prices) is fetched from the public
    // billing read at render time — NO price is ever baked into the section or
    // the SPA (billing owns the config; honest-when-unconfigured).
    case 'pricing':
      return (
        <section className={`cms-public-section fp-section fp-pricing${mx}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.blurb) || undefined} />
            <Suspense fallback={<div className="u-p-2" role="status" aria-label={t('common:loading')}><Skeleton /></div>}>
              <LazyPricingSection
                tierFilter={Array.isArray(d.tiers) ? (d.tiers as unknown[]).filter((x): x is string => typeof x === 'string') : []}
                ctaLabel={str(d.ctaLabel) || undefined}
                ctaUrl={str(d.ctaUrl) || undefined}
                contactUrl={str(d.contactUrl) || undefined}
              />
            </Suspense>
          </div>
        </section>
      );

    // ADR 0331 §D2 — a form REFERENCE ({ formId }) resolved live at render
    // time from the public forms read.
    //
    // FORM-UX-4 CORRECTION (ADR 0584): this comment used to end "a
    // missing/unpublished/toggled-off form renders nothing (uniform 404
    // honesty), never a broken page" — and passing no `renderUnavailable` did
    // exactly that. But rendering nothing UNDER AN INTACT EYEBROW AND HEADING is
    // not honesty, it is the false-empty state: the visitor reads "Get in touch"
    // over blank space and cannot tell a removed form from a broken page. The
    // uniform-404 property that genuinely matters is that a DRAFT's existence
    // never leaks, and a generic "this form isn't available" line leaks nothing
    // — it is the same sentence for deleted, unpublished and toggled-off. The
    // renderer now draws that state itself, so this case inherits it.
    case 'form': {
      const formId = str(d.formId);
      if (!formId) return <section className={`cms-public-section${mx}`} />;
      // ADR 1064 — the form card: the head and lede beside a card holding the
      // form, headed by who reads the message. The form's fields are the
      // form's own (never copied); the card only lays them out.
      if (d.layout === 'card') {
        const person = typeof d.person === 'object' && d.person !== null ? d.person as Record<string, unknown> : {};
        return (
          <section className={`cms-public-section fp-section fp-formcard${sx}${mx}`}>
            <div className="fp-shell fp-formcard__inner">
              {/* ADR 1080 D12 — a photo under the copy, beside the form card. Without one the head stays a direct child. */}
              {str(d.imageToken) ? (
                <div className="fp-formcard__intro">
                  <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
                  <img className="fp-formcard__photo" src={assetUrl(str(d.imageToken))} alt={str(d.alt)} />
                </div>
              ) : <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />}
              <div className="fp-formcard__card">
                {str(person.name) || str(person.note) ? (
                  <div className="fp-formcard__person">
                    {str(person.imageToken) ? <img className="fp-formcard__avatar" src={assetUrl(str(person.imageToken))} alt={str(person.alt)} width={48} height={48} /> : null}
                    <p className="fp-formcard__who">
                      {str(person.name) ? <strong>{str(person.name)}</strong> : null}
                      {str(person.note) ? <span>{str(person.note)}</span> : null}
                    </p>
                  </div>
                ) : null}
                <Suspense fallback={<div className="u-p-2" role="status"><Skeleton /></div>}>
                  <LazyPublicFormRenderer formId={formId} hideTitle={Boolean(heading)} card submitLabel={str(d.submitLabel) || undefined} />
                </Suspense>
                {/* ADR 1068 D3 — a short note under the form. */}
                {str(d.note) ? <p className="fp-formcard__note">{inlineMarkdown(str(d.note), 'formcard-note')}</p> : null}
              </div>
            </div>
          </section>
        );
      }
      return (
        <section className={`cms-public-section${mx}`}>
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-h2"><HeadingText text={heading} /></h2> : null}
            <Suspense fallback={<div className="u-p-2" role="status"><Skeleton /></div>}>
              <LazyPublicFormRenderer formId={formId} hideTitle={Boolean(heading)} submitLabel={str(d.submitLabel) || undefined} />
            </Suspense>
          </div>
        </section>
      );
    }

    // ADR 0407 D1 — entity-backed sections: a stored QUERY REFERENCE resolved
    // live at render time from the ANONYMOUS public-entities read (publicRead
    // types only — the section can never surface anything the anonymous wire
    // wouldn't). A missing/non-public type renders the fallback (nothing),
    // never stale copied data — the productGrid model.
    case 'entityList':
      return (
        <section className={`cms-public-section${mx}`}>
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-h2"><HeadingText text={heading} /></h2> : null}
            <EntityListSection
              tenantId={str(d.tenantId)} typeName={str(d.typeName)}
              titleField={str(d.titleField)} bodyField={str(d.bodyField) || undefined}
              limit={typeof d.limit === 'number' ? d.limit : 6}
              sortKey={str(d.sortKey) || undefined}
              sortDir={d.sortDir === 'asc' || d.sortDir === 'desc' ? d.sortDir : undefined}
              termId={str(d.termId) || undefined}
              filterKey={str(d.filterKey) || undefined}
              filterValue={str(d.filterValue) || undefined}
            />
          </div>
        </section>
      );

    case 'entityDetail':
      return (
        <section className={`cms-public-section${mx}`}>
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-h2"><HeadingText text={heading} /></h2> : null}
            <EntityDetailSection
              tenantId={str(d.tenantId)} typeName={str(d.typeName)} entityId={str(d.entityId)}
              titleField={str(d.titleField)} bodyField={str(d.bodyField) || undefined}
            />
          </div>
        </section>
      );

    // ADR 0485 — a capability comparison MATRIX. All cells are short authored
    // status tokens (text, never HTML/links); rows = capabilities, columns =
    // named products. The wide table scrolls inside its own region (never the
    // page body); each glyph cell carries an sr-only word so it isn't color-
    // or symbol-only to assistive tech.
    case 'comparison': {
      const columns: string[] = Array.isArray(d.columns)
        ? (d.columns as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      const rows: { label: string; cells: string[] }[] = Array.isArray(d.rows)
        ? (d.rows as unknown[]).map((r) => {
          const rr = r as { label?: unknown; cells?: unknown };
          return {
            label: str(rr.label),
            cells: Array.isArray(rr.cells) ? (rr.cells as unknown[]).map(str) : [],
          };
        }).filter((r) => r.label.length > 0)
        : [];
      if (columns.length === 0 || rows.length === 0) return <section className={`cms-public-section${mx}`} />;
      const highlight = typeof d.highlightColumn === 'number' ? d.highlightColumn : -1;
      const legend = str(d.legend);
      const note = str(d.note);
      return (
        <section className={`cms-public-section fp-section fp-matrix${d.style === 'text' ? ' fp-matrix--text' : ''}${mx}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-matrix__scroll" role="region" aria-label={(heading && stripHeadingEmphasis(heading)) || t('comparisonRegion', { defaultValue: 'Comparison matrix' })} tabIndex={0}>
              <table className="fp-matrix__table">
                <thead>
                  <tr>
                    <td className="fp-matrix__corner" />
                    {columns.map((c, i) => (
                      <th key={i} scope="col" className={i === highlight ? 'fp-matrix__colhead fp-matrix__colhead--hl' : 'fp-matrix__colhead'}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      <th scope="row" className="fp-matrix__rowhead">{row.label}</th>
                      {columns.map((_, ci) => {
                        const v = str(row.cells[ci]);
                        // A11Y-2 — an under-authored row (cells shorter than
                        // columns) used to render a truly BLANK cell: nothing
                        // for a screen reader, ambiguity for everyone else.
                        // An absent cell claims nothing — "not specified".
                        if (!v.trim()) {
                          return (
                            <td key={ci} className={compareCellClass('', ci === highlight)}>
                              <span aria-hidden="true" className="fp-matrix__mark">—</span>
                              <span className="sr-only">{t('pricingCompareUnspecified', { defaultValue: 'Not specified' })}</span>
                            </td>
                          );
                        }
                        const aria = compareCellAria(v, t);
                        return (
                          <td key={ci} className={compareCellClass(v, ci === highlight)}>
                            <span aria-hidden={aria ? true : undefined} className="fp-matrix__mark">{v}</span>
                            {aria ? <span className="sr-only">{aria}</span> : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {legend ? <p className="fp-matrix__legend">{legend}</p> : null}
            {note ? <p className="fp-matrix__note">{note}</p> : null}
          </div>
        </section>
      );
    }

    // ADR 1080 D1–D4 — the design section types.
    case 'statusTable': case 'dateCalc': case 'conversation': case 'featureIndex': case 'decisionTree': case 'scheduleSim':
      return <DesignSection section={section} sx={`${sx}${mx}`} />;

    case 'faq': {
      // R2-G10 — authored Q/A on native <details>/<summary>: keyboard + SR
      // support for free, no JS state, and the prerender emits FAQPage JSON-LD
      // from the same validated data.
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((it) => ({ q: str((it as { q?: unknown }).q), a: str((it as { a?: unknown }).a) }))
        .filter((it) => it.q && it.a);
      if (items.length === 0) return <section className={`cms-public-section${mx}`} />;
      // ADR 1063 D2 — `columns: 2` sets the questions in two columns on wide
      // screens (with a rotating + marker); `openFirst` opens the first answer;
      // an optional picture sits under the head.
      const faqCols = d.columns === 2;
      return (
        <section className={`cms-public-section${sx ? ` fp-section fp-faq-section${sx}` : ''}${mx}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <ColumnShot token={str(d.imageToken)} alt={str(d.alt)} frameUrl={str(d.frameUrl)} className="fp-faq__shot" />
            <div className={`fp-faq${faqCols ? ' fp-faq--cols2' : ''}${stg}`}>
              {items.map((it, i) => (
                <details key={i} className="fp-faq__item" open={d.openFirst === true && i === 0 ? true : undefined}>
                  <summary className="fp-faq__q">{it.q}</summary>
                  <p className="fp-faq__a">{it.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      );
    }

    case 'fields': {
      // ADR 0748 — protocol-authored named fields: a definition list, every key
      // and value rendered as TEXT (never markup, never a link). No SectionHead —
      // a field called `heading` is data the author named, not page structure.
      const rows = Object.entries(d)
        .map(([k, v]) => [k, typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''] as const)
        .filter(([, v]) => v !== '');
      if (rows.length === 0) return <section className={`cms-public-section${mx}`} />;
      return (
        <section className={`cms-public-section${mx}`}>
          <div className="fp-shell">
            <dl className="fp-fields">
              {rows.map(([k, v]) => (
                <Fragment key={k}><dt className="fp-fields__k">{k}</dt><dd className="fp-fields__v">{v}</dd></Fragment>
              ))}
            </dl>
          </div>
        </section>
      );
    }

    case 'video':
      return <VideoSection d={d} eyebrow={eyebrow} heading={heading} sx={`${sx}${mx}`} />;

    case 'quotes': {
      // R2-G10 — attributed social proof. Real <figure>/<blockquote> semantics;
      // an unattributed quote renders with no byline — never an invented one.
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((it) => {
          const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
          return { quote: str(ii.quote), name: str(ii.name), role: str(ii.role) };
        })
        .filter((it) => it.quote);
      if (items.length === 0) return <section className={`cms-public-section${mx}`} />;
      return (
        <section className={`cms-public-section${sx ? ` fp-section${sx}` : ''}${mx}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className={`fp-quotes${d.style === 'pull' ? ' fp-quotes--pull' : ''}${stg}`}>
              {items.map((it, i) => (
                <figure key={i} className="fp-quote">
                  <blockquote className="fp-quote__text"><p>{it.quote}</p></blockquote>
                  {it.name || it.role ? (
                    <figcaption className="fp-quote__byline">
                      {it.name ? <span className="fp-quote__name">{it.name}</span> : null}
                      {it.name && it.role ? <span aria-hidden="true"> · </span> : null}
                      {it.role ? <span className="fp-quote__role">{it.role}</span> : null}
                    </figcaption>
                  ) : null}
                </figure>
              ))}
            </div>
          </div>
        </section>
      );
    }

    default:
      return <section className={`cms-public-section${mx}`} />;
  }
}

/** The anonymous public-entities wire shape (ADR 0407 D2 projection). */
interface PublicEntityRow {
  entityId: string;
  values: Record<string, string | number | boolean>;
}

const publicEntityValue = (row: PublicEntityRow, field: string): string => {
  const v = row.values?.[field]; // guard a wire row missing `values` (pricing-'*' class)
  return v === undefined || v === null ? '' : String(v);
};

/** Live entity rows for the entityList section (one anonymous read per render). */
function EntityListSection({ tenantId, typeName, titleField, bodyField, limit, sortKey, sortDir, termId, filterKey, filterValue }: {
  tenantId: string; typeName: string; titleField: string; bodyField?: string | undefined;
  limit: number; sortKey?: string | undefined; sortDir?: 'asc' | 'desc' | undefined; termId?: string | undefined;
  filterKey?: string | undefined; filterValue?: string | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('cms');
  const [rows, setRows] = useState<PublicEntityRow[] | null>(null);
  // A failed read is NOT an empty list. Collapsing the two rendered `null`,
  // which on a PUBLIC page silently deletes a whole configured section: the
  // visitor sees a short page, and the operator gets no signal at all. Same
  // separation `PricingSection` already makes below.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!tenantId || !typeName || !titleField) { setRows([]); return; }
    const params = new URLSearchParams({ limit: String(limit) });
    if (sortKey) { params.set('sortKey', sortKey); if (sortDir) params.set('sortDir', sortDir); }
    if (termId) params.set('termId', termId);
    if (filterKey && filterValue) params.set('filters', JSON.stringify([{ key: filterKey, op: 'eq', value: filterValue }]));
    void fetch(`${config.baseUrl}/host/openwop-app/public-entities/${encodeURIComponent(tenantId)}/types/${encodeURIComponent(typeName)}/entities?${params}`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { entities: PublicEntityRow[] }; })
      // Guard the wire shape: a 200 with a non-array `entities` would slip the
      // `rows.length` check and crash `rows.map` in render (outside this catch) —
      // the pricing-'*' crash class. Narrow to an array (empty ⇒ the null fallback).
      .then((r) => { setError(false); setRows(Array.isArray(r.entities) ? r.entities : []); })
      .catch(() => { setError(true); setRows([]); });
  }, [tenantId, typeName, titleField, limit, sortKey, sortDir, termId, filterKey, filterValue]);
  if (error) return <p className="fp-pricing__note">{t('sectionLoadError', { defaultValue: 'Couldn’t load this section.' })}</p>;
  if (!rows || rows.length === 0) return null; // a section that legitimately matches nothing stays silent
  return (
    <div className="card-grid">
      {rows.map((row) => {
        const title = publicEntityValue(row, titleField);
        const body = bodyField ? publicEntityValue(row, bodyField) : '';
        if (!title) return null;
        return (
          <article key={row.entityId} className="surface-card u-p-4 u-grid u-gap-2">
            <strong>{title}</strong>
            {body ? <p className="u-m-0 u-text-sm muted">{body}</p> : null}
          </article>
        );
      })}
    </div>
  );
}

/** One live entity for the entityDetail section (the entityList rules, one row). */
function EntityDetailSection({ tenantId, typeName, entityId, titleField, bodyField }: {
  tenantId: string; typeName: string; entityId: string; titleField: string; bodyField?: string | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('cms');
  const [row, setRow] = useState<PublicEntityRow | null | 'missing'>(null);
  // A failed read is NOT a missing entity (same separation as EntityListSection
  // above — this was the one sibling the sweep missed, SITE-R2-3): a 500 used to
  // silently delete a pinned case-study section from the page.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!tenantId || !typeName || !entityId) { setRow('missing'); return; }
    void fetch(`${config.baseUrl}/host/openwop-app/public-entities/${encodeURIComponent(tenantId)}/types/${encodeURIComponent(typeName)}/entities/${encodeURIComponent(entityId)}`, fetchOpts({}))
      .then(async (r) => {
        if (r.status === 404 || r.status === 410) return 'missing' as const;
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as PublicEntityRow;
      })
      .then((v) => { setError(false); setRow(v); })
      .catch(() => setError(true));
  }, [tenantId, typeName, entityId]);
  if (error) return <p className="fp-pricing__note">{t('sectionLoadError', { defaultValue: 'Couldn’t load this section.' })}</p>;
  if (row === null || row === 'missing') return null;
  const title = publicEntityValue(row, titleField);
  if (!title) return null;
  const body = bodyField ? publicEntityValue(row, bodyField) : '';
  return (
    <article className="surface-card u-p-4 u-grid u-gap-2">
      <strong>{title}</strong>
      {body ? <p className="u-m-0 muted">{body}</p> : null}
    </article>
  );
}

/** Live product refs for the productGrid section (one public read per page render). */
function ProductGridSection({ storeOrgId, productIds }: { storeOrgId: string; productIds: string[] }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const [products, setProducts] = useState<{ productId: string; name: string; description?: string; price: number; currency: string; imageAssetTokens: string[] }[] | null>(null);
  // See EntityListSection: an unreadable grid used to vanish, taking its Shop
  // CTAs with it — a revenue surface disappearing with nothing to notice.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!storeOrgId) { setProducts([]); return; }
    void fetch(`${config.baseUrl}/host/openwop-app/public-store/${encodeURIComponent(storeOrgId)}/products`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { products: { productId: string; name: string; description?: string; price: number; currency: string; imageAssetTokens: string[] }[] }; })
      .then((r) => { setError(false); setProducts((Array.isArray(r.products) ? r.products : []).filter((pp) => productIds.includes(pp.productId))); })
      .catch(() => { setError(true); setProducts([]); });
    // productIds is a fresh array per render — key on its content, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeOrgId, productIds.join(',')]);
  if (error) return <p className="fp-pricing__note">{t('productGridLoadError', { defaultValue: 'Couldn’t load these products.' })}</p>;
  if (!products || products.length === 0) return null; // a grid that legitimately matches nothing stays silent
  return (
    <div className="card-grid">
      {products.map((pp) => (
        <article key={pp.productId} className="surface-card u-p-4 u-grid u-gap-2">
          {pp.imageAssetTokens[0] ? <img src={assetUrl(pp.imageAssetTokens[0])} alt="" className="cms-hero-img" /> : null}
          <strong>{pp.name}</strong>
          {pp.description ? <p className="u-m-0 u-text-sm muted">{pp.description}</p> : null}
          <div className="action-bar u-justify-between u-items-center">
            <strong>{fmt.currency(pp.price, pp.currency)}</strong>
            <Link className="fp-btn fp-btn--primary" to={`/store/${encodeURIComponent(storeOrgId)}`}>{t('productGridShop', { defaultValue: 'Shop' })}</Link>
          </div>
        </article>
      ))}
    </div>
  );
}

/** The simple editor preview (markup kept rough — the public page is `.fp-*`). */
function EditorPreview({ section }: { section: Section }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  // ADR 1080 — a one-line summary for the design section types.
  if (isDesignSection(section.type)) return <span className="u-label-sm">{t(`sectionType_${section.type}`)}</span>;
  switch (section.type) {
    case 'hero':
      return (
        <div className="cms-hero-preview">
          {str(d.imageToken) ? <img src={assetUrl(str(d.imageToken))} alt="" className="cms-hero-img" /> : null}
          {str(d.eyebrow) ? <span className="u-label-sm">{str(d.eyebrow)}</span> : null}
          <strong className="cms-hero-heading"><HeadingText text={str(d.heading)} /></strong>
          {str(d.subheading) ? <span className="u-label-sm">{str(d.subheading)}</span> : null}
        </div>
      );
    case 'richText':
      return <RichText text={str(d.text)} />;
    case 'image':
      return str(d.token)
        ? <img src={assetUrl(str(d.token))} alt={str(d.alt)} className="cms-img" />
        : <span className="u-label-sm">{t('noImage')}</span>;
    case 'cta':
      return <span className="chip chip--accent">{stripHeadingEmphasis(str(d.heading)) || str(d.label)}</span>;
    case 'columns': {
      const cols: { title?: string; text?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      return (
        <div className="cms-columns" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, 1fr)` }}>
          {cols.map((c, i) => <div key={i} className="cms-column-cell">{str(c.title) ? <strong>{str(c.title)} · </strong> : null}{str(c.text)}</div>)}
        </div>
      );
    }
    case 'productGrid':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong><HeadingText text={str(d.heading)} /></strong> : null}
          <span className="u-label-sm">{t('productGridPreview', { defaultValue: '{{count}} product(s) from the storefront', count: Array.isArray(d.productIds) ? (d.productIds as unknown[]).length : 0 })}</span>
        </div>
      );
    case 'form':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong><HeadingText text={str(d.heading)} /></strong> : null}
          <span className="u-label-sm">{str(d.formId) ? t('formSectionPreview', { defaultValue: 'Form: {{id}}', id: str(d.formId) }) : t('formSectionEmpty', { defaultValue: 'No form selected' })}</span>
        </div>
      );
    case 'pricing':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong><HeadingText text={str(d.heading)} /></strong> : null}
          <span className="u-label-sm">{t('pricingSectionPreview', { defaultValue: 'Pricing tiers ({{n}})', n: Array.isArray(d.tiers) ? (d.tiers as unknown[]).length : 0 })}</span>
        </div>
      );
    case 'comparison':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong><HeadingText text={str(d.heading)} /></strong> : null}
          <span className="u-label-sm">{t('comparisonSectionPreview', {
            defaultValue: 'Comparison matrix ({{r}} rows × {{c}} columns)',
            r: Array.isArray(d.rows) ? (d.rows as unknown[]).length : 0,
            c: Array.isArray(d.columns) ? (d.columns as unknown[]).length : 0,
          })}</span>
        </div>
      );
    case 'video':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong><HeadingText text={str(d.heading)} /></strong> : null}
          {httpsOnly(d.poster) ? <img src={httpsOnly(d.poster)} alt="" className="cms-img" /> : null}
          <span className="u-label-sm">{str(d.title)
            ? t('videoSectionPreview', { title: str(d.title), length: str(d.length) || '—' })
            : t('videoSectionEmpty')}</span>
        </div>
      );
    case 'fields': {
      const keys = Object.keys(d);
      return (
        <div className="u-grid u-gap-1">
          {keys.length === 0
            ? <span className="u-label-sm">{t('fieldsEmpty')}</span>
            : <span className="u-label-sm">{keys.slice(0, 6).join(' · ')}{keys.length > 6 ? ' …' : ''}</span>}
        </div>
      );
    }
    default:
      return <span className="u-label-sm">{t('unknownSection')}</span>;
  }
}

/** Render one typed section in editor or public mode. */
export function RenderSection({ section, mode = 'editor' }: { section: Section; mode?: SectionRenderMode }): JSX.Element {
  return mode === 'public' ? <PublicSection section={section} /> : <EditorPreview section={section} />;
}

/** Render an ordered list of sections.
 *
 * `onEditSection` (CMS preview only — the live public page never passes it)
 * turns each section into a click-through target: a hover/focus-revealed
 * "Edit" affordance that jumps to that section's editor card (the Storyblok
 * block↔preview contract, adapted: the preview's own links/buttons keep
 * working, so the affordance is an overlay chip, not a whole-block hijack).
 * The wrapper div exists ONLY on this path — the public page's markup (and
 * its `.cms-public-page > .cms-public-section` stagger) is untouched. */
export function RenderSections({ sections, mode = 'editor', onEditSection, selectedSectionId }: {
  sections: Section[];
  mode?: SectionRenderMode;
  onEditSection?: (sectionId: string) => void;
  /** The page workspace's selected section, outlined on the page. */
  selectedSectionId?: string | null | undefined;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const list = Array.isArray(sections) ? sections : [];
  if (!onEditSection) return <>{list.map((s) => <RenderSection key={s.sectionId} section={s} mode={mode} />)}</>;
  return (
    <>
      {list.map((s) => (
        <div key={s.sectionId} className="cms-pv-section" data-section-id={s.sectionId} data-selected={s.sectionId === selectedSectionId ? 'true' : undefined}>
          <RenderSection section={s} mode={mode} />
          <Button
            variant="secondary"
            size="sm"
            className="cms-pv-edit"
            aria-label={t('editSectionAria', { type: t(`sectionType_${s.type}`, { defaultValue: s.type }) })}
            onClick={() => onEditSection(s.sectionId)}
          >
            <PencilIcon /> {t('editSectionAction')}
          </Button>
        </div>
      ))}
    </>
  );
}
