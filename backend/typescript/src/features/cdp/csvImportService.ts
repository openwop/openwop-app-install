/**
 * CDP-G batch/CSV import (ADR 0298) — an operator-facing CSV ingest that RIDES the
 * existing `collectEventBatch` path (schema validation + ingest-time PII tagging +
 * per-row outcome are reused verbatim, never reimplemented). This module owns ONLY
 * (a) a pure, dependency-free RFC-4180-ish CSV parser and (b) the mapping of parsed
 * rows → `{ eventType, payload }` events + chunking into ≤100-row batches for the
 * single owner `collectService.collectEventBatch`.
 *
 * Fail-closed: a structural parse error (unterminated quote), a missing/oversize body,
 * or an out-of-range param throws a 400 before ANY write; per-row problems (column-count
 * mismatch, missing eventType, schema rejection) are surfaced per row without sinking the
 * import (parity with the batch's best-effort semantics).
 */
import { OpenwopError } from '../../types.js';
import { collectEventBatch, MAX_COLLECT_BATCH } from './collectService.js';

/** Hard cap on the whole import — bounds per-request work / DB-connection fan-out on top
 *  of the per-batch cap. Oversize is rejected outright (never silently truncated). */
export const MAX_IMPORT_ROWS = 10_000;

export interface CsvRecord {
  /** 1-based source line number of this record's first line (header is line 1). */
  line: number;
  values: string[];
}

export interface ParsedCsv {
  headers: string[];
  records: CsvRecord[];
}

/**
 * Minimal RFC-4180-ish CSV parser — Node stdlib only, no dependency. Supports quoted
 * fields (double-quote), commas and newlines inside quotes, and `""` as an escaped quote.
 * The first non-empty record is the header. Blank lines are skipped. Throws on an
 * unterminated quoted field (a structural error the caller maps to a 400).
 */
export function parseCsv(text: string): ParsedCsv {
  const rows: CsvRecord[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let recordHasContent = false;
  const n = text.length;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    // Drop a fully-empty record (a lone/blank line) — a single empty field with no
    // content seen on the line.
    if (record.length === 1 && record[0] === '' && !recordHasContent) {
      record = [];
      return;
    }
    rows.push({ line: recordStartLine, values: record });
    record = [];
    recordHasContent = false;
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      recordHasContent = true;
      i++;
      continue;
    }
    if (ch === ',') {
      recordHasContent = true;
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      endRecord();
      line++;
      recordStartLine = line;
      i++;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      line++;
      recordStartLine = line;
      i++;
      continue;
    }
    field += ch;
    recordHasContent = true;
    i++;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (recordHasContent || record.length > 0 || field !== '') endRecord();

  const header = rows.shift();
  return { headers: header ? header.values : [], records: rows };
}

export interface ImportOptions {
  /** A fixed event type applied to every row. Mutually exclusive with `eventTypeColumn`. */
  eventType?: string;
  /** A header name whose per-row value is the event type. Mutually exclusive with `eventType`. */
  eventTypeColumn?: string;
  /** Optional header name for in-import dedup — a row whose value was already seen this
   *  import is skipped (collectService has no event dedup, so dedup is scoped to the import). */
  dedupKeyField?: string;
}

export type ImportRowStatus = 'imported' | 'failed' | 'skipped';

export interface ImportRowOutcome {
  line: number;
  status: ImportRowStatus;
  error?: string;
}

export interface ImportResult {
  imported: number;
  failed: number;
  skipped: number;
  rows: ImportRowOutcome[];
}

/**
 * Parse a CSV body → events → the EXISTING `collectEventBatch` path, chunked into
 * ≤100-row batches. Returns an aggregate per-row summary. Tenant-scoped via the
 * composed `collectEventBatch` (never a cross-tenant write).
 */
