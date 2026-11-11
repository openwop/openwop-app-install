/**
 * ADR 1055 D1 — one closed document schema, three copies that must agree:
 *   1. the schema `documentExtensions()` builds (the engine);
 *   2. the frontend name lists `documentSchemaNames.ts` (what `repairDocumentContent` keeps);
 *   3. the backend lists the server validator refuses against
 *      (`backend/typescript/src/features/document-editor/documentSchemaNames.ts`).
 * A backend test cannot import the frontend engine, so this frontend test PARSES
 * the backend file (the `canvas/__tests__/capParity.test.ts` precedent). Every
 * parser miss throws, so no case can pass on nothing.
 *
 * Why it matters: TipTap opens a whole stored document as blank when one node or
 * mark in it is outside the schema. A type the editor gains but the server does
 * not know is refused on save; a type the server allows but the editor dropped
 * blanks documents again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSchema } from '@tiptap/core';
import { Placeholder } from '@tiptap/extension-placeholder';
import { documentExtensions } from '../documentSchema.js';
import { SlashCommand } from '../slashCommand.js';
import { TrackChanges } from '../trackChanges.js';
import { DOCUMENT_INLINE_TYPES, DOCUMENT_LINK_PROTOCOLS, DOCUMENT_MARK_TYPES, DOCUMENT_NODE_TYPES, DOCUMENT_TEXTBLOCK_TYPES } from '../documentSchemaNames.js';

const BACKEND = readFileSync(join(process.cwd(), '../../backend/typescript/src/features/document-editor/documentSchemaNames.ts'), 'utf8');

/** `export const NAME: readonly string[] = [ 'a', 'b', ];` → ['a','b']. Throws on a miss. */
function backendList(name: string): string[] {
  const m = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`).exec(BACKEND);
  if (!m) throw new Error(`${name} not found in the backend names module — update the parser, not the expectation`);
  const items = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (items.length === 0) throw new Error(`${name} parsed to an empty list`);
  return items;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('document schema parity (ADR 1055 D1)', () => {
  const schema = getSchema(documentExtensions());

  it('the frontend name lists are exactly the nodes and marks the engine builds', () => {
    expect(sorted(DOCUMENT_NODE_TYPES)).toEqual(sorted(Object.keys(schema.nodes)));
    expect(sorted(DOCUMENT_MARK_TYPES)).toEqual(sorted(Object.keys(schema.marks)));
  });

  it('the backend validator refuses against the same lists and link schemes', () => {
    expect(sorted(backendList('DOCUMENT_NODE_TYPES'))).toEqual(sorted(DOCUMENT_NODE_TYPES));
    expect(sorted(backendList('DOCUMENT_MARK_TYPES'))).toEqual(sorted(DOCUMENT_MARK_TYPES));
    expect(sorted(backendList('DOCUMENT_LINK_PROTOCOLS'))).toEqual(sorted(DOCUMENT_LINK_PROTOCOLS));
  });

  it('the nesting lists are the inline and textblock node types the engine builds, on both sides', () => {
    const names = Object.keys(schema.nodes);
    expect(sorted(DOCUMENT_INLINE_TYPES)).toEqual(sorted(names.filter((n) => schema.nodes[n]!.isInline)));
    expect(sorted(DOCUMENT_TEXTBLOCK_TYPES)).toEqual(sorted(names.filter((n) => schema.nodes[n]!.isTextblock)));
    expect(sorted(backendList('DOCUMENT_INLINE_TYPES'))).toEqual(sorted(DOCUMENT_INLINE_TYPES));
    expect(sorted(backendList('DOCUMENT_TEXTBLOCK_TYPES'))).toEqual(sorted(DOCUMENT_TEXTBLOCK_TYPES));
  });

  it('the editor-only extensions add no node or mark the server does not know', () => {
    const withEditorOnly = getSchema([...documentExtensions(), Placeholder, SlashCommand, TrackChanges]);
    expect(sorted(Object.keys(withEditorOnly.nodes))).toEqual(sorted(DOCUMENT_NODE_TYPES));
    expect(sorted(Object.keys(withEditorOnly.marks))).toEqual(sorted(DOCUMENT_MARK_TYPES));
  });
});
