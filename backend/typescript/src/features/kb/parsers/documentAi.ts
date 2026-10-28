/**
 * ADR 0904 D6 / P6 (Track 2) — Document AI Layout Parser as an OPERATOR-opt-in parser
 * for PDF and PPTX, built INERT:
 *
 *  - OFF unless `OPENWOP_KB_DOCAI_PROCESSOR` names a Layout Parser processor
 *    (`projects/<p>/locations/<l>/processors/<id>`); the host refuses to boot with a
 *    malformed value or without a per-tenant daily page cap (`OPENWOP_KB_DOCAI_PAGES_PER_DAY`);
 *  - the cap is checked BEFORE the call with the file's real page count (pdf.js / the
 *    PPTX slide entries), and durably reserved by CAS before dispatch; uncertain
 *    attempts retain their reservation and concurrent uploads cannot overspend;
 *  - ONLINE processing only (≤ 15 pages). Larger files, a reached cap, or any failure
 *    fall back to the in-process parsers (P2). The batch path through GCS staging is
 *    NOT built yet (ADR 0904 P6, owed).
 *
 * The response's own `documentLayout` blocks (headings, paragraphs, lists, tables, each
 * with its page span) become the markdown the chunker already understands, with page
 * offsets — not MyndHyve's all-caps heading heuristic over flat paragraphs (wart 4).
 * Auth is the runtime service account through `gcpAdc.ts`; the call rides the guarded
 * egress fetch. Enabling it sends upload bytes to the operator's processor (its region).
 */
import { gcpMetadata, type GcpMetadataClient } from '../../../host/gcpAdc.js';
import { guardedEgressFetch } from '../../../host/webhookEgressGuard.js';
import { currentEffectContext, assertEffectAllowed } from '../../../host/runEffectContext.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';

export const DOCAI_ONLINE_PAGE_LIMIT = 15;
const PROCESSOR_RE = /^projects\/([A-Za-z0-9._-]+)\/locations\/([a-z0-9-]+)\/processors\/([A-Za-z0-9._-]+)$/;
const TIMEOUT_MS = 60_000;

export interface DocAiConfig { processor: string; location: string; pagesPerDay: number }

/** Parse the operator config; null when off. A malformed processor THROWS. */
export function parseDocAiConfig(env: NodeJS.ProcessEnv = process.env): DocAiConfig | null {
  const processor = env.OPENWOP_KB_DOCAI_PROCESSOR?.trim();
  if (!processor) return null;
  const m = PROCESSOR_RE.exec(processor);
  if (!m) throw new Error(`OPENWOP_KB_DOCAI_PROCESSOR='${processor}' is not projects/<project>/locations/<location>/processors/<id>.`);
  const n = Number(env.OPENWOP_KB_DOCAI_PAGES_PER_DAY);
  return { processor, location: m[2]!, pagesPerDay: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 };
}

/** Boot guard: a malformed processor, or a processor without a page cap, refuses boot. */
export function assertDocAiBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  const cfg = parseDocAiConfig(env);
  if (cfg && cfg.pagesPerDay <= 0) {
    throw new Error('OPENWOP_KB_DOCAI_PROCESSOR needs OPENWOP_KB_DOCAI_PAGES_PER_DAY (per-tenant pages per day) — refusing to boot with operator-funded parsing uncapped (ADR 0904 D6).');
  }
}

interface PageUsageRow { tenantId: string; dateUtc: string; pages: number }
const usage = new DurableCollection<PageUsageRow>('kb:docaiusage', (r) => `${r.tenantId}:${r.dateUtc}`);

/** Existing daily owner, reserved before dispatch. No refund for an uncertain
 * provider attempt, and no authorization from an unreadable or contended row. */