export async function importCsv(tenantId: string, csv: string, opts: ImportOptions): Promise<ImportResult> {
  const fixedType = (opts.eventType ?? '').trim();
  const typeColumn = (opts.eventTypeColumn ?? '').trim();
  const dedupField = (opts.dedupKeyField ?? '').trim();

  if (fixedType && typeColumn) {
    throw new OpenwopError('validation_error', 'provide only one of eventType or eventTypeColumn.', 400, {});
  }
  if (!fixedType && !typeColumn) {
    throw new OpenwopError('validation_error', 'one of eventType or eventTypeColumn is required.', 400, {});
  }
  if (typeof csv !== 'string' || csv.trim() === '') {
    throw new OpenwopError('validation_error', 'csv body is required.', 400, {});
  }

  let parsed: ParsedCsv;
  try {
    parsed = parseCsv(csv);
  } catch (err) {
    throw new OpenwopError('validation_error', `malformed CSV: ${err instanceof Error ? err.message : String(err)}`, 400, {});
  }

  const { headers, records } = parsed;
  if (headers.length === 0) {
    throw new OpenwopError('validation_error', 'CSV has no header row.', 400, {});
  }
  if (typeColumn && !headers.includes(typeColumn)) {
    throw new OpenwopError('validation_error', `eventTypeColumn "${typeColumn}" is not a CSV header.`, 400, { headers });
  }
  if (dedupField && !headers.includes(dedupField)) {
    throw new OpenwopError('validation_error', `dedupKeyField "${dedupField}" is not a CSV header.`, 400, { headers });
  }
  // Fail-closed on oversize: reject the whole import before any write (never truncate).
  if (records.length > MAX_IMPORT_ROWS) {
    throw new OpenwopError('validation_error', `at most ${MAX_IMPORT_ROWS} rows per import.`, 400, { max: MAX_IMPORT_ROWS, got: records.length });
  }

  const outcomes: ImportRowOutcome[] = [];
  const seen = new Set<string>();
  const toSend: { eventType: string; payload: Record<string, unknown> }[] = [];
  const sendOutcomeIndex: number[] = [];

  for (const rec of records) {
    const line = rec.line;
    if (rec.values.length !== headers.length) {
      outcomes.push({ line, status: 'failed', error: `column count ${rec.values.length} does not match ${headers.length} header column(s)` });
      continue;
    }
    const payload: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      payload[h] = rec.values[idx];
    });

    let eventType = fixedType;
    if (typeColumn) {
      const raw = payload[typeColumn];
      delete payload[typeColumn];
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!v) {
        outcomes.push({ line, status: 'failed', error: `missing eventType in column "${typeColumn}"` });
        continue;
      }
      eventType = v;
    }

    if (dedupField) {
      const keyVal = payload[dedupField];
      const key = typeof keyVal === 'string' ? keyVal : String(keyVal ?? '');
      if (key !== '') {
        if (seen.has(key)) {
          outcomes.push({ line, status: 'skipped' });
          continue;
        }
        seen.add(key);
      }
    }

    sendOutcomeIndex.push(outcomes.length);
    outcomes.push({ line, status: 'failed', error: 'not processed' }); // placeholder, overwritten post-batch
    toSend.push({ eventType, payload });
  }

  // Chunk into ≤100-row batches and RIDE the existing collectEventBatch path.
  for (let s = 0; s < toSend.length; s += MAX_COLLECT_BATCH) {
    const chunk = toSend.slice(s, s + MAX_COLLECT_BATCH);
    const batch = await collectEventBatch(tenantId, chunk);
    for (const r of batch.results) {
      const outcomeIdx = sendOutcomeIndex[s + r.index];
      const line = outcomes[outcomeIdx].line;
      outcomes[outcomeIdx] = r.ok
        ? { line, status: 'imported' }
        : { line, status: 'failed', error: r.error?.message ?? 'ingest failed' };
    }
  }

  let imported = 0;
  let failed = 0;
  let skipped = 0;
  for (const o of outcomes) {
    if (o.status === 'imported') imported++;
    else if (o.status === 'skipped') skipped++;
    else failed++;
  }
  return { imported, failed, skipped, rows: outcomes };
}
