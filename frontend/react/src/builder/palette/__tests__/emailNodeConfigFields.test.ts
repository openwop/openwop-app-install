/**
 * CC-SEO-1 — `core.email.draft` and `core.email.send` are in-tree nodes, so the
 * server catalog carries no configSchema for them and the inspector rendered no
 * fields. The executor (bootstrap/nodes.ts parseEmailConfig) requires `to` and
 * `subject`, so the seo.keyword-brief chain's empty "Save brief" step could not be
 * repaired in the builder. Red before the fix: neither typeId had a static row.
 */
import { describe, it, expect } from 'vitest';
import { NODE_CATALOG } from '../nodeCatalog.js';

describe('CC-SEO-1 — email nodes expose the config their executor requires', () => {
  for (const typeId of ['core.email.draft', 'core.email.send']) {
    it(`${typeId} has editable to / subject / body / format / mailbox fields`, () => {
      const entry = NODE_CATALOG.find((e) => e.typeId === typeId);
      expect(entry, typeId).toBeDefined();
      const byKey = new Map(entry!.configFields.map((f) => [f.key, f]));
      expect([...byKey.keys()]).toEqual(['to', 'subject', 'body', 'bodyFormat', 'connectorId']);
      // `to` must produce an array: the executor treats a single string as ONE address.
      expect(byKey.get('to')?.kind).toBe('string-list');
      // The mailbox values are exactly the connector ids the executor branches on.
      expect(byKey.get('connectorId')?.options?.map((o) => o.value)).toEqual(['microsoft-graph', 'gmail']);
      expect(byKey.get('connectorId')?.defaultValue).toBe('microsoft-graph');
      expect(byKey.get('bodyFormat')?.options?.map((o) => o.value)).toEqual(['Text', 'HTML']);
    });
  }
});
