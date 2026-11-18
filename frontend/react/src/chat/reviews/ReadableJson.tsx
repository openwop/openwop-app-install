/**
 * ReadableJson — the shared READ-ONLY view for JSON artifact content that has no
 * typed renderer (P9, 2026-10-28). Before this, untyped JSON fell through to
 * Markdown, so an approver at the Challenge Factory outline gate and the run's
 * final result saw a raw `{ … }` dump.
 *
 * Inert by construction: every value renders as React text (escaped), nothing is
 * interpreted as HTML, a link, a URL to load or an action to run. Every field is
 * shown — nothing is hidden for being unknown — and what is cut for size says
 * so and points at the Raw view. It never claims a type check passed: a saved
 * envelope whose payload LOOKS like a known type is shown in that type's layout
 * under a note saying it was saved as plain data.
 *
 * Used by `AssetPreview` (approval card inline + full preview) and the
 * Workbench's untyped fallback, so all three read the same way.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getReviewArtifactMatch } from './reviewArtifactRenderers.js';

/** Nesting deeper than this renders as compact JSON text. */
const MAX_DEPTH = 8;
/** Items shown per object/array before the "N more" line. */
const MAX_ITEMS = 100;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The content as a JSON object or array, or null when it is not one (the
 *  caller keeps its text path for strings, Markdown and malformed JSON). */
export function parseJsonContent(content: string | undefined): Json[] | { [k: string]: Json } | null {
  const t = content?.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    const v = JSON.parse(t) as Json;
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** `approvalId` → "Approval id", `due_date` → "Due date". The label only; the
 *  stored key is kept on the row as its tooltip. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : key;
}

/** States of an approval request that still wait on a reviewer. Anything else
 *  is quoted as stored, so a submitted request is never shown as published. */
const AWAITING_STATES = new Set(['submitted', 'pending', 'open', 'in-review', 'in_review', 'awaiting-review']);

function isRecord(v: Json | undefined): v is { [k: string]: Json } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function Scalar({ value }: { value: null | boolean | number | string }): JSX.Element {
  if (value === null) return <span className="u-text-muted">—</span>;
  if (typeof value === 'string') return <span className="readable-json__text">{value}</span>;
  return <span className="u-mono">{String(value)}</span>;
}

function More({ hidden }: { hidden: number }): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (hidden <= 0) return null;
  return <p className="u-fs-12 u-text-muted u-m-0">{t('readableJsonMore', { count: hidden })}</p>;
}

function Value({ value, depth }: { value: Json; depth: number }): JSX.Element {
  if (value === null || typeof value !== 'object') return <Scalar value={value} />;
  if (depth >= MAX_DEPTH) return <code className="readable-json__deep">{JSON.stringify(value)}</code>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="u-text-muted">—</span>;
    const shown = value.slice(0, MAX_ITEMS);
    return (
      <>
        <ol className="readable-json__list">
          {shown.map((item, i) => <li key={i}><Value value={item} depth={depth + 1} /></li>)}
        </ol>
        <More hidden={value.length - shown.length} />
      </>
    );
  }
  return <Fields value={value} depth={depth + 1} />;
}

function Fields({ value, depth }: { value: { [k: string]: Json }; depth: number }): JSX.Element {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="u-text-muted">—</span>;
  const shown = entries.slice(0, MAX_ITEMS);
  return (
    <>
      <dl className="readable-json">
        {shown.map(([k, v]) => (
          <div key={k} className="readable-json__row">
            <dt title={k}>{humanizeKey(k)}</dt>
            <dd><Value value={v} depth={depth} /></dd>
          </div>
        ))}
      </dl>
      <More hidden={entries.length - shown.length} />
    </>
  );
}

/** A top-level approval-request result (`{approvalId, state}`), named for what
 *  it is: a request waiting on review, not a finished outcome. */
function ApprovalStatus({ value }: { value: { [k: string]: Json } }): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (typeof value.approvalId !== 'string' || typeof value.state !== 'string') return null;
  const state = value.state;
  return (
    <p className="readable-json__status u-fs-13 u-m-0" role="status">
      {AWAITING_STATES.has(state) ? t('readableJsonAwaitingReview') : t('readableJsonApprovalState', { state })}
    </p>
  );
}

/** Issue 5844 — markdown in a reviewed value renders as formatted text, and stays inert:
 *  no raw HTML (react-markdown renders none without rehype-raw), a link is shown as its
 *  text and URL rather than as a link, and an image as its alt text, so nothing in a
 *  value can load a URL in front of an approver. */
const INERT_MD: Components = {
  a: ({ children, href }) => <span className="readable-json__link">{children}{href ? ` (${href})` : null}</span>,
  img: ({ alt }) => <span className="u-text-muted">{alt ? `[${alt}]` : null}</span>,
};

