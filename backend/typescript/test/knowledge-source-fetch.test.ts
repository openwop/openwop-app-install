/**
 * Unit tests for the pure parsers in the ADR 0038 connection-ingest seam
 * (`host/knowledgeSourceFetch.ts`): Drive file-id extraction + mimeType→read-URL
 * planning. No network — the brokered fetch itself is covered by the route test's
 * fail-closed cases.
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
  it('exports a Google Doc / Slides as text/plain', () => {
    const doc = driveReadPlan(ID, 'application/vnd.google-apps.document');
    const slides = driveReadPlan(ID, 'application/vnd.google-apps.presentation');
    expect('url' in doc && doc.url).toContain('/export?mimeType=text%2Fplain');
    expect('url' in slides && slides.url).toContain('/export?mimeType=text%2Fplain');
  });
  it('exports a Google Sheet as text/csv', () => {
    const plan = driveReadPlan(ID, 'application/vnd.google-apps.spreadsheet');
    expect('url' in plan && plan.url).toContain('/export?mimeType=text%2Fcsv');
  });
  it('reads a plain-text / json file via alt=media', () => {
    expect('url' in driveReadPlan(ID, 'text/plain') && driveReadPlan(ID, 'text/plain') as { url: string }).toBeTruthy();
    const plan = driveReadPlan(ID, 'text/markdown');
    expect('url' in plan && plan.url).toContain('alt=media');
  });
  it('rejects a binary type with no extractable text', () => {
    const plan = driveReadPlan(ID, 'image/png');
    expect('unsupported' in plan && plan.unsupported).toBe('image/png');
  });
});
