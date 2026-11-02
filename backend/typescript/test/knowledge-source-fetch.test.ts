/**
 * Unit tests for the pure parsers in the ADR 0038 connection-ingest seam
 * (`host/knowledgeSourceFetch.ts`): Drive file-id extraction + mimeType→read-URL
 * planning. No network — the brokered fetch itself is covered by the route test's
 * fail-closed cases.
 *
 * TST-DKC-1 (grade-tests wave 72). The folder-id case is the Drive-query
 * injection guard (`x' or '1'='1` → null, never a query). Red when (w72 probes):
 * the bare-id charset widens (kf-bare), the folder-URL capture takes the query
 * string (kf-folderpath), the /d/ or ?id= forms stop extracting (kf-dpath,
 * kf-idparam), or a read URL changes (kf-sheet, kf-alldrives, kf-json).
 * `encodeURIComponent(fileId)` is an equivalent mutant for every legal Drive id.
 */

import { describe, expect, it } from 'vitest';
import { extractDriveFileId, extractDriveFolderId, driveReadPlan } from '../src/host/knowledgeSourceFetch.js';

const ID = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

describe('extractDriveFolderId (ADR 0107 — paste a folder link or id)', () => {
  it('extracts the id from a folder URL', () => {
    expect(extractDriveFolderId(`https://drive.google.com/drive/folders/${ID}`)).toBe(ID);
    expect(extractDriveFolderId(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toBe(ID);
  });
  it('extracts from a /drive/u/<n>/folders/<id> URL', () => {
    expect(extractDriveFolderId(`https://drive.google.com/drive/u/0/folders/${ID}`)).toBe(ID);
  });
  it('accepts a bare id (the same charset the list-time guard accepts)', () => {
    expect(extractDriveFolderId(ID)).toBe(ID);
    expect(extractDriveFolderId('Short_Id-1')).toBe('Short_Id-1');
  });
  it('returns null for garbage / an injection attempt (caller maps to 400)', () => {
    expect(extractDriveFolderId('not a folder ref')).toBeNull();      // space ⇒ not a bare id
    expect(extractDriveFolderId("x' or '1'='1")).toBeNull();          // would-be query injection
    expect(extractDriveFolderId('https://example.com/whatever')).toBeNull();
  });
});

describe('extractDriveFileId', () => {
  it('accepts a raw file id', () => {
    expect(extractDriveFileId(ID)).toBe(ID);
  });
  it('extracts from a Docs /d/<id>/edit URL', () => {
    expect(extractDriveFileId(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toBe(ID);
  });
  it('extracts from a Drive file /d/<id>/view URL', () => {
    expect(extractDriveFileId(`https://drive.google.com/file/d/${ID}/view`)).toBe(ID);
  });
  it('extracts from an open?id=<id> URL', () => {
    expect(extractDriveFileId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
  });
  it('returns null for a non-Drive ref', () => {
    expect(extractDriveFileId('https://example.com/not-a-drive-doc')).toBeNull();
    expect(extractDriveFileId('hello world')).toBeNull();
  });
});

describe('driveReadPlan', () => {
  // Exact URLs, as literals: the base path, the export-vs-media choice and the
  // shared-drive flag are all part of the read (a substring check passed a
  // `supportsAllDrives=false` — w72 probe kf-alldrives).
  const FILE = `https://www.googleapis.com/drive/v3/files/${ID}`;
  it('exports a Google Doc / Slides as text/plain', () => {
    expect(driveReadPlan(ID, 'application/vnd.google-apps.document')).toEqual({ url: `${FILE}/export?mimeType=text%2Fplain&supportsAllDrives=true` });
    expect(driveReadPlan(ID, 'application/vnd.google-apps.presentation')).toEqual({ url: `${FILE}/export?mimeType=text%2Fplain&supportsAllDrives=true` });
  });
  it('exports a Google Sheet as text/csv', () => {
    expect(driveReadPlan(ID, 'application/vnd.google-apps.spreadsheet')).toEqual({ url: `${FILE}/export?mimeType=text%2Fcsv&supportsAllDrives=true` });
  });
  it('reads a plain-text / json file via alt=media', () => {
    for (const mime of ['text/plain', 'text/markdown', 'application/json']) {
      expect(driveReadPlan(ID, mime), mime).toEqual({ url: `${FILE}?alt=media&supportsAllDrives=true` });
    }
  });
  it('rejects a binary type with no extractable text', () => {
    expect(driveReadPlan(ID, 'image/png')).toEqual({ unsupported: 'image/png' });
  });
});
