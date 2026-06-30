/**
 * Dependency-free text + JSON diff (ADR 0069 §Phase 4).
 *
 * The artifact workbench compares two IMMUTABLE artifact revisions. No diff
 * utility existed in the app (only run-event diffing in runs.ts), and adding a
 * third-party diff dep is unjustified for line/structural diffs, so this is a
 * small hand-rolled LCS line-diff (text/markdown) plus a recursive key/value
 * diff (JSON). Computed server-side so the comparison is consistent and
 * auditable; the frontend only renders the result.
 *
 * @see docs/adr/0069-chat-artifact-workbench.md
 */

export type LineOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: LineOp;
  /** 1-based line number in the 'from' text (absent for an added line). */
  fromLine?: number;
  /** 1-based line number in the 'to' text (absent for a removed line). */
  toLine?: number;
  text: string;
}

export interface TextDiff {
  format: 'text';
  lines: DiffLine[];
  added: number;
  removed: number;
}

/**
 * Line-level diff via the classic LCS dynamic program. O(n·m) over line counts
 * — fine for documents (markdown bodies, not gigabyte logs). Returns the unified
 * line sequence with per-line op + original line numbers.
 */
export function diffText(from: string, to: string): TextDiff {
  const a = from.split('\n');
  const b = to.split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ op: 'equal', fromLine: i + 1, toLine: j + 1, text: a[i]! });
      i += 1; j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ op: 'remove', fromLine: i + 1, text: a[i]! });
      removed += 1; i += 1;
    } else {
      lines.push({ op: 'add', toLine: j + 1, text: b[j]! });
      added += 1; j += 1;
    }
  }
  while (i < n) { lines.push({ op: 'remove', fromLine: i + 1, text: a[i]! }); removed += 1; i += 1; }
  while (j < m) { lines.push({ op: 'add', toLine: j + 1, text: b[j]! }); added += 1; j += 1; }
  return { format: 'text', lines, added, removed };
}

export type JsonOp = 'add' | 'remove' | 'change';

export interface JsonDiffEntry {
  /** Dotted path to the changed leaf, e.g. `items.0.title`. */
  path: string;
  op: JsonOp;
  before?: unknown;
  after?: unknown;
}

export interface JsonDiff {
  format: 'json';
  changes: JsonDiffEntry[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive structural diff of two JSON values. Scalars + arrays compare by
 *  deep-equality (arrays as a whole, to keep paths stable); objects recurse. */
export function diffJson(from: unknown, to: unknown): JsonDiff {
  const changes: JsonDiffEntry[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (isObject(a) && isObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const childPath = path ? `${path}.${k}` : k;
        if (!(k in a)) changes.push({ path: childPath, op: 'add', after: b[k] });
        else if (!(k in b)) changes.push({ path: childPath, op: 'remove', before: a[k] });
        else walk(a[k], b[k], childPath);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ path: path || '(root)', op: 'change', before: a, after: b });
    }
  };
  walk(from, to, '');
  return { format: 'json', changes };
}
