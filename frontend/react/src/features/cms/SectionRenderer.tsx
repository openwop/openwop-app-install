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
import { CtaLink, isInternal, isSafeHref } from './CtaLink.js';
import type { ReactNode } from 'react';
import { Fragment, Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import i18n from '../../i18n/index.js';
import type { Section } from './cmsClient.js';
import { assetUrl } from './cmsClient.js';
import { headingSlug } from './headingSlug.js';
import { HeadingText, stripHeadingEmphasis } from './headingEmphasis.js';
import { parseProseBlocks } from './proseBlocks.js';
import { ChatCard, PanelArt, PlanCard, ProgressBar, fraction, sectionStyleClass } from './sectionStyles.js';
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
};

/** A node-supplied string field, or '' when absent/non-string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

export type SectionRenderMode = 'editor' | 'public';



/** Inline markdown → React nodes: `**bold**`, `*italic*`, `` `code` ``,
 *  `[label](url)`. No raw HTML; an unsafe link degrades to plain text. */
function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={key} className="fp-code">{m[3]}</code>);
    else if (m[4] !== undefined && m[5] !== undefined) {
      const label = m[4]; const url = m[5];
      out.push(isSafeHref(url)
        ? <a key={key} href={url} rel="noopener noreferrer">{label}</a>
        : isInternal(url) ? <Link key={key} to={url}>{label}</Link> : label);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render `text` as prose blocks (paragraphs, `###` subheadings, lists,
 *  quotes), inline-formatted. Still no raw HTML. */
function RichText({ text, className = 'cms-richtext' }: { text: string; className?: string }): JSX.Element {
  const blocks = parseProseBlocks(text);
  if (blocks.length === 0) return <p className={className} />;
  return <>{blocks.map((b, i) => {
    const k = `b${i}`;
    switch (b.kind) {
      case 'h3': return <h3 key={k} className="cms-prose-h3">{inlineMarkdown(b.text, k)}</h3>;
      case 'ul': return <ul key={k} className="cms-prose-list">{b.items.map((it, j) => <li key={j}>{inlineMarkdown(it, `${k}-${j}`)}</li>)}</ul>;
      case 'ol': return <ol key={k} className="cms-prose-list">{b.items.map((it, j) => <li key={j}>{inlineMarkdown(it, `${k}-${j}`)}</li>)}</ol>;
      case 'quote': return <blockquote key={k} className="cms-prose-quote">{inlineMarkdown(b.text, k)}</blockquote>;
      default: return <p key={k} className={className}>{inlineMarkdown(b.text, k)}</p>;
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

/** A card's glyph: the per-feature icon for a known `icon` slug, else the node
 *  motif. Same `.fp-glyph` chrome either way so the grid stays visually even. */
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
 * A deliberately illustrative, not-live, product vignette for the public hero.
 * The old outline-only diagram told the visitor that this was "technical," but
 * gave no sense of what the product helps them do. This keeps the node motif
 * while showing the simple arc OpenWOP is built for: shape work, run it, retain
 * a reviewable record. It is aria-hidden because the authored hero copy carries
 * the actual product claim.
 */
function HeroSchematic(): JSX.Element {
  return (
    <div className="fp-hero__product" aria-hidden="true">
      <div className="fp-product">
        <div className="fp-product__bar">
          <span className="fp-product__brand"><span className="fp-product__brand-mark" /> {i18n.t('site:heroVignetteName')}</span>
          <span className="fp-product__state">{i18n.t('site:heroVignetteReady')}</span>
        </div>
        <div className="fp-product__canvas">
          <div className="fp-product__node fp-product__node--brief">
            <span className="fp-product__node-kicker">{i18n.t('site:heroVignetteContext')}</span>
            <strong>{i18n.t('site:heroVignetteBrief')}</strong>
            <span>{i18n.t('site:heroVignetteCapture')}</span>
          </div>
          <span className="fp-product__wire fp-product__wire--one" />
          <div className="fp-product__node fp-product__node--route">
            <span className="fp-product__node-kicker">{i18n.t('site:heroVignetteWorkflow')}</span>
            <strong>{i18n.t('site:heroVignetteRoute')}</strong>
            <span>{i18n.t('site:heroVignetteTogether')}</span>
          </div>
          <span className="fp-product__wire fp-product__wire--two" />
          <div className="fp-product__node fp-product__node--review">
            <span className="fp-product__node-kicker">{i18n.t('site:heroVignetteRecord')}</span>
            <strong>{i18n.t('site:heroVignetteReview')}</strong>
            <span>{i18n.t('site:heroVignetteReplay')}</span>
          </div>
        </div>
        <div className="fp-product__footer">
          <span>{i18n.t('site:heroVignetteOpen')}</span>
          <span className="fp-product__footer-dot" />
          <span>{i18n.t('site:heroVignetteInfrastructure')}</span>
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
  return (
    <div className="fp-run" aria-hidden="true">
      <div className="fp-run__bar">
        <span className="fp-run__id"><span className="fp-run__mark" />{i18n.t('site:heroRunName')}</span>
        <span>{i18n.t('site:heroRunLog')}</span>
      </div>
      <ol className="fp-run__list">
        {RUN_LEDGER.map((row) => (
          <li key={row.event} className={row.waits ? 'fp-run__row fp-run__row--waits' : 'fp-run__row'}>
            <span className="fp-run__at">{row.at}</span>
            <span className="fp-run__event">{row.event}</span>
            <span className="fp-run__gloss">
              {i18n.t(row.gloss)}
              {row.waits ? <span className="fp-run__waits">{i18n.t('site:heroRunWaiting')}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div className="fp-run__foot">{i18n.t('site:heroRunFooter')}</div>
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
function FilmPlayer({ src, poster, captions, length, caption, description, captionExtra }: {
  src: string;
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
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const captionId = useId();
  const descId = useId();
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
    <figure className="fp-film">
      <div className="fp-film__frame">
        <video
          ref={ref}
          className="fp-film__video"
          src={src}
          poster={poster}
          preload="none"
          playsInline
          controls={started}
          width={1920}
          height={1080}
          crossOrigin="anonymous"
          aria-describedby={describedBy}
          onPlay={() => { setStarted(true); setPlaying(true); }}
          onEnded={() => setPlaying(false)}
        >
          {captions ? <track kind="captions" srcLang="en" label={i18n.t('site:filmCaptionsLabel')} src={captions} /> : null}
        </video>
        {/* Faded out, the button also leaves the tab order and the a11y tree,
            so it is never an invisible, focusable control. */}
        <button
          type="button"
          className={playing ? 'fp-film__play fp-film__play--faded' : 'fp-film__play'}
          onClick={start}
          aria-hidden={playing}
          tabIndex={playing ? -1 : 0}
        >
          <PlayIcon size={18} />
          <span>{i18n.t('site:filmPlay')}</span>
          {length ? <span className="fp-film__len">{length}</span> : null}
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
  return (
    <FilmPlayer
      src={FILM.src}
      poster={FILM.poster}
      captions={FILM.captions}
      length={i18n.t('site:filmLength')}
      caption={i18n.t('site:filmCaption')}
    />
  );
}

/** ADR 0843 — a CMS `video` section: an optional section head, then the film.
 *  URLs were https-checked on save; re-checked here so a row that reached
 *  storage another way never loads a non-https source. The visible caption is
 *  the title (+ a YouTube link); the long description is screen-reader only. */
const httpsOnly = (v: unknown): string => (/^https:\/\//i.test(str(v).trim()) ? str(v).trim() : '');
function VideoSection({ d, eyebrow, heading, sx = '' }: { d: Record<string, unknown>; eyebrow?: string | undefined; heading?: string | undefined; sx?: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const src = httpsOnly(d.src);
  const poster = httpsOnly(d.poster);
  const youtube = httpsOnly(d.youtubeUrl);
  const title = str(d.title);
  return (
    <section className={`cms-public-section fp-section${sx}`}>
      <div className="fp-shell">
        <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
        {src && poster ? (
          <FilmPlayer
            src={src}
            poster={poster}
            captions={httpsOnly(d.captions) || undefined}
            length={str(d.length) || undefined}
            description={str(d.description) || undefined}
            caption={title ? <span className="fp-film__title">{title}</span> : null}
            captionExtra={youtube ? (
              <>
                {title ? <span aria-hidden="true"> · </span> : null}
                <a href={youtube} target="_blank" rel="noopener noreferrer">{t('videoWatchOnYouTube')} <ArrowUpRightIcon size={14} /></a>
              </>
            ) : null}
          />
        ) : null}
      </div>
    </section>
  );
}

function RunHero({ copy }: { copy: ReactNode }): JSX.Element {
  return (
    <section className="cms-public-section fp-hero fp-hero--run">
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
function FilmOrRunHero({ copy }: { copy: ReactNode }): JSX.Element {
  const demo = useDemoMode();
  if (!demo) return <RunHero copy={copy} />;
  return (
    <section className="cms-public-section fp-hero fp-hero--film">
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
  if (kind === 'canvas') {
    const steps = ['site:diveCanvasTrigger', 'site:diveCanvasAgent', 'site:diveCanvasApproval', 'site:diveCanvasAction'];
    return (
      <div className="fp-dive__art fp-dive__art--canvas" aria-hidden="true">
        <p className="fp-dive__meta"><span>{i18n.t('site:diveCanvasName')}</span><span>{i18n.t('site:diveCanvasDraft')}</span></p>
        <ol className="fp-dive__nodes">
          {steps.map((k, i) => (
            <li key={k} className={i === 2 ? 'fp-dive__node fp-dive__node--waits' : 'fp-dive__node'}>
              <span className="fp-dive__node-num">{pad2(i + 1)}</span>{i18n.t(k)}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (kind === 'ledger') {
    return (
      <div className="fp-dive__art fp-dive__art--ledger" aria-hidden="true">
        <p className="fp-dive__meta"><span>{i18n.t('site:heroRunName')}</span><span>{i18n.t('site:diveLedgerLive')}</span></p>
        <ol className="fp-run__list">
          {RUN_LEDGER.slice(0, 4).map((row) => (
            <li key={row.event} className="fp-run__row">
              <span className="fp-run__at">{row.at}</span>
              <span className="fp-run__event">{row.event}</span>
              <span className="fp-run__gloss">{i18n.t(row.gloss)}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (kind === 'approval') {
    return (
      <div className="fp-dive__art fp-dive__art--approval" aria-hidden="true">
        <p className="fp-dive__meta"><span>approval.requested</span><span>{i18n.t('site:heroRunWaiting')}</span></p>
        <p className="fp-dive__ask">{i18n.t('site:diveApprovalTitle')}</p>
        <p className="fp-dive__body">{i18n.t('site:diveApprovalBody')}</p>
        <p className="fp-dive__actions">
          <span className="fp-btn fp-btn--primary">{i18n.t('site:diveApprove')}</span>
          <span className="fp-btn fp-btn--ghost">{i18n.t('site:diveDecline')}</span>
        </p>
      </div>
    );
  }
  if (kind === 'fork') {
    return (
      <div className="fp-dive__art fp-dive__art--fork" aria-hidden="true">
        <p className="fp-dive__meta"><span>{i18n.t('site:diveForkName')}</span><span>{i18n.t('site:diveForkFrom')}</span></p>
        <ol className="fp-dive__fork">
          <li className="fp-dive__fork-row fp-dive__fork-row--reused"><span>1–3</span><span>{i18n.t('site:diveForkReused')}</span></li>
          <li className="fp-dive__fork-row"><span>4</span><span>agent.decided · {i18n.t('site:diveForkNew')}</span></li>
          <li className="fp-dive__fork-row fp-dive__fork-row--held"><span>5</span><span>send-email · {i18n.t('site:diveForkHeld')}</span></li>
        </ol>
        <p className="fp-dive__note">{i18n.t('site:diveIllustrative')}</p>
      </div>
    );
  }
  return null;
}

type HeroVisual = 'workflow' | 'journey' | 'run' | 'film' | 'image' | 'plan' | 'none';

function resolveHeroVisual(d: Record<string, unknown>): HeroVisual {
  const authored = str(d.visual);
  if (authored === 'workflow' || authored === 'journey' || authored === 'run' || authored === 'film' || authored === 'image' || authored === 'plan' || authored === 'none') return authored;
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
    return token ? <img className="fp-hero__image" src={assetUrl(token)} alt={str(d.alt)} /> : null;
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

/** Render one section's PUBLIC (front-page) markup. */
function PublicSection({ section }: { section: Section }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  const eyebrow = str(d.eyebrow) || undefined;
  const heading = str(d.heading) || undefined;
  // ADR 0920 D1/D2 — tone + split head modifiers ('' when the section sets neither).
  const sx = sectionStyleClass(d);

  switch (section.type) {
    case 'hero': {
      const visual = resolveHeroVisual(d);
      const copy = (
        <>
          {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
          <h1 className="fp-hero__title"><HeadingText text={str(d.heading)} /></h1>
          {str(d.subheading) ? <p className="fp-hero__lede">{inlineMarkdown(str(d.subheading), 'hl')}</p> : null}
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
      if (visual === 'film') return <FilmOrRunHero copy={copy} />;
      if (visual === 'run') return <RunHero copy={copy} />;
      // ADR 0920 D3 — the example plan sits IN the grid beside the copy (the
      // run-ledger model), and under it on a phone.
      if (visual === 'plan') {
        return (
          <section className="cms-public-section fp-hero fp-hero--plan">
            <div className="fp-shell fp-hero__grid">
              <div className="fp-hero__copy">{copy}</div>
              <PlanCard plan={d.plan} />
            </div>
          </section>
        );
      }
      // The journey follows the copy in the DOM so a phone can show it UNDER the
      // copy; on a wide screen it is absolutely placed either way.
      return (
        <section className={`cms-public-section fp-hero fp-hero--${visual}`}>
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
          <section className={`cms-public-section fp-section fp-prose fp-prose--visual${sx}`}>
            <div className="fp-shell fp-prose__split">
              <div className="fp-prose__copy">
                <SectionHead eyebrow={eyebrow} heading={heading} />
                <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" /></div>
              </div>
              <ChatCard chat={d.chat} />
            </div>
          </section>
        );
      }
      return (
        <section className={`cms-public-section fp-section fp-prose${sx}`}>
          <div className="fp-shell fp-shell--narrow">
            <SectionHead eyebrow={eyebrow} heading={heading} />
            <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" /></div>
          </div>
        </section>
      );

    case 'image':
      return (
        <section className="cms-public-section fp-section fp-figure">
          <div className="fp-shell">
            {str(d.token) ? <img className="fp-figure__img" src={assetUrl(str(d.token))} alt={str(d.alt)} /> : null}
            {str(d.caption) ? <p className="fp-figure__cap">{str(d.caption)}</p> : null}
          </div>
        </section>
      );

    case 'cta':
      return (
        <section className={`cms-public-section fp-section fp-cta${d.align === 'start' ? ' fp-cta--start' : ''}${sx}`}>
          <div className="fp-shell fp-cta__inner">
            {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
            {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-cta__title"><HeadingText text={heading} /></h2> : null}
            {str(d.subheading) ? <p className="fp-cta__lede">{str(d.subheading)}</p> : null}
            <div className="fp-cta__actions"><CtaLink label={str(d.label)} url={str(d.url)} primary /></div>
          </div>
        </section>
      );

    case 'columns': {
      const cols: {
        title?: string; text?: string; href?: string; icon?: string; optional?: boolean;
        // ADR 0920 D4 item fields.
        eyebrow?: string; progress?: number; badge?: string; future?: boolean; art?: string;
        items?: { label?: string; meta?: string }[];
      }[] = Array.isArray(d.columns) ? d.columns : [];
      const layout = str(d.layout) || 'cards';
      // ADR 0920 D4 — an optional footnote under the grid.
      const note = str(d.note) ? <p className="fp-cols__note">{str(d.note)}</p> : null;

      if (layout === 'ruled' || layout === 'panels' || layout === 'progress' || layout === 'tiles') {
        // Four parallel layouts that differ only in chrome (see global.css):
        // ruled = a hairline over each column; panels = filled, with a small
        // drawing; progress = a label line + bar; tiles = compact cards, four
        // across, a badge, and a dashed `future` card.
        return (
          <section className={`cms-public-section fp-section fp-cols fp-cols--${layout}${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className="fp-cols__grid">
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
        return (
          <section className={`cms-public-section fp-section fp-cols fp-cols--list${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <div className="fp-cols__grid">
                {cols.map((c, i) => (
                  <div key={i} className="fp-col">
                    {str(c.title) ? <h3 className="fp-col__title">{str(c.title)}</h3> : null}
                    <ul className="fp-col__items">
                      {(Array.isArray(c.items) ? c.items : []).filter((it) => str(it?.label)).map((it, j) => (
                        <li key={j} className="fp-col__item">
                          <span>{str(it.label)}</span>
                          {str(it.meta) ? <span className="fp-col__meta">{str(it.meta)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              {note}
            </div>
          </section>
        );
      }

      if (layout === 'stats') {
        // ADR 0762 — a heading/lede above the figures (optional: a bare stats
        // band still renders exactly as before).
        return (
          <section className={`cms-public-section fp-section fp-stats${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <dl className="fp-stats__grid">
                {cols.map((c, i) => (
                  <div key={i} className="fp-stat">
                    <dt className="fp-stat__value">{str(c.title)}</dt>
                    <dd className="fp-stat__label">{str(c.text)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        );
      }
      if (layout === 'rows') {
        // Statement rows: a short claim set large on the left, the plain
        // explanation on the right, one hairline between each. For a set of
        // parallel promises — no numbering (they are not a sequence) and no
        // card chrome (they are one argument, not a menu).
        return (
          <section className={`cms-public-section fp-section fp-rows${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className="fp-rows__list">
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
      if (layout === 'steps') {
        return (
          <section className={`cms-public-section fp-section fp-steps${d.numbers === 'circle' ? ' fp-steps--circle' : ''}${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} />
              <ol className="fp-steps__list">
                {cols.map((c, i) => (
                  <li key={i} className="fp-step">
                    <span className="fp-step__num">{d.numbers === 'circle' ? i + 1 : pad2(i + 1)}</span>
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
          <section className={`cms-public-section fp-section fp-prompts${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className="fp-prompts__grid">
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
          <section className={`cms-public-section fp-section fp-dives${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ol className="fp-dives__list">
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
          <section className={`cms-public-section fp-section fp-showcase${sx}`}>
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <div className="fp-showcase__grid">
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
        <section className={`cms-public-section fp-section fp-cards${sx}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-cards__grid">
              {cols.map((c, i) => {
                const cardInner = (
                  <>
                    <CardGlyph icon={c.icon} i={i} />
                    {str(c.title) ? <h3 className="fp-card__title">{str(c.title)}</h3> : null}
                    {c.optional ? <span className="fp-card__badge">{t('optionalBadge')}</span> : null}
                    <p className="fp-card__text">{inlineMarkdown(str(c.text), `card-${i}`)}</p>
                  </>
                );
                const href = str(c.href);
                // Whole-card link: ONE anchor per card (no nested links — card text
                // carries no inline link when href is set). Keyboard + semantics free.
                if (href && isInternal(href)) return <Link key={i} to={href} className="fp-card fp-card--link">{cardInner}</Link>;
                if (href && isSafeHref(href)) return <a key={i} href={href} className="fp-card fp-card--link" rel="noopener noreferrer">{cardInner}</a>;
                return <article key={i} className="fp-card">{cardInner}</article>;
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
        <section className="cms-public-section">
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
        <section className="cms-public-section fp-section fp-pricing">
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
      if (!formId) return <section className="cms-public-section" />;
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 id={headingSlug(stripHeadingEmphasis(heading))} className="fp-h2"><HeadingText text={heading} /></h2> : null}
            <Suspense fallback={<div className="u-p-2" role="status"><Skeleton /></div>}>
              <LazyPublicFormRenderer formId={formId} hideTitle={Boolean(heading)} />
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
        <section className="cms-public-section">
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
        <section className="cms-public-section">
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
      if (columns.length === 0 || rows.length === 0) return <section className="cms-public-section" />;
      const highlight = typeof d.highlightColumn === 'number' ? d.highlightColumn : -1;
      const legend = str(d.legend);
      const note = str(d.note);
      return (
        <section className="cms-public-section fp-section fp-matrix">
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

    case 'faq': {
      // R2-G10 — authored Q/A on native <details>/<summary>: keyboard + SR
      // support for free, no JS state, and the prerender emits FAQPage JSON-LD
      // from the same validated data.
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((it) => ({ q: str((it as { q?: unknown }).q), a: str((it as { a?: unknown }).a) }))
        .filter((it) => it.q && it.a);
      if (items.length === 0) return <section className="cms-public-section" />;
      return (
        <section className={`cms-public-section${sx ? ` fp-section fp-faq-section${sx}` : ''}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-faq">
              {items.map((it, i) => (
                <details key={i} className="fp-faq__item">
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
      if (rows.length === 0) return <section className="cms-public-section" />;
      return (
        <section className="cms-public-section">
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
      return <VideoSection d={d} eyebrow={eyebrow} heading={heading} sx={sx} />;

    case 'quotes': {
      // R2-G10 — attributed social proof. Real <figure>/<blockquote> semantics;
      // an unattributed quote renders with no byline — never an invented one.
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((it) => {
          const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
          return { quote: str(ii.quote), name: str(ii.name), role: str(ii.role) };
        })
        .filter((it) => it.quote);
      if (items.length === 0) return <section className="cms-public-section" />;
      return (
        <section className={`cms-public-section${sx ? ` fp-section${sx}` : ''}`}>
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-quotes">
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
      return <section className="cms-public-section" />;
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