async function reservePages(tenantId: string, dateUtc: string, pages: number, cap: number): Promise<boolean> {
  if (currentEffectContext()?.replaying) {
    try { assertEffectAllowed('network-egress', 'Document AI parse paid attempt'); } catch { return false; }
  }
  const key = `${tenantId}:${dateUtc}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const prior = await usage.get(key); const used = prior?.pages ?? 0;
      if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(used + pages) || used + pages > cap) return false;
      if (await usage.compareAndSwap(prior, { tenantId, dateUtc, pages: used + pages })) return true;
    } catch { return false; }
  }
  return false;
}


// ── layout → markdown ──────────────────────────────────────────────────────

interface Block {
  pageSpan?: { pageStart?: number; pageEnd?: number };
  textBlock?: { text?: string; type?: string; blocks?: Block[] };
  listBlock?: { type?: string; listEntries?: Array<{ blocks?: Block[] }> };
  tableBlock?: { headerRows?: Row[]; bodyRows?: Row[] };
}
interface Row { cells?: Array<{ blocks?: Block[] }> }

const flatText = (blocks: Block[] | undefined): string =>
  (blocks ?? []).map((b) => [b.textBlock?.text ?? '', flatText(b.textBlock?.blocks)].join(' ')).join(' ').replace(/\s+/g, ' ').trim();

/** Map Layout Parser blocks to markdown + page offsets. Pure. */
export function layoutToMarkdown(blocks: readonly Block[]): { text: string; pageOffsets: number[] } {
  let text = '';
  const pageOffsets: number[] = [];
  const emit = (chunk: string, page: number | undefined): void => {
    const c = chunk.trim();
    if (!c) return;
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 0 || page > DOCAI_ONLINE_PAGE_LIMIT)) throw new Error('docai_invalid_page_span');
    if (page && page > pageOffsets.length) {
      const at = text.length === 0 ? 0 : text.length + 2;
      while (pageOffsets.length < page) pageOffsets.push(at);
    }
    text += (text.length > 0 ? '\n\n' : '') + c;
  };
  const walk = (list: readonly Block[]): void => {
    for (const b of list) {
      const page = b.pageSpan?.pageStart;
      if (b.textBlock) {
        const t = (b.textBlock.text ?? '').replace(/\s+/g, ' ').trim();
        const h = /^heading-([1-6])$/.exec(b.textBlock.type ?? '');
        if (t) emit(h ? `${'#'.repeat(Number(h[1]))} ${t}` : t, page);
        if (b.textBlock.blocks?.length) walk(b.textBlock.blocks);
      } else if (b.listBlock) {
        const ordered = b.listBlock.type === 'ordered';
        const items = (b.listBlock.listEntries ?? []).map((e, i) => `${ordered ? `${i + 1}.` : '-'} ${flatText(e.blocks)}`).filter((l) => l.length > 2);
        emit(items.join('\n'), page);
      } else if (b.tableBlock) {
        const rows = [...(b.tableBlock.headerRows ?? []), ...(b.tableBlock.bodyRows ?? [])]
          .map((r) => (r.cells ?? []).map((c) => flatText(c.blocks).replace(/\|/g, '\\|')));
        if (rows.length > 0) {
          const width = Math.max(...rows.map((r) => r.length));
          const fmt = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
          emit([fmt(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(fmt)].join('\n'), page);
        }
      }
    }
  };
  walk(blocks);
  return { text, pageOffsets };
}

// ── the call ───────────────────────────────────────────────────────────────

export interface DocAiDeps {
  metadata?: GcpMetadataClient;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
let testDeps: DocAiDeps | null = null;
/** Test seam — no processor in CI. */
export function __setDocAiDepsForTest(deps: DocAiDeps | null): void { testDeps = deps; }

export type DocAiOutcome =
  | { kind: 'parsed'; text: string; pageOffsets: number[] }
  | { kind: 'skipped'; reason: 'off' | 'too-many-pages' | 'cap-reached' | 'failed' | 'empty' };

/**
 * Parse with Document AI when it is configured AND the page count fits the online limit
 * AND the tenant's remaining daily pages. `pageCount` is the file's REAL page count,
 * read by the caller before anything is sent.
 */
export async function parseWithDocumentAi(
  tenantId: string, buffer: Buffer, mimeType: string, pageCount: number, depsIn: DocAiDeps = {},
): Promise<DocAiOutcome> {
  const deps = testDeps ? { ...testDeps, ...depsIn } : depsIn;
  const env = deps.env ?? process.env;
  let cfg: DocAiConfig | null;
  try { cfg = parseDocAiConfig(env); } catch { return { kind: 'skipped', reason: 'off' }; }
  if (!cfg || cfg.pagesPerDay <= 0 || !tenantId || tenantId.startsWith('anon:')) return { kind: 'skipped', reason: 'off' };
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0 || pageCount > DOCAI_ONLINE_PAGE_LIMIT) return { kind: 'skipped', reason: 'too-many-pages' };
  const dateUtc = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  try {
    const md = deps.metadata ?? gcpMetadata();
    const token = await md.accessToken();
    if (!await reservePages(tenantId, dateUtc, pageCount, cfg.pagesPerDay)) return { kind: 'skipped', reason: 'cap-reached' };
    const fetchImpl = deps.fetchImpl ?? ((u, init) => guardedEgressFetch(u, init));
    const res = await fetchImpl(`https://${cfg.location}-documentai.googleapis.com/v1/${cfg.processor}:process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ rawDocument: { content: buffer.toString('base64'), mimeType } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.text().catch(() => ''); // drain; never include document bytes in diagnostics
      if (res.status === 401 || res.status === 403) md.invalidate();
      return { kind: 'skipped', reason: 'failed' };
    }
    const body = JSON.parse(await res.text()) as { document?: { documentLayout?: { blocks?: Block[] } } };
    const out = layoutToMarkdown(body.document?.documentLayout?.blocks ?? []);
    if (out.pageOffsets.length > pageCount) return { kind: 'skipped', reason: 'failed' };
    return out.text.trim() ? { kind: 'parsed', ...out } : { kind: 'skipped', reason: 'empty' };
  } catch {
    return { kind: 'skipped', reason: 'failed' };
  }
}
