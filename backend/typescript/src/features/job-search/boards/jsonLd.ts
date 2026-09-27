/**
 * ADR 0542 D5 Tier 2 — extract `schema.org/JobPosting` JSON-LD from a career page.
 *
 * Tier 2 exists because most employers already publish their postings as
 * machine-readable first-party JSON to get Google for Jobs visibility. Reading
 * structured data that was published expressly to be read is a different act
 * from scraping, which is why this tier is in the product and Tier 4 is not.
 *
 * PURE: this module takes HTML text and returns postings. It performs no I/O, so
 * the parsing rules are testable without a network and the fetch policy lives in
 * exactly one place (`fetchListingPage`) rather than being duplicated per caller.
 *
 * ## Everything here is UNTRUSTED (D3)
 *
 * A posting is attacker-authored text that will reach a model holding tools and
 * credentials. This module therefore treats every extracted string as data: it
 * never evaluates, never follows a URL, and bounds what it will accept. The
 * `<UNTRUSTED>` fence is applied at model-message construction (RFC 0137 §F1),
 * not here — the same layering ADR 0547 D5 records for tool results.
 */

/** What we keep from a posting. Deliberately small: the fields Google for Jobs
 *  requires, which is exactly the set employers reliably publish. */
export interface JsonLdPosting {
  title: string;
  description: string;
  datePosted: string | null;
  hiringOrganization: string | null;
  jobLocation: string | null;
  employmentType: string | null;
  validThrough: string | null;
}

/** Hard caps. A career page is attacker-controlled, so every unbounded read here
 *  is a denial-of-service surface: one 200 MB "page" would take the process
 *  down for every tenant. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 20;
const MAX_POSTINGS = 200;
const MAX_FIELD_CHARS = 20_000;

const clip = (s: string): string => (s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s);

const asString = (v: unknown): string | null => {
  if (typeof v === 'string') return clip(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};

/** schema.org lets a field be an object, an array, or a bare string. Resolve the
 *  common shapes rather than demanding one — a strict reader would drop most
 *  real pages, and dropping a real job is the expensive failure here. */
function nameOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return clip(v);
  if (Array.isArray(v)) return v.length > 0 ? nameOf(v[0]) : null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const direct = asString(o.name);
    if (direct) return direct;
    // jobLocation → { address: { addressLocality, addressRegion } }
    const addr = o.address as Record<string, unknown> | undefined;
    if (addr) {
      const parts = [asString(addr.addressLocality), asString(addr.addressRegion), asString(addr.addressCountry)]
        .filter((x): x is string => Boolean(x));
      if (parts.length > 0) return parts.join(', ');
    }
  }
  return null;
}

/**
 * Pull every `<script type="application/ld+json">` block out of an HTML string.
 *
 * Regex rather than a DOM parse, deliberately: this input is hostile and
 * unbounded, and adding an HTML parser to handle it would be a much larger
 * attack surface than the one narrow pattern actually needed. The cap on block
 * count bounds the work regardless of what the page contains.
 */
function ldBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_BLOCKS) out.push(m[1] ?? '');
  return out;
}

/** Walk a parsed JSON-LD value, collecting every `JobPosting` node (they may be
 *  bare, in an array, or inside an `@graph`). */
function collectPostings(node: unknown, into: unknown[], depth = 0): void {
  if (depth > 6 || into.length >= MAX_POSTINGS || node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) collectPostings(n, into, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const type = o['@type'];
  const isPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
  if (isPosting) { into.push(o); return; }
  if (o['@graph']) collectPostings(o['@graph'], into, depth + 1);
}

/**
 * Extract postings from a career page.
 *
 * Never throws: a page with malformed JSON-LD yields the blocks that DID parse.
 * One bad block must not discard a page's other postings, and an exception here
 * would turn "this employer's markup is sloppy" into "the campaign stopped" —
 * the failure posture D3 rules out.
 */
export function extractJobPostings(html: string): JsonLdPosting[] {
  if (typeof html !== 'string' || html.length === 0) return [];
  const raw: unknown[] = [];
  for (const block of ldBlocks(html)) {
    try {
      collectPostings(JSON.parse(block), raw);
    } catch {
      // Malformed block — skip it, keep the rest. Deliberately silent: a career
      // page with one bad script tag is normal, not an incident.
    }
  }
  const out: JsonLdPosting[] = [];
  for (const p of raw.slice(0, MAX_POSTINGS)) {
    const o = p as Record<string, unknown>;
    const title = asString(o.title);
    if (!title) continue; // a posting with no title is not usable as a listing
    out.push({
      title,
      description: asString(o.description) ?? '',
      datePosted: asString(o.datePosted),
      hiringOrganization: nameOf(o.hiringOrganization),
      jobLocation: nameOf(o.jobLocation),
      employmentType: nameOf(o.employmentType),
      validThrough: asString(o.validThrough),
    });
  }
  return out;
}