/** A string the card renders as markdown: a field named `markdown`, or multi-line text
 *  that uses markdown structure (a heading, a list, emphasis). Plain multi-line text
 *  keeps the text path, so its line breaks are not reflowed. */
function isMarkdownField(key: string, v: Json | undefined): v is string {
  if (typeof v !== 'string' || !v.trim()) return false;
  if (/^(markdown|md)$/i.test(key)) return true;
  return v.includes('\n') && /^(#{1,6} |\s*[-*] |\s*\d+\. )|\*\*[^*]+\*\*/m.test(v);
}

/** Issue 5844 — checksums and record keys say nothing to a person deciding. They leave
 *  the face of the card and stay under "All saved fields", so nothing is hidden. */
function isMachineField(key: string, v: Json | undefined): boolean {
  if (/(hash|checksum|digest|recordkey)$/i.test(key)) return true;
  return typeof v === 'string' && (/^[0-9a-f]{32,}$/i.test(v) || /^sha(1|256|512):[0-9a-f]+$/i.test(v));
}

/** The plain read-only view of a JSON value. */
export function ReadableJson({ value }: { value: Json[] | { [k: string]: Json } }): JSX.Element {
  const { t } = useTranslation('chat');
  // Issue 5844 — a single wrapper key (`{ artifact: { … } }`, the shape an approval gate
  // bundles) is not a row of its own: the card shows what it wraps.
  const inner = isRecord(value) && Object.keys(value).length === 1 && isRecord(Object.values(value)[0]) ? Object.values(value)[0] as { [k: string]: Json } : value;
  if (!isRecord(inner)) {
    return (
      <div className="readable-json-root u-flex u-flex-col u-gap-2">
        <Value value={inner} depth={0} />
      </div>
    );
  }
  const entries = Object.entries(inner);
  const prose = entries.filter(([k, v]) => isMarkdownField(k, v)) as Array<[string, string]>;
  const machine = entries.filter(([k, v]) => !isMarkdownField(k, v) && isMachineField(k, v));
  const rest = Object.fromEntries(entries.filter(([k, v]) => !isMarkdownField(k, v) && !isMachineField(k, v)));
  // Only when something moved off the face does the card also offer every saved field.
  const tidied = prose.length > 0 || machine.length > 0;
  return (
    <div className="readable-json-root u-flex u-flex-col u-gap-2">
      <ApprovalStatus value={inner} />
      {prose.map(([k, text]) => (
        <div key={k} className="readable-json__prose">
          {prose.length > 1 || !/^(markdown|md)$/i.test(k) ? <p className="u-fs-12 u-text-muted u-m-0" title={k}>{humanizeKey(k)}</p> : null}
          <div className="chat-md mdview-root"><ReactMarkdown remarkPlugins={[remarkGfm]} components={INERT_MD}>{text}</ReactMarkdown></div>
        </div>
      ))}
      {Object.keys(rest).length > 0 || !tidied ? <Value value={tidied ? rest : inner} depth={0} /> : null}
      {tidied ? (
        <details className="u-fs-12">
          <summary className="u-text-muted">{t('readableJsonAllFields')}</summary>
          <Value value={value} depth={0} />
        </details>
      ) : null}
    </div>
  );
}

/** A saved `{ artifact: { artifactTypeId, payload } }` envelope whose payload
 *  matches a type's review layout. Only a registered matcher can say so. */
function matchEnvelope(value: Json[] | { [k: string]: Json }): { artifactTypeId: string; payload: string } | null {
  if (!isRecord(value) || !isRecord(value.artifact)) return null;
  const { artifactTypeId, payload } = value.artifact;
  if (typeof artifactTypeId !== 'string' || payload === null || typeof payload !== 'object') return null;
  const content = JSON.stringify(payload);
  return getReviewArtifactMatch(artifactTypeId, content) ? { artifactTypeId, payload: content } : null;
}

/** The readable view for untyped JSON content, or null when the content is not
 *  a JSON object/array (the caller then keeps its text/Markdown path). */
export function ReadableJsonContent({ content, label }: { content: string; label?: string }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const value = useMemo(() => parseJsonContent(content), [content]);
  const envelope = useMemo(() => (value ? matchEnvelope(value) : null), [value]);
  if (!value) return null;
  if (envelope) {
    const Typed = getReviewArtifactMatch(envelope.artifactTypeId, envelope.payload)!;
    return (
      <div className="u-flex u-flex-col u-gap-2">
        <p className="u-fs-12 u-text-muted u-m-0">{t('readableJsonUnverifiedNote')}</p>
        <Typed asset={{ content: envelope.payload, artifactTypeId: envelope.artifactTypeId, ...(label ? { label } : {}) }} />
        <details className="u-fs-12">
          <summary className="u-text-muted">{t('readableJsonAllFields')}</summary>
          <ReadableJson value={value} />
        </details>
      </div>
    );
  }
  return <ReadableJson value={value} />;
}
